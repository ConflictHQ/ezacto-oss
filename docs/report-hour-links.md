# Report hour links

Click an hour total to open **Detailed time → Individual entries** for its date
range and contributing population. Links support new tabs, bookmarks, reload,
and browser Back. Entry hours open the original timesheet entry.

| Source | Scope carried to detail |
| --- | --- |
| Time: summary, rows, totals | Fixed-fee inclusion, billable split, client/project/task/person |
| My hours: summary, projects, totals | Signed-in person and selected project; billable figures select billable entries |
| Client rollup | Direct client activity or the selected client and its descendants |
| Uninvoiced work | Billable, uninvoiced, active projects, selected client/project and currency |
| Profitability | Dimension, project currency, project status, billing method, project manager and tag |
| Contractor cost totals | All people or contractors only; cost is in organization currency |
| Detailed daily rows | Day, project, task, person, invoice state, and existing filters |

Detailed report bands also link to entry detail. Role-combination bands keep the
report grouping and jump to the corresponding section. Synthetic profitability
fee rows have no tracked entries and keep their zero hours as text.

The detail view names additional filters and offers **Clear additional filters**.
When stored rounded durations differ from tracked durations, the detail table,
summary and CSV expose rounded hours separately so totals can be reconciled.

## API

`GET /api/v1/reports/detailed-time` additionally accepts:

- `include_fixed_fee=false` to exclude fixed-fee projects (default includes them).
- `direct_client_only=true` to restrict `client_id` to that client, excluding descendants.
- `contractors_only=true`, `currency`, `project_status`, `billing_method`, and `manager_id`.
- `self=true` for the signed-in person's entries under `time_entries:read`.
  The server fixes the person to the authenticated principal and rejects a different
  `user_id`. Requests without this mode still require `reports:read`.

All predicates intersect existing date, project, task, role, tag and invoice filters.
Existing money-field redaction and the complete-result size limit still apply.
