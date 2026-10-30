# Harvest expense update compatibility (#11)

`PATCH /harvest/v2/expenses/:id` accepts the owner's `expenses:write` token
and requires the Expenses module. It maps `project_id`, `expense_category_id`,
`spent_date`, `units`, `total_cost`, `notes` and `billable` to the canonical
expense update. Decimal money uses the existing exact cents calculation;
native validation, pricing, ownership and atomic lock checks still apply.

For an expense already locked, only `project_id` and `expense_category_id`
are ignored, matching the [Harvest update contract](https://help.getharvest.com/api-v2/expenses-api/expenses/expenses/).
A request containing only those fields returns the current visible expense
without a write. Invoice details remain hidden without invoice-read authority.
Other fields on a locked expense still encounter the native lock restriction;
this subset does not provide a route around invoice or approval invariants.

The native `/api/v1/expenses/:id` update continues returning 422 for locked
changes. Paired SQLite/D1 route tests cover that distinction, mixed requests,
decimal conversion, write scope, ownership and the module gate. Other Harvest
expense mutations, multipart receipt updates and edits to another person's
expense are outside this supported write subset.
