import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as glue from 'aws-cdk-lib/aws-glue'
import * as athena from 'aws-cdk-lib/aws-athena'

const USER_COLUMNS: glue.CfnTable.ColumnProperty[] = [
  { name: 'user_id', type: 'string' },
  { name: 'user_email', type: 'string' },
  { name: 'chat_conversations', type: 'bigint' },
  { name: 'chat_messages', type: 'bigint' },
  { name: 'chat_thinking_messages', type: 'bigint' },
  { name: 'chat_files_uploaded', type: 'bigint' },
  { name: 'chat_artifacts', type: 'bigint' },
  { name: 'chat_skills', type: 'bigint' },
  { name: 'chat_connectors', type: 'bigint' },
  { name: 'cc_sessions', type: 'bigint' },
  { name: 'lines_of_code_added', type: 'bigint' },
  { name: 'lines_of_code_removed', type: 'bigint' },
  { name: 'commits_by_claude_code', type: 'bigint' },
  { name: 'prs_by_claude_code', type: 'bigint' },
  { name: 'edit_tool_accepted', type: 'bigint' },
  { name: 'edit_tool_rejected', type: 'bigint' },
  { name: 'multi_edit_tool_accepted', type: 'bigint' },
  { name: 'multi_edit_tool_rejected', type: 'bigint' },
  { name: 'write_tool_accepted', type: 'bigint' },
  { name: 'write_tool_rejected', type: 'bigint' },
  { name: 'notebook_edit_tool_accepted', type: 'bigint' },
  { name: 'notebook_edit_tool_rejected', type: 'bigint' },
  { name: 'web_search_count', type: 'bigint' },
  { name: 'cowork_sessions', type: 'bigint' },
  { name: 'cowork_messages', type: 'bigint' },
  { name: 'cowork_actions', type: 'bigint' },
  { name: 'cowork_dispatch_turns', type: 'bigint' },
  { name: 'office_excel_sessions', type: 'bigint' },
  { name: 'office_excel_messages', type: 'bigint' },
  { name: 'office_excel_skills_used', type: 'bigint' },
  { name: 'office_excel_distinct_skills', type: 'bigint' },
  { name: 'office_excel_connectors_used', type: 'bigint' },
  { name: 'office_excel_distinct_connectors', type: 'bigint' },
  { name: 'office_powerpoint_sessions', type: 'bigint' },
  { name: 'office_powerpoint_messages', type: 'bigint' },
  { name: 'office_powerpoint_skills_used', type: 'bigint' },
  { name: 'office_powerpoint_distinct_skills', type: 'bigint' },
  { name: 'office_powerpoint_connectors_used', type: 'bigint' },
  { name: 'office_powerpoint_distinct_connectors', type: 'bigint' },
  { name: 'office_word_sessions', type: 'bigint' },
  { name: 'office_word_messages', type: 'bigint' },
  { name: 'office_word_skills_used', type: 'bigint' },
  { name: 'office_word_distinct_skills', type: 'bigint' },
  { name: 'office_word_connectors_used', type: 'bigint' },
  { name: 'office_word_distinct_connectors', type: 'bigint' },
  { name: 'office_outlook_sessions', type: 'bigint' },
  { name: 'office_outlook_messages', type: 'bigint' },
  { name: 'office_outlook_skills_used', type: 'bigint' },
  { name: 'office_outlook_distinct_skills', type: 'bigint' },
  { name: 'office_outlook_connectors_used', type: 'bigint' },
  { name: 'office_outlook_distinct_connectors', type: 'bigint' },
  { name: 'cowork_file_edit_count', type: 'bigint' },
  { name: 'cowork_skills_used', type: 'bigint' },
  { name: 'cowork_distinct_skills', type: 'bigint' },
  { name: 'science_skills_used', type: 'bigint' },
  { name: 'cowork_edit_tool_count', type: 'bigint' },
  { name: 'cowork_multi_edit_tool_count', type: 'bigint' },
  { name: 'cowork_write_tool_count', type: 'bigint' },
  { name: 'cowork_notebook_edit_tool_count', type: 'bigint' },
  { name: 'cowork_sessions_with_file_edits_count', type: 'bigint' },
  { name: 'design_sessions', type: 'bigint' },
  { name: 'design_projects_used', type: 'bigint' },
  { name: 'design_projects_created', type: 'bigint' },
  { name: 'design_messages', type: 'bigint' },
  // v2.2 additions (additive-only — existing names/order untouched; JsonSerDe
  // reads absent keys as NULL, so pre-addition partitions stay queryable and
  // null keeps its feature-flag meaning: org not enabled ≠ 0 activity).
  { name: 'cowork_plugins_used', type: 'bigint' },
  { name: 'cowork_distinct_plugins', type: 'bigint' },
  { name: 'cowork_artifacts_created', type: 'bigint' },
  { name: 'last_activity_date', type: 'string' },
  { name: 'snapshot_date', type: 'string' },
]

const SUMMARY_COLUMNS: glue.CfnTable.ColumnProperty[] = [
  { name: 'date', type: 'string' },
  { name: 'daily_active_user_count', type: 'bigint' },
  { name: 'weekly_active_user_count', type: 'bigint' },
  { name: 'monthly_active_user_count', type: 'bigint' },
  { name: 'assigned_seat_count', type: 'bigint' },
  { name: 'pending_invite_count', type: 'bigint' },
  { name: 'cowork_daily_active_user_count', type: 'bigint' },
  { name: 'cowork_weekly_active_user_count', type: 'bigint' },
  { name: 'cowork_monthly_active_user_count', type: 'bigint' },
]

const SKILL_COLUMNS: glue.CfnTable.ColumnProperty[] = [
  { name: 'skill_name', type: 'string' },
  { name: 'distinct_users', type: 'bigint' },
  { name: 'chat_uses', type: 'bigint' },
  { name: 'claude_code_uses', type: 'bigint' },
  { name: 'cowork_uses', type: 'bigint' },
  { name: 'snapshot_date', type: 'string' },
]

const CONNECTOR_COLUMNS = SKILL_COLUMNS.map((c) =>
  c.name === 'skill_name' ? { ...c, name: 'connector_name' } : c)

// Plugin usage (analytics/plugins — sixth collector endpoint, v2.2).
// plugin_id is nullable (third-party CC plugins / hash-id Cowork commands).
const PLUGIN_COLUMNS: glue.CfnTable.ColumnProperty[] = [
  { name: 'plugin_name', type: 'string' },
  { name: 'plugin_id', type: 'string' },
  { name: 'distinct_users', type: 'bigint' },
  { name: 'install_count', type: 'bigint' },
  { name: 'invocation_count', type: 'bigint' },
  { name: 'claude_code_uses', type: 'bigint' },
  { name: 'cowork_uses', type: 'bigint' },
  { name: 'snapshot_date', type: 'string' },
]

const PROJECT_COLUMNS: glue.CfnTable.ColumnProperty[] = [
  { name: 'project_id', type: 'string' },
  { name: 'project_name', type: 'string' },
  { name: 'distinct_user_count', type: 'bigint' },
  { name: 'distinct_conversation_count', type: 'bigint' },
  { name: 'message_count', type: 'bigint' },
  { name: 'created_at', type: 'string' },
  { name: 'created_by_id', type: 'string' },
  { name: 'created_by_email', type: 'string' },
  { name: 'snapshot_date', type: 'string' },
]

// Compliance audit events: stable envelope columns + the full original
// record as a JSON string (`payload`) — event fields are dynamic per type,
// so type-specific values are reached via json_extract(payload, '$.field')
// instead of schema migrations. Partition day = created_at day.
const COMPLIANCE_COLUMNS: glue.CfnTable.ColumnProperty[] = [
  { name: 'id', type: 'string' },
  { name: 'type', type: 'string' },
  { name: 'created_at', type: 'string' },
  { name: 'actor_type', type: 'string' },
  { name: 'actor_email', type: 'string' },
  { name: 'actor_user_id', type: 'string' },
  { name: 'actor_api_key_id', type: 'string' },
  { name: 'actor_ip_address', type: 'string' },
  { name: 'actor_user_agent', type: 'string' },
  { name: 'organization_id', type: 'string' },
  { name: 'payload', type: 'string' },
]

export class StorageStack extends cdk.Stack {
  readonly archiveBucket: s3.Bucket
  readonly athenaWorkGroup: athena.CfnWorkGroup

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    this.archiveBucket = new s3.Bucket(this, 'Archive', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: cdk.Duration.days(3) },
        {
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(60) },
            { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: cdk.Duration.days(365) },
          ],
        },
      ],
    })

    const db = new glue.CfnDatabase(this, 'GlueDb', {
      catalogId: cdk.Stack.of(this).account,
      databaseInput: { name: 'claude_code_analytics' },
    })

    const table = (name: string, columns: glue.CfnTable.ColumnProperty[], prefix: string) =>
      new glue.CfnTable(this, `Tbl${name}`, {
        catalogId: cdk.Stack.of(this).account,
        databaseName: 'claude_code_analytics',
        tableInput: {
          name,
          tableType: 'EXTERNAL_TABLE',
          parameters: {
            'classification': 'json',
            'projection.enabled': 'true',
            'projection.date.type': 'date',
            'projection.date.range': '2026-01-01,NOW',
            'projection.date.format': 'yyyy-MM-dd',
            'projection.date.interval': '1',
            'projection.date.interval.unit': 'DAYS',
            'storage.location.template':
              `s3://${this.archiveBucket.bucketName}/${prefix}/date=\${date}/`,
          },
          partitionKeys: [{ name: 'date', type: 'string' }],
          storageDescriptor: {
            columns,
            location: `s3://${this.archiveBucket.bucketName}/${prefix}/`,
            inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
            outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
            serdeInfo: {
              serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
              parameters: { 'ignore.malformed.json': 'true' },
            },
          },
        },
      }).addDependency(db)

    table('claude_code_analytics', USER_COLUMNS, 'users')
    table('summaries_daily', SUMMARY_COLUMNS, 'summaries')
    table('skills_daily', SKILL_COLUMNS, 'skills')
    table('connectors_daily', CONNECTOR_COLUMNS, 'connectors')
    table('projects_daily', PROJECT_COLUMNS, 'projects')
    table('plugins_daily', PLUGIN_COLUMNS, 'plugins')
    table('compliance_daily', COMPLIANCE_COLUMNS, 'compliance')

    // Org2 mirrors (multi-org contract 2026-07-21): identical column sets and
    // partition projection, data written by the collector under the org2/
    // S3 prefix. Purely additive — the primary tables above are untouched.
    table('claude_code_analytics_org2', USER_COLUMNS, 'org2/users')
    table('summaries_daily_org2', SUMMARY_COLUMNS, 'org2/summaries')
    table('skills_daily_org2', SKILL_COLUMNS, 'org2/skills')
    table('connectors_daily_org2', CONNECTOR_COLUMNS, 'org2/connectors')
    table('projects_daily_org2', PROJECT_COLUMNS, 'org2/projects')
    table('plugins_daily_org2', PLUGIN_COLUMNS, 'org2/plugins')
    table('compliance_daily_org2', COMPLIANCE_COLUMNS, 'org2/compliance')

    this.athenaWorkGroup = new athena.CfnWorkGroup(this, 'Wg', {
      name: 'claude-code-dashboard',
      state: 'ENABLED',
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        resultConfiguration: {
          outputLocation: `s3://${this.archiveBucket.bucketName}/athena-results/`,
          encryptionConfiguration: { encryptionOption: 'SSE_S3' },
        },
      },
    })

    new cdk.CfnOutput(this, 'ArchiveBucket', { value: this.archiveBucket.bucketName })
    new cdk.CfnOutput(this, 'GlueDatabase', { value: 'claude_code_analytics' })
    new cdk.CfnOutput(this, 'AthenaWorkgroup', { value: this.athenaWorkGroup.name! })
  }
}
