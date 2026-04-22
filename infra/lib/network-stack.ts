import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'

interface Props extends cdk.StackProps {
  /**
   * If provided, reuse an existing VPC instead of creating a new one.
   * Pass via CDK context:  `cdk deploy --context existingVpcId=vpc-xxx`
   *
   * The existing VPC must have private subnets with NAT egress; CDK will
   * discover them via `Vpc.fromLookup`.
   */
  existingVpcId?: string
}

export class NetworkStack extends cdk.Stack {
  readonly vpc: ec2.IVpc
  readonly mode: 'existing' | 'new'

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props)

    if (props.existingVpcId) {
      this.vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.existingVpcId })
      this.mode = 'existing'
      new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId })
      new cdk.CfnOutput(this, 'VpcMode', { value: 'existing' })
    } else {
      // Greenfield: 2 AZ, 1 NAT, public + private-with-egress
      const vpc = new ec2.Vpc(this, 'Vpc', {
        maxAzs: 2,
        natGateways: 1,
        subnetConfiguration: [
          { name: 'public',  subnetType: ec2.SubnetType.PUBLIC,                cidrMask: 24 },
          { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,   cidrMask: 22 },
        ],
      })
      vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 })
      this.vpc = vpc
      this.mode = 'new'
      new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId })
      new cdk.CfnOutput(this, 'VpcMode', { value: 'new' })
    }
  }
}
