# Operator calendar cleanup (#1316)

This describes source/builds containing #1316. The command and new client
methods are prepared for 0.1.5 and are not included in 0.1.4. Until publication,
use a matching built CLI/client pair; after publication, use 0.1.5 or later.

An active native administrator session can resolve retained old-instance and
closed-account calendar grants after the operator has actually removed the
provider permission. The operation records **operator attestation**, never
provider-verified revocation. It makes no provider request and exposes no token.
Current-user Microsoft disconnect/reauth confirmation remains a separate flow.

## Review and record one obligation

Keep session material in a private pipe or a mode-0600 file outside the checkout.
Use a freshly authenticated administrator session on the intended instance:

```sh
cat /private/session.json | ez calendar-cleanup list
```

The input is `{ "base_url": "https://your-instance.example", "session_cookie":
"__Host-ezacto_session=..." }`. Do not put the cookie in argv, a ticket or a shell
history entry. API tokens and non-administrator sessions are refused. List pages
hold at most 100 rows; use `ez calendar-cleanup list <next_cursor>` for the next.

Each row identifies the **whole custody record**: obligation ID, provider,
source instance, subject user ID, grant generation and revision, key fingerprint,
closure request reference, and the current instance being reviewed. Use the
protected original provider/account evidence to identify whose permission was
removed. A numeric user ID alone does not identify an old account after restore.
Do not select a newer grant because its user ID matches an older one.

Remove the applicable app permission in the provider's own account or
administrator interface and verify the result. Keep detailed evidence protected
outside eZacto. A provider operation still in progress must settle before manual
confirmation. If the provider action fails or the identity is unclear, keep the
obligation unresolved.

Create a private confirmation input containing the same `base_url` and
`session_cookie`, plus:

```json
{
  "selection": "the complete selected row object returned by list",
  "evidence_reference": "Protected ticket CAL-123: exact provider permission removed and checked.",
  "confirm_provider_removed": true
}
```

`selection` must be the row object, not the illustrative string above. Then run:

```sh
cat /private/confirmation.json | ez calendar-cleanup confirm
```

The server rechecks the current administrator session and every reviewed
identity field atomically. A changed instance, revision, closure reference,
status, authority or active provider lease is refused. Refresh the list and
review again; never edit an identity field to bypass a refusal. An identical
retry returns the existing receipt without changing it. A different evidence
reference cannot rewrite a completed receipt.

The receipt includes `kind: operator_attestation`, `provider_verified: false`,
the time and an evidence hash. It omits the evidence text and provider credential.
Status summaries count these as `operator_confirmed`, separately from automatic
provider revocations. The immutable ledger preserves the exact custody identity,
administrator/session attribution and protected evidence reference. Keep that
minimal audit record under the instance's documented retention controls.

## Restored database still in quarantine

Do not bypass quarantine to reach the API. While the restored database remains
offline, inspect only its non-secret custody metadata:

```sh
ez calendar-cleanup inspect /canonical/path/to/restored.sqlite
```

This command opens an existing canonical, stopped/checkpointed file read-only; it does not migrate,
clear quarantine, authenticate to a provider, or resolve anything. Its page and
cursor have the same shape as online review. A current migration-178 schema is
required for the complete recovery workflow.

1. Preserve the original backup and separate current same-instance privacy
   evidence. Follow the existing [privacy replay procedure](account-retention-follow-through.md#container-restore-quarantine).
2. Use the inspected source custody and protected account evidence to remove and
   verify the exact provider permissions externally. Reconcile all other privacy
   obligations and retained copies required by the restore procedure.
3. Run the existing reviewed privacy release only when its conditions are met.
   That release is still an operator attestation; this feature does not relax it.
4. Start the instance, obtain a fresh administrator session, and list the
   obligations again. Record each exact confirmation using the online command.
   A changed review instance requires a new review.
5. Restored calendars continue to require fresh provider consent. They cannot
   reconnect while their applicable cleanup remains unresolved. Resolving a
   closed account's grant does not reopen the account or restore its credentials.

The same metadata inspection applies to a verified Worker bundle restored to
quarantined SQLite. For D1 restoration, retain the documented operational
isolation and reconciliation procedure; never enable traffic merely to run this
command before privacy release is justified.
