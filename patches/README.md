# Miniflare synchronous reply generation

`miniflare-sync-generation.json` backports the merged
[workers-sdk #15552](https://github.com/cloudflare/workers-sdk/pull/15552)
(commit `6f3d7b58b1f6cd036aca3e5946807bba37776065`) to the two versions already
locked in this repository. Published npm bundle hashes were verified before the
backport. This changes only reply generation publication and waiting; the reply
ID assertion remains in place. Existing bundle line positions are preserved for
source-map diagnostics. No SQL or HTTP operation is retried.

Normal `npm ci`/`npm install` applies it through `postinstall`. After an install
with lifecycle scripts disabled, run `npm run deps:patch`. Both original and
patched digests are checked; unknown versions or bytes require review before
installation can finish. Production installs that omit these development
dependencies have nothing to patch.

`npm run test:dependency-patches` forces the late-notification interleaving against
each installed caller and its actual worker publication statement. Both original
bundles fail with the captured `message?.id === id` assertion; the patched bundles
absorb the stale wake and return the correct next reply. Installer tests also
cover idempotency, unchanged bytes on refusal and omitted development dependencies.

Retire each backport when adopting a supported package release containing the
upstream generation fix, with the same deterministic regression still passing.
