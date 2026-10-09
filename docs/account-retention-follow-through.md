# Retained records, cleanup evidence and restored backups

Account closure removes local access and sign-in credentials. It does not erase every business record or copy held by a mail provider, integration, backup, export, document or attachment. The administrator must review those remaining obligations. Policy selections and checkboxes record the operator’s decisions; they do not certify compliance with any jurisdiction.

## Administrator workflow

In Company settings, publish the retention policy and contact details before asking people to acknowledge it. Each deletion request keeps its original disclosure. Closing access also records the policy and inventory reviewed for that closure; later policy edits do not rewrite either snapshot.

After local closure, open **Retention reviews** and load the due queue. Each retained category and downstream area has its own versioned decision and evidence. Pages contain at most 100 obligations. Pending, failed, released-hold and overdue retention decisions return to the queue.

| Decision       | Required action and meaning                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retain         | Record the current basis, condition for release, evidence reference and future review date. Identified worker hours linked to invoices or payments may remain when the operator documents a continuing basis. |
| Removed        | Perform and verify the removal in the relevant system first, then record its evidence. Saving this decision does not execute a deletion.                                                                      |
| Not applicable | Explain why the area has no applicable copy or obligation.                                                                                                                                                    |
| Failed         | Describe the unresolved action and evidence so it remains in the due queue.                                                                                                                                   |
| Release hold   | Record authorized release of the hold. This does not delete records or complete review; then decide whether another basis supports retention or carry out the removal.                                        |

The confirmation checkbox acknowledges the actual evidence and the effect of saving the decision. Use protected ticket references, operation identifiers and concise results. Do not paste credentials, provider tokens, complete documents or personal records into evidence fields. Administrator access is required; requests to update stale versions fail and require a fresh review. Review history remains attributable and append-only. This release does not automatically purge the minimal request, closure or review ledger: it is needed for continuing reviews, disputes and safe restoration. Operators must document its retention basis and review period, restrict database and backup access, and keep the referenced detailed evidence in a protected system with its own disposal schedule. Do not use the ledger as an unrestricted archive of the underlying personal records.

The downstream areas cover documents and free-text notes, attachments, email copies, integrations and exports, backups, restore safeguards and Apple authorization. Inspect the systems the instance actually uses, including operator-managed copies outside eZacto. Record the owner and verified result in the protected evidence. A failed provider operation remains unresolved; it is not silently treated as successful erasure.

Historical Apple accounts without recoverable provider credentials have a separate manual-disconnect checkbox. First verify the actual disconnect and record protected evidence in the Apple authorization **Removed** review. The completion audit records the administrator, time, review version and evidence. The outcome explicitly says manual verification, and the provider status remains `manual_required`; it never becomes a signed revocation. A known current native generation or web custody obligation still requires its provider proof and cannot be bypassed by this checkbox.

Request completion requires reviewed decisions with no pending, failed or overdue obligation and the relevant authorization cleanup. A completed request can still have disclosed retention with future reviews. The confirmation names retained areas and review dates and does not claim every historical copy was physically destroyed. Retention reviews continue after request completion.

## Container restore quarantine

A supported physical restore first verifies the snapshot checksums and then quarantines the restored database. The server refuses startup while quarantine is set, before its email or integration work can resume. The quarantine deliberately changes the restored database after exact snapshot verification.

Keep the restored volume offline. Obtain a separate, protected, stopped/checkpointed **current** database snapshot from the same instance, including its closure and retention-review history. Do not use the old restored backup itself as current evidence. Preserve the original backup and evidence under the operator’s documented access and retention controls.

The offline tool is bundled at `entries/container/dist/privacy-restore.js`. Run it using the new container image, with no network, the restored volume mounted at `/data`, and the current protected snapshot mounted read-only at `/evidence/current.sqlite`. Adapt the image, volume and canonical host path to the actual deployment:

```sh
docker run --rm --network none --user 0:0 \
  --mount type=volume,source=RESTORED_VOLUME,target=/data \
  --mount type=bind,source=/absolute/protected/current.sqlite,target=/evidence/current.sqlite,readonly \
  --entrypoint node IMAGE entries/container/dist/privacy-restore.js replay \
  --database /data/db.sqlite --current-database /evidence/current.sqlite
```

The tool checks the same-instance closure secret without printing it, copies the source into a temporary private directory, and replays missing local closures transactionally. It checks profile minimization, removal of sign-in credentials and replay prevention. Running timers, ownership conflicts, unrelated instance evidence and snapshots predating the closure security identity fail closed and require offline reconciliation. Provider history that cannot be reconstructed remains conservatively unresolved.

Replay does **not** reconstruct every later free-text edit, attachment removal, email deletion or external export cleanup. Compare the restored data and object storage with current evidence and reapply those actions while offline. Reconcile current policy reviews and provider obligations, and ensure mail/integration queues cannot resend withdrawn information. Review separately retained backup copies under the documented operator schedule. Record the actual result in a protected restore ticket.

Only after that review, run the same command with `release` instead of `replay`, adding `--evidence 'Protected restore ticket reference and verified reconciliation result'`. The evidence must be 20–2000 characters. Release checks that the current privacy evidence has not changed and repeats local closure checks. Changed evidence requires another replay and review. The release is an operator attestation about the separately inspected copies, not proof that the tool erased them.

For a database copied outside the supported snapshot script, first run the tool’s `quarantine --database /data/db.sqlite` command while the database is offline. Never start a restored instance before setting quarantine and reconciling it. Keep a current closure ledger available independently of old backups; without current evidence the tool cannot establish which later removals must be replayed.

## D1 restores

The Worker also refuses database initialization when `account_restore_quarantine` is set. Keep routes, scheduled jobs and queue consumers disabled before a D1 restore; an already initialized Worker is not a substitute for that operational isolation. Set quarantine in the restored database before enabling any traffic. This release does not provide an automatic D1 export/replay/import pipeline. Reconcile the current closure ledger, credentials, objects, downstream copies and provider evidence offline, verify the result, and only then clear quarantine under a protected operator change record and redeploy fresh Worker isolates. If that reconciliation cannot be demonstrated, keep the restore offline.
