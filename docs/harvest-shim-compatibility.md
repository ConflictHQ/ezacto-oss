# Harvest shim compatibility evidence

The read-only native acceptance in
[the receipt](evidence/11-harvest-postman-native.json) uses the pinned, MIT-licensed
`harvest-api-v2-postman-collection.json` from
[hrvst-cli](https://github.com/kgajera/hrvst-cli/blob/088414c97e182048fd901ba1252fdafbd0e97e65/harvest-api-v2-postman-collection.json).
The collection is not vendored or edited. Its digest and each selected original
request path/digest are recorded.

`scripts/harvest-postman-read-subset.mjs` reads those original definitions, fills
fixture IDs and authorization variables, and maps only the exact Harvest origin
and supported GET paths to an owned loopback `/harvest/v2` service. It does not
run Postman or any collection scripts. All scripts must be blank; other methods,
origins, paths, redirects, changed collection bytes, zero/partial selections and
non-200 responses fail closed. Exactly 15 selected requests must pass. The
instance's health-reported revision must match the operator's expected revision.

An operator can repeat the check with an isolated native instance and a private
configuration file containing `origin`, `expectedSourceRevision`, a short-lived
read-only `token`, and positive fixture IDs under `ids` (`client_id`, `project_id`,
`task_id`, `expense_id`, `time_entry_id`, `user_id`). This acceptance fixture has
one of each record, 1.25 time-entry hours and a 23.45 USD expense. The token needs
`clients:read`, `projects:read`, `team:read`, `time_entries:read`, `expenses:read`.

```sh
node scripts/harvest-postman-read-subset.mjs \
  /absolute/original-collection.json /private/fixture-config.json /private/new-evidence.json
```

Keep credentials and the runtime output private; review the sanitized receipt
before sharing it. Revoke the scoped token and remove the disposable instance,
volume and configuration afterward. The committed receipt records that cleanup.

This verifies the supported GET subset with an independent adapter; it does not
claim a full Postman-runtime run or complete #11. The next compatibility slice
is invoice list/detail reads with native visibility, monetary redaction and
paging, followed by locked-expense writes. [Harvest documents](https://help.getharvest.com/api-v2/expenses-api/expenses/expenses/#update-an-expense) silent dropping of
only `project_id` and `expense_category_id` when an expense is locked; that
behavior must remain shim-only, paired with the native 422 rejection test.
Invoice support also enables the eighth recorded golden family tracked in #16.
