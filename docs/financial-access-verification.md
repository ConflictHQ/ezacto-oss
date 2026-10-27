# Deployed financial-access verification (#549)

Use the owner-designated **employee and contractor test identities on
`https://ezacto.io`**, with the owner's synthetic fixture mapping. The script
refuses every other origin. Do not provision identities, alter roles or enable
`own_money` to make a test pass. The [CONFLICT policy](security.md#financial-visibility-and-conflict-operating-policy)
keeps that setting off.

This is a prepared probe, not a record that the pending designated identities
have been exercised. Current configuration evidence is in
[`549-financial-access-config.json`](evidence/549-financial-access-config.json).

## Private inputs

The operator supplies an outside-the-repository JSON file with mode `0600`:

```json
{
  "origin": "https://ezacto.io",
  "expected_release": "<exact 40-character deployed commit>",
  "from": "<YYYY-MM-DD>",
  "to": "<YYYY-MM-DD>",
  "fixtures": {
    "foreign_user_id": "<synthetic foreign user ID as a number>",
    "foreign_entry_id": "<existing synthetic foreign entry ID as a number>",
    "foreign_invoice_id": "<existing synthetic invoice ID as a number>"
  },
  "actors": [
    {"alias":"employee","user_id":"<number>","own_entry_id":"<number>","session_cookie":"<private native session cookie>"},
    {"alias":"contractor","user_id":"<number>","own_entry_id":"<number>","session_cookie":"<private native session cookie>"}
  ]
}
```

The owner must attest that the fixture IDs exist, belong to the declared
subjects and contain synthetic data. A `404` for an absent fixture is not proof
of foreign-record isolation. Neither a display name nor an employment flag is a
substitute for the intended permission profile: the probe verifies each actual
session's user ID, `member` profile and empty manager grants before fixture
requests. Keep the private alias-to-identity mapping out of the evidence.

```sh
chmod 600 /private/path/financial-probe.json
node scripts/verify-dev-money-isolation.mjs \
  --config /private/path/financial-probe.json \
  --output /private/path/financial-probe-evidence.json
```

The output file must not already exist. Exit zero means every assertion passed;
nonzero means stop and review the sanitized result. Requests are fixed `GET`s,
redirects are refused, responses are bounded, and response bodies/cookie values
are never written to the evidence. No discovery, account creation or financial
mutation is performed. Expired or wrong sessions fail before fixture reads.

For each actor the probe checks own-entry visibility with rate/cost fields
absent; foreign entry ID and user-filter refusal; own and foreign rate-route
refusal; invoice list/detail refusal; financial report/export refusal;
foreign-user manipulation of a self report/export; and `own_money_disabled` on
the personal payment summary. The expected statuses come from the existing
native money-isolation and report authorization rules. It does not exercise an
enabled own-money exception because that contradicts the recorded policy.

## Browser evidence using the same designated sessions

Use separate private browser profiles for the two identities. Do not record
cookies, passwords or unredacted network payloads.

1. Verify the deployed revision and signed-in alias match the API receipt.
2. Open the actor's own week. Confirm its declared synthetic entry is visible
   and rate/cost figures are absent.
3. Confirm invoice and financial-report navigation is unavailable. Directly
   navigate to `/invoices` and the declared synthetic invoice URL; confirm no
   invoice detail or monetary figures appear.
4. Open My hours and verify the report remains scoped to the actor. The API
   receipt covers attempts to replace that subject in report/export requests.
5. Open `/my-payments`; confirm the neutral unavailable state and no figures.
6. Where own-hours CSV export is available, keep the download private and verify
   its header excludes billable/cost-rate and amount columns. Delete the file
   after checking. Do not attach its rows to an issue.
7. Record only alias, revision, screen/route and pass/fail observations alongside
   the API receipt. Sign out and confirm the actor's loaded records clear.

A partial run does not close #549. Both designated subjects need direct API and
browser assertions. Production work remains the separate read-only aggregate;
never run this denial probe against `app.example.com`.
