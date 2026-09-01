# Glue Data Catalog schemas

All tables are **partitioned by `date` (string)**, stored as NDJSON under
`s3://$BUCKET/<table>/date=YYYY-MM-DD/`, and registered by the CDK
`StorageStack`. Schemas mirror the flattened output of `collector/flatten.js`.

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
| office_excel_sessions               | bigint  |
| office_excel_messages               | bigint  |
| office_excel_skills_used            | bigint  |
| office_excel_distinct_skills        | bigint  |
| office_excel_connectors_used        | bigint  |
| office_excel_distinct_connectors    | bigint  |
| office_powerpoint_sessions          | bigint  |
| office_powerpoint_messages          | bigint  |
| office_powerpoint_skills_used       | bigint  |
| office_powerpoint_distinct_skills   | bigint  |
| office_powerpoint_connectors_used   | bigint  |
| office_powerpoint_distinct_connectors | bigint |
| office_word_sessions                | bigint  |
| office_word_messages                | bigint  |
| office_word_skills_used             | bigint  |
| office_word_distinct_skills         | bigint  |
| office_word_connectors_used         | bigint  |
| office_word_distinct_connectors     | bigint  |
| office_outlook_sessions             | bigint  |
| office_outlook_messages             | bigint  |
| office_outlook_skills_used          | bigint  |
| office_outlook_distinct_skills      | bigint  |
| office_outlook_connectors_used      | bigint  |
| office_outlook_distinct_connectors  | bigint  |
| cowork_file_edit_count              | bigint  |
| cowork_skills_used                  | bigint  |
| cowork_distinct_skills              | bigint  |
| science_skills_used                 | bigint  |
| cowork_edit_tool_count              | bigint  |
| cowork_multi_edit_tool_count        | bigint  |
| cowork_write_tool_count             | bigint  |
| cowork_notebook_edit_tool_count     | bigint  |
| cowork_sessions_with_file_edits_count | bigint |
| design_sessions                     | bigint  |
| design_projects_used                | bigint  |
| design_projects_created             | bigint  |
| design_messages                     | bigint  |
| cowork_plugins_used                 | bigint  |
| cowork_distinct_plugins             | bigint  |
| cowork_artifacts_created            | bigint  |
| last_activity_date                  | string  |
| snapshot_date                | string  |

Partition: `date` (string, YYYY-MM-DD)

The last four data columns are v2.2 additions (2026-08). They are NULL on
partitions written before the raw-sidecar re-flatten backfill
(`_local/reflatten-users-from-raw.mjs`) reaches them — NULL means "not
collected / feature not enabled", never zero activity. `last_activity_date`
is the user's ABSOLUTE last active day (YYYY-MM-DD), independent of the
snapshot window — the dormant-seat signal.

## `projects_daily` (daily per chat project)

| Column                      | Type   |
|-----------------------------|--------|
| project_id                  | string |
| project_name                | string |
| distinct_user_count         | bigint |
| distinct_conversation_count | bigint |
| message_count               | bigint |
| created_at                  | string |
| created_by_id               | string |
| created_by_email            | string |
| snapshot_date               | string |

Partition: `date` (string, YYYY-MM-DD). Flattened by `flattenProject` in `flatten.js`.

## `plugins_daily` (daily per plugin — since 2026-08, v2.2)

| Column            | Type   |
|-------------------|--------|
| plugin_name       | string |
| plugin_id         | string |
| distinct_users    | bigint |
| install_count     | bigint |
| invocation_count  | bigint |
| claude_code_uses  | bigint |
| cowork_uses       | bigint |
| snapshot_date     | string |

Partition: `date` (string, YYYY-MM-DD). Flattened by `flattenPlugin` in
`flatten.js`. `plugin_id` is nullable (third-party Claude Code plugins and
hash-id Cowork commands ship without one). `install_count` is a STOCK
(install base as of the snapshot day — aggregate with MAX across days);
`invocation_count` and the `*_uses` session counts are flows (SUM).
No partitions exist before the v2.2 collector deploy — the plugins endpoint
was never snapshotted earlier and has no raw sidecar to backfill from.

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

See `flattenSkill` and `flattenConnector` in `flatten.js`.

## `compliance_daily`

Audit events, one row per event; partition day = event `created_at` day
(event-time — current through yesterday, no 3-day buffer). See ADR-0017.

| column            | type   |
|-------------------|--------|
| id                | string |
| type              | string |
| created_at        | string |
| actor_type        | string |
| actor_email       | string |
| actor_user_id     | string |
| actor_api_key_id  | string |
| actor_ip_address  | string |
| actor_user_agent  | string |
| organization_id   | string |
| payload           | string |

`payload` holds the FULL original event as a JSON string — reach
type-specific fields with `json_extract_scalar(payload, '$.field')`
instead of adding columns.
