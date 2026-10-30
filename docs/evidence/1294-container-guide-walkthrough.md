# Container guide walkthrough — #99 / #1294

Date: 2026-10-26. Independent engineering walkthrough, **not human operator acceptance**. Parent #99 remains open; the Worker guide path was not exercised here.

## Environment and isolation

- Fresh worktree at `e62df2bb1d3bbc94fda8442dda547eb23088ba55`; Docker Desktop 29.8.0, macOS arm64; Node 22 snapshot helper.
- Built `ezacto-guide99:e62df2bb` using `docker build --pull --tag ... .`; image ID `sha256:ef6a3c704f696c37099d90ad4e97682aecd7a92f191a8f3e8c91859fb4ba101e`.
- New disposable source and target named volumes, each mounted only at `/data`; no production, review, or customer resources.
- Loopback-only app ports and local Caddy HTTPS reverse proxy. Curl verified the dedicated local CA; native Chromium sign-in used test-local certificate handling. No public DNS or tunnel.
- Environment file and generated credentials were private (0600 inside a 0700 temporary directory). Fictional owner, client, project, task, entry and text attachment only. SMTP used the documented reserved example endpoint; real mail delivery was not tested.

## Literal guide findings

1. Setting the documented 32-byte base64url bootstrap value resulted in HTTP **422**, code `validation_failed`, field `bootstrap`, message `The bootstrap identity fields are invalid.` The app remained healthy. Recreating the container with the same volume and a canonical `ezacto_<16>_<43>` random token made both documented bootstrap calls succeed. No validation changes were made. After a successful sign-in, the bootstrap variable was removed and the container recreated again.
2. The physical helper verified and copied the bundle, then reported the restored database was quarantined. Starting it exactly as previously documented failed before listening: `Restored privacy evidence must be reconciled before this instance serves traffic.` This is a required safety gate, not a restore-copy failure.
3. The SMTP prerequisites claimed verification must succeed before listening, but the guide's documented unavailable example endpoint only warned and the container became healthy. The wording now matches that behavior.

## Executed recovery

Commands used the documented helper with fresh disposable names and absolute private paths:

```sh
docker stop --timeout 30 SOURCE
node scripts/container-physical-snapshot.mjs backup --container SOURCE --output NEW_BUNDLE
node scripts/container-physical-snapshot.mjs verify --bundle NEW_BUNDLE
docker start SOURCE
docker volume create NEW_TARGET_VOLUME
node scripts/container-physical-snapshot.mjs restore --bundle NEW_BUNDLE --volume NEW_TARGET_VOLUME --image PINNED_IMAGE
```

After recording the expected quarantined-start failure, stopped the source cleanly and copied its **current** database separately with `docker cp SOURCE:/data/db.sqlite CURRENT_EVIDENCE`. This was not a copy of the older backup. Mounted it read-only and ran the existing `privacy-restore.js replay`, then `release` in an offline (`--network none`) helper container. The release attestation recorded the actual fixture review: no closures, retention reviews, email log or invoice-email intents; only the known fictional data and attachment; no external deliveries or customer data. No quarantine flags were edited directly.

Started the target, moved the local proxy to it, signed in again with the owner password through both the API and native browser, opened Time, and downloaded the attachment from its authenticated content route.

## Results

| Check | Result |
| --- | --- |
| Source non-root process and health | Passed |
| Source database in verified physical bundle | 4,108,288 bytes; SHA-256 `ad3599142fe3f65c9acf4ce01313e940934fc0cf1b5d0b405f17d98d2e6b05cc` |
| Physical target copy verification | Helper compared all bytes successfully before quarantine |
| Restored business rows | 1 user, 1 client, 1 project, 1 task, 1 time entry, 1 attachment |
| Known time entry | ID 1, 2026-10-26, 1,837 seconds; browser displayed 0.5103 hours |
| Attachment download | 46 bytes; SHA-256 `55ba87c2696ea440d1e0f18ce8fd249f3120a771bec292538000cd1c94056930` matched source exactly |
| Restored native password login and authenticated API | Passed |
| Restored health and release gate | Healthy; `account_restore_quarantine.quarantined = 0` after reviewed release |
| Documented replacement token command | Executed; generated canonical 16/43-character format without printing the secret |

Post-release database hashes are intentionally not compared to the original bundle: quarantine, replay, release and new sign-in legitimately change metadata. The immutable original bundle was verified before restore; restored business rows and attachment bytes were checked after release.

## Cleanup

Source, target and local proxy containers, both disposable named volumes, the dedicated test image, and the private temporary directory (credentials, cookies, databases, bundle and local CA) were removed after validation. A sanitized screenshot of the fictional restored timesheet was retained outside the repository for review. Existing development, GitHub proof, production and review resources were untouched.
