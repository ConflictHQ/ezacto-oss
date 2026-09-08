// Fill the prod environment of `entries/worker/wrangler.jsonc` from the
// deploying account's own values, in place, immediately before a prod deploy.
//
// Why this exists. The dev environment is the public demo and the OSS gate, so
// it is committed whole and stays that way. The prod environment is whoever is
// running their own books on this: its hostname, its D1 database ids and its
// brand are that operator's, not the project's, and a public repository is the
// wrong place to keep another party's estate written down.
//
// Why in place rather than to a second file. Two provisioning scripts already
// read `entries/worker/wrangler.jsonc` at a fixed path and validate its shape
// (scripts/provision-cloudflare-queues.mjs, scripts/provision-cloudflare-r2.mjs),
// and `wrangler deploy` reads it again. Rendering to a different filename would
// mean teaching all three about a second path, for no gain.
//
// The failure mode is deliberate. The placeholders are syntactically valid --
// they have to be, because `wrangler deploy --dry-run` validates every
// environment in the file, so an unparseable prod block breaks the dev build --
// but they name nothing that exists, and the host sits under the reserved
// .invalid TLD. A prod deploy that skips this step is refused by Cloudflare
// rather than landing somewhere unintended.

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// The config to render. Overridable only so the deployment-contract tests can
// render into a scratch copy and assert what the rendered config becomes --
// which puts this script under test rather than trusting it.
const configUrl =
  process.env.EZACTO_WRANGLER_CONFIG === undefined
    ? new URL("../entries/worker/wrangler.jsonc", import.meta.url)
    : pathToFileURL(process.env.EZACTO_WRANGLER_CONFIG);

/**
 * Every prod value that identifies the operator, and the placeholder it
 * replaces. A placeholder that survives to `wrangler deploy` is a bug, so each
 * is written so Cloudflare cannot accept it by accident.
 */
const FIELDS = [
  { env: "PROD_WORKER_NAME", placeholder: "replace-me-worker-name" },
  { env: "PROD_HOST", placeholder: "replace-me.invalid" },
  { env: "PROD_D1_DATABASE_NAME", placeholder: "replace-me-d1-name" },
  { env: "PROD_D1_DATABASE_ID", placeholder: "00000000-0000-0000-0000-000000000000" },
  { env: "PROD_R2_BUCKET", placeholder: "replace-me-r2-bucket" },
  { env: "PROD_EMAIL_QUEUE", placeholder: "replace-me-email-queue" },
  { env: "PROD_BRAND_NAME", placeholder: "replace-me-brand-name" },
  { env: "PROD_BRAND_TAGLINE", placeholder: "replace-me-brand-tagline" },
  { env: "PROD_BRAND_DESCRIPTION", placeholder: "replace-me-brand-description" },
  { env: "PROD_BRAND_EMAIL_SENDER_NAME", placeholder: "replace-me-brand-sender" },
];

// The host appears twice: as the route pattern and inside APP_BASE_URL. Both
// must move together or sign-in links point at the previous deployment.
const HOST_URL_PLACEHOLDER = "https://replace-me.invalid";

const missing = FIELDS.filter(({ env }) => {
  const value = process.env[env];
  return value === undefined || value.trim() === "";
});

if (missing.length > 0) {
  console.error(
    `::error::prod render is missing ${missing.length} value(s): ${missing
      .map(({ env }) => env)
      .join(", ")}`,
  );
  console.error(
    "Set them on the prod deployment environment. Rendering is refused rather " +
      "than partially applied: a half-rendered config deploys one operator's " +
      "worker against another operator's database.",
  );
  process.exit(1);
}

const original = await readFile(configUrl, "utf8");
let rendered = original;

for (const { env, placeholder } of FIELDS) {
  const value = process.env[env];
  if (!rendered.includes(placeholder)) {
    console.error(
      `::error::placeholder ${placeholder} (${env}) is not present in the config; ` +
        "the template and this script have drifted apart",
    );
    process.exit(1);
  }
  rendered = rendered.split(placeholder).join(value);
}

rendered = rendered
  .split(HOST_URL_PLACEHOLDER)
  .join(`https://${process.env.PROD_HOST}`);

if (rendered.includes("replace-me")) {
  console.error(
    "::error::a replace-me placeholder survived rendering; refusing to write",
  );
  process.exit(1);
}

if (rendered === original) {
  console.error("::error::rendering changed nothing; the config is not a template");
  process.exit(1);
}

await writeFile(configUrl, rendered);
console.log(`rendered prod config for ${process.env.PROD_HOST}`);
