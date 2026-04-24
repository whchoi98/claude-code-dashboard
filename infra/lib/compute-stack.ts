import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as cf from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as wafv2 from 'aws-cdk-lib/aws-wafv2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as secrets from 'aws-cdk-lib/aws-secretsmanager'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as athena from 'aws-cdk-lib/aws-athena'
import * as path from 'path'
import * as fs from 'fs'

interface Props extends cdk.StackProps {
  vpc: ec2.IVpc
  archiveBucket: s3.IBucket
  athenaWorkGroup: athena.CfnWorkGroup
  analyticsSecretName: string
  /**
   * Optional Admin API key secret (sk-ant-admin01-...) for Usage & Cost and
   * Claude Code Admin Analytics endpoints. When set, the Cost page is enabled.
   */
  adminSecretName?: string
  /**
   * Optional Compliance API key secret (sk-ant-api01-... with Compliance scope)
   * for /v1/compliance/* audit endpoints. When set, the Audit page is enabled.
   */
  complianceSecretName?: string
  bedrockModelId: string
  /**
   * AWS-managed prefix list for `com.amazonaws.global.cloudfront.origin-facing`.
   * When provided, the ALB SG is restricted to CloudFront IPs only — traffic that
   * skips CloudFront (hits the ALB DNS directly) is blocked.
   *
   * ap-northeast-2: pl-22a6434b   us-east-1: pl-3b927c52   eu-west-1: pl-4fa04526
   * Look up with:
   *   aws ec2 describe-managed-prefix-lists \
   *     --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing
   */
  cloudfrontPrefixListId?: string
}

export class ComputeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props)

    const analyticsSecret = new secrets.Secret(this, 'AnalyticsSecret', {
      secretName: props.analyticsSecretName,
      description: 'Claude Enterprise Analytics API key (sk-ant-api01-...)',
    })

    const adminSecret = props.adminSecretName
      ? secrets.Secret.fromSecretNameV2(this, 'AdminSecret', props.adminSecretName)
      : undefined
    const complianceSecret = props.complianceSecretName
      ? secrets.Secret.fromSecretNameV2(this, 'ComplianceSecret', props.complianceSecretName)
      : undefined

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      containerInsights: true,
    })

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    const image = new ecr_assets.DockerImageAsset(this, 'Image', {
      directory: path.join(__dirname, '../../'),
      platform: ecr_assets.Platform.LINUX_ARM64, // Matches Fargate ARM64 runtime
    })

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    })
    const container = taskDef.addContainer('app', {
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'app', logGroup }),
      environment: {
        AWS_REGION: cdk.Stack.of(this).region,
        BEDROCK_MODEL_ID: props.bedrockModelId,
        ARCHIVE_S3_BUCKET: props.archiveBucket.bucketName,
        ATHENA_WORKGROUP: props.athenaWorkGroup.name!,
        ATHENA_DATABASE: 'claude_code_analytics',
        ATHENA_OUTPUT_LOCATION: `s3://${props.archiveBucket.bucketName}/athena-results/`,
        NODE_ENV: 'production',
        PORT: '8080',
      },
      secrets: {
        ANTHROPIC_ANALYTICS_KEY: ecs.Secret.fromSecretsManager(analyticsSecret),
        ...(adminSecret
          ? { ANTHROPIC_ADMIN_KEY_ADMIN: ecs.Secret.fromSecretsManager(adminSecret) }
          : {}),
        ...(complianceSecret
          ? { ANTHROPIC_COMPLIANCE_KEY: ecs.Secret.fromSecretsManager(complianceSecret) }
          : {}),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "fetch(\'http://localhost:8080/api/health\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    })
    container.addPortMappings({ containerPort: 8080 })

    // IAM: Bedrock (foundation models + inference profiles), Athena (workgroup), Glue (catalog), S3 (bucket).
    const account = cdk.Stack.of(this).account
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        // Foundation models (any region, all Anthropic)
        `arn:aws:bedrock:*::foundation-model/anthropic.*`,
        // Cross-region inference profiles (global / apac / us / eu)
        `arn:aws:bedrock:*:${account}:inference-profile/global.anthropic.*`,
        `arn:aws:bedrock:*:${account}:inference-profile/apac.anthropic.*`,
        `arn:aws:bedrock:*:${account}:inference-profile/us.anthropic.*`,
        `arn:aws:bedrock:*:${account}:inference-profile/eu.anthropic.*`,
      ],
    }))
    props.archiveBucket.grantReadWrite(taskDef.taskRole)
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'athena:StartQueryExecution', 'athena:GetQueryExecution',
        'athena:GetQueryResults', 'athena:StopQueryExecution',
      ],
      resources: [
        `arn:aws:athena:${cdk.Stack.of(this).region}:${account}:workgroup/${props.athenaWorkGroup.name}`,
      ],
    }))
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['glue:GetTable', 'glue:GetTables', 'glue:GetDatabase', 'glue:GetPartitions'],
      resources: ['*'],
    }))

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(90),
    })
    service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 6 }).scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: 60,
    })

    // Public ALB in front of the service.
    // Security Group is created empty (open: false on the listener); we add the
    // CloudFront prefix list rule below so only CloudFront can reach the ALB.
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
    })

    if (props.cloudfrontPrefixListId) {
      alb.connections.allowFrom(
        ec2.Peer.prefixList(props.cloudfrontPrefixListId),
        ec2.Port.tcp(80),
        'CloudFront origin-facing prefix list only',
      )
    } else {
      // Fallback: unrestricted (dev/staging only). Warn via stack annotation.
      alb.connections.allowFromAnyIpv4(ec2.Port.tcp(80), 'Unrestricted HTTP (no CF prefix list set)')
      cdk.Annotations.of(this).addWarning(
        'ALB is open to 0.0.0.0/0 because `cloudfrontPrefixListId` was not supplied. ' +
        'Supply the managed prefix list for CloudFront origin-facing to lock ALB to CloudFront traffic only.',
      )
    }

    const listener = alb.addListener('Http', { port: 80, open: false })
    listener.addTargets('Svc', {
      port: 8080,
      targets: [service.loadBalancerTarget({ containerName: 'app', containerPort: 8080 })],
      healthCheck: {
        path: '/api/health',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    })

    // Regional WAF on the ALB (same region as ALB; no cross-region needed)
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true, metricName: 'ccdWaf', sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWSManagedCommon', priority: 1, overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'common', sampledRequestsEnabled: true },
        },
        {
          name: 'AWSManagedKnownBadInputs', priority: 2, overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesKnownBadInputsRuleSet' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'knownBad', sampledRequestsEnabled: true },
        },
        {
          name: 'RateLimit', priority: 3, action: { block: {} },
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'rate', sampledRequestsEnabled: true },
        },
      ],
    })
    new wafv2.CfnWebACLAssociation(this, 'WebAclAssoc', {
      resourceArn: alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    })

    // ─── Lambda@Edge: Cognito authentication ─────────────────────────────
    // 4 viewer-request functions packaged from `infra/edge/dist/` — produced
    // by `npm run build:edge` which injects the Cognito client secret from
    // Secrets Manager into `_shared.js`. `dist/` is gitignored; the source
    // handlers + template live one directory up and are committed.
    const edgeDistDir = path.join(__dirname, '../edge/dist')
    const sharedPath = path.join(edgeDistDir, '_shared.js')
    if (!fs.existsSync(sharedPath)) {
      throw new Error(
        `[ComputeStack] ${sharedPath} is missing. Run \`npm run build:edge\` from the repo root before \`cdk synth\`/\`cdk deploy\` ` +
        `— it reads ccd/cognito-config from Secrets Manager and generates the dist/ bundle.`,
      )
    }
    const edgeCode = lambda.Code.fromAsset(edgeDistDir)

    const mkEdgeFn = (id: string, handler: string) =>
      new cf.experimental.EdgeFunction(this, id, {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler,
        code: edgeCode,
        memorySize: 128,
        timeout: cdk.Duration.seconds(5),
      })

    const checkAuth   = mkEdgeFn('CheckAuthEdgeFn',   'check-auth.handler')
    const parseAuth   = mkEdgeFn('ParseAuthEdgeFn',   'parse-auth.handler')
    const refreshAuth = mkEdgeFn('RefreshAuthEdgeFn', 'refresh-auth.handler')
    const signOut     = mkEdgeFn('SignOutEdgeFn',     'sign-out.handler')

    const asVR = (fn: cf.experimental.EdgeFunction) => ({
      edgeLambdas: [{
        functionVersion: fn.currentVersion,
        eventType: cf.LambdaEdgeEventType.VIEWER_REQUEST,
      }],
    })

    const albOrigin = new origins.LoadBalancerV2Origin(alb, {
      protocolPolicy: cf.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
    })
    const baseBehavior: cf.BehaviorOptions = {
      origin: albOrigin,
      viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cf.AllowedMethods.ALLOW_ALL,
      cachePolicy: cf.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER,
      responseHeadersPolicy: cf.ResponseHeadersPolicy.SECURITY_HEADERS,
    }

    // CloudFront in front of the ALB — TLS termination + security headers + HTTP/3.
    // Default behavior runs check-auth (redirects unauth'd users to Cognito).
    // /parseauth, /refreshauth, /signout run their respective handlers which
    // return 302s directly — the origin is never actually hit for those paths.
    const distribution = new cf.Distribution(this, 'Cdn', {
      defaultBehavior: { ...baseBehavior, ...asVR(checkAuth) },
      additionalBehaviors: {
        '/parseauth':   { ...baseBehavior, ...asVR(parseAuth) },
        '/refreshauth': { ...baseBehavior, ...asVR(refreshAuth) },
        '/signout':     { ...baseBehavior, ...asVR(signOut) },
      },
      minimumProtocolVersion: cf.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cf.HttpVersion.HTTP2_AND_3,
      comment: 'Claude Code Dashboard',
    })

    new cdk.CfnOutput(this, 'AlbDns', { value: alb.loadBalancerDnsName })
    new cdk.CfnOutput(this, 'DashboardUrl', { value: `https://${distribution.domainName}` })
    new cdk.CfnOutput(this, 'AnalyticsSecretArn', { value: analyticsSecret.secretArn })
    new cdk.CfnOutput(this, 'AnalyticsSecretName', { value: analyticsSecret.secretName })
  }
}
