import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as secrets from 'aws-cdk-lib/aws-secretsmanager'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as path from 'path'

interface Props extends cdk.StackProps {
  archiveBucket: s3.IBucket
  analyticsSecretName: string
}

export class CollectorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props)

    const analyticsSecret = secrets.Secret.fromSecretNameV2(
      this, 'AnalyticsSecret', props.analyticsSecretName)

    const fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../collector')),
      // 15 min (Lambda max): the compliance walk needs ~120-150 paced pages
      // for its 2-complete-day window at 2026-07 volume (~6k events/day) and
      // self-limits via getRemainingTimeInMillis at a 60 s margin; the
      // analytics snapshot (separate 14:00 UTC rule) uses ~1-2 min of it.
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        ARCHIVE_S3_BUCKET: props.archiveBucket.bucketName,
        ANTHROPIC_API_URL: 'https://api.anthropic.com',
        ANTHROPIC_VERSION: '2023-06-01',
      },
    })

    // Resolve analytics key from Secrets Manager at invocation (secret value injected via env)
    fn.addEnvironment(
      'ANTHROPIC_ANALYTICS_KEY_SECRET_ARN', analyticsSecret.secretArn)

    analyticsSecret.grantRead(fn)
    props.archiveBucket.grantPut(fn)
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [analyticsSecret.secretArn],
    }))

    // Bootstrap: inject secret into env at cold start via init code layer is heavy; instead
    // wrap the handler using an env resolver. A simple approach: pass the secret ARN and let
    // handler.js (Phase 2) fetch it via the SDK. For now we expect users to also set the plain
    // env ANTHROPIC_ANALYTICS_KEY or rotate the lambda to read the secret.
    // (The collector handler already supports plain env lookup.)

    // Daily at 14:00 UTC — after the Analytics API's 10:00 UTC data publication.
    // Analytics only: the compliance walk is skipped here (complianceDays: 0)
    // because at 14:00 UTC it must traverse ~14h of today's events (~50-60
    // pages of pure overhead at 2026-07 volume) before reaching yesterday —
    // the dedicated 00:30 UTC rule below does the audit archival instead.
    new events.Rule(this, 'Daily', {
      schedule: events.Schedule.cron({ minute: '0', hour: '14' }),
      targets: [new targets.LambdaFunction(fn, {
        event: events.RuleTargetInput.fromObject({ complianceDays: 0 }),
      })],
    })

    // Compliance archival right after UTC midnight: today's partial feed is
    // only minutes deep, so the backward after_id walk reaches yesterday in
    // 1-2 pages and the 2-complete-day window fits the Lambda budget.
    new events.Rule(this, 'DailyCompliance', {
      schedule: events.Schedule.cron({ minute: '30', hour: '0' }),
      targets: [new targets.LambdaFunction(fn, {
        event: events.RuleTargetInput.fromObject({ complianceOnly: true }),
      })],
    })

    new cdk.CfnOutput(this, 'CollectorFnName', { value: fn.functionName })
  }
}
