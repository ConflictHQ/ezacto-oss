# Administrator CSV mapping and preview

Refs #1182, #1181 and #1012. Company → Import and export now offers a Clockify Detailed CSV review workflow on Container/SQLite. Worker shows operator-tool guidance before reading a file. API tokens and non-administrator sessions cannot use private staging.

Choose a CSV (maximum 5 MiB), enter its stable workspace identity and IANA exporter timezone, then review the server preview. Dates must be ISO and durations are interpreted under the supported source contract. The device timezone, source money and archived or ambiguous matches are never silently substituted.

The review shows destination organization, file hash, dataset, source/destination seconds, unpriced time, setup/assignment counts and all row/file warnings. Source and destination catalogs are paged by exact parent scope. Administrators can choose exact destination IDs or named new setup; new people remain inactive and uninvited. Diagnostics retain physical line numbers and full failure counts. Exclusions are explicit, and every change requires a new immutable preview.

**Apply requires the real durable backend.** Explicit confirmation binds the immutable preview, selected-row counts and reviewed exclusions. The accepted command is retained for exact retry after an unknown response. Progress is reconciled from the native ledger; cancellation stops future chunks and never rolls back committed time or setup. The browser does not create or modify invoices, payments or source prices.

The page announces loading states, disables competing actions while a mutation is pending, warns before leaving during processing, clears privileged state on session loss, and ignores late results. Saved staging can be reloaded by its owner using the opaque locator in the page URL. Raw bytes and credentials are never put in that URL. Failed purges remain retryable; completed purges allow a new upload.

Verification uses the real Container runtime, native sessions, private staging and read-only parser worker in a disposable local fixture. It checks phone-sized controls, mapped/new entities, explicit exclusions, immutable preview reload, sign-out cleanup zero business writes before confirmation, exactly the reviewed time afterward, and unchanged financial rows. No live-provider or production data is involved.
