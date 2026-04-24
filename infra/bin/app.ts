#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { NetworkStack } from '../lib/network-stack'
import { StorageStack } from '../lib/storage-stack'
import { ComputeStack } from '../lib/compute-stack'
import { CollectorStack } from '../lib/collector-stack'

const app = new cdk.App()
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'ap-northeast-2',
}
const prefix = app.node.tryGetContext('namePrefix') || 'ccd'

// Optional: reuse an existing VPC. Pass via context:
//   cdk deploy --context existingVpcId=vpc-0dfa5610180dfa628 --all
// If absent, a new VPC (2 AZ, 1 NAT) is created.
const existingVpcId = app.node.tryGetContext('existingVpcId') as string | undefined

const network = new NetworkStack(app, `${prefix}-network`, { env, existingVpcId })
const storage = new StorageStack(app, `${prefix}-storage`, { env })
// Region-specific AWS-managed prefix list for CloudFront origin-facing.
// ap-northeast-2 = pl-22a6434b. Override via context `--context cloudfrontPrefixListId=pl-xxxxx`.
const CF_PREFIX_LIST_BY_REGION: Record<string, string> = {
  'ap-northeast-2': 'pl-22a6434b',
  'us-east-1':      'pl-3b927c52',
  'us-west-2':      'pl-82a045eb',
  'eu-west-1':      'pl-4fa04526',
  'eu-central-1':   'pl-a3a144ca',
  'ap-southeast-1': 'pl-31a34658',
}
const cloudfrontPrefixListId =
  (app.node.tryGetContext('cloudfrontPrefixListId') as string | undefined) ||
  CF_PREFIX_LIST_BY_REGION[env.region!]

const compute = new ComputeStack(app, `${prefix}-compute`, {
  env,
  // Lambda@Edge functions live in us-east-1; this flag tells CDK to bridge
  // their version ARNs back into this (ap-northeast-2) stack via SSM.
  crossRegionReferences: true,
  vpc: network.vpc,
  archiveBucket: storage.archiveBucket,
  athenaWorkGroup: storage.athenaWorkGroup,
  analyticsSecretName:  `${prefix}/analytics-key`,
  adminSecretName:      `${prefix}/admin-key`,
  complianceSecretName: `${prefix}/compliance-key`,
  // Global cross-region inference profile for Claude Sonnet 4.6 — available in ap-northeast-2.
  bedrockModelId: 'global.anthropic.claude-sonnet-4-6',
  cloudfrontPrefixListId,
})
const collector = new CollectorStack(app, `${prefix}-collector`, {
  env,
  archiveBucket: storage.archiveBucket,
  analyticsSecretName: `${prefix}/analytics-key`,
})

cdk.Tags.of(app).add('project', 'claude-code-dashboard')
void compute; void collector
