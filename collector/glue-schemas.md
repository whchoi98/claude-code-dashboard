# Glue Data Catalog schemas

All tables are **partitioned by `date` (string)**, stored as NDJSON under
`s3://$BUCKET/<table>/date=YYYY-MM-DD/`, and registered by the CDK
`StorageStack`. Schemas mirror the flattened output of `collector/handler.js`.

## `claude_code_analytics` (daily per-user)

| Column                       | Type    |
|------------------------------|---------|
| user_id                      | string  |
| user_email                   | string  |
| chat_conversations           | bigint  |
| chat_messages                | bigint  |
| chat_thinking_messages       | bigint  |
| chat_files_uploaded          | bigint  |
| chat_artifacts               | bigint  |
| chat_skills                  | bigint  |
| chat_connectors              | bigint  |
| cc_sessions                  | bigint  |
| lines_of_code_added          | bigint  |
| lines_of_code_removed        | bigint  |
| commits_by_claude_code       | bigint  |
| prs_by_claude_code           | bigint  |
| edit_tool_accepted           | bigint  |
| edit_tool_rejected           | bigint  |
| multi_edit_tool_accepted     | bigint  |
| multi_edit_tool_rejected     | bigint  |
| write_tool_accepted          | bigint  |
| write_tool_rejected          | bigint  |
| notebook_edit_tool_accepted  | bigint  |
| notebook_edit_tool_rejected  | bigint  |
| web_search_count             | bigint  |
| cowork_sessions              | bigint  |
| cowork_messages              | bigint  |
| cowork_actions               | bigint  |
| cowork_dispatch_turns        | bigint  |
| snapshot_date                | string  |

Partition: `date` (string, YYYY-MM-DD)

## `summaries_daily` (org-wide daily)

| Column                              | Type   |
|-------------------------------------|--------|
| date                                | string |
| daily_active_user_count             | bigint |
| weekly_active_user_count            | bigint |
| monthly_active_user_count           | bigint |
| assigned_seat_count                 | bigint |
| pending_invite_count                | bigint |
| cowork_daily_active_user_count      | bigint |
| cowork_weekly_active_user_count     | bigint |
| cowork_monthly_active_user_count    | bigint |

## `skills_daily`, `connectors_daily`

See `flattenSkill` and `flattenConnector` in `handler.js`.
