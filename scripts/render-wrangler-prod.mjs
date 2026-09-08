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
// The failure mode is deliberate. The committed placeholders are not valid
// Cloudflare identifiers, so a prod deploy that skips this step is rejected by
// wrangler before it can put anything anywhere -- rather than deploying
// successfully against the wrong account, which is the failure worth designing
// against.

import { readFile, writeFile } from "node:fs/promises";

const configUrl = new URL("../entries/worker/wrangler.jsonc", import.meta.url);

/**
 * Every prod value that identifies the operator, and the placeholder it
 * replaces. A placeholder that survives to `wrangler deploy` is a bug, so each
 * is written so Cloudflare cannot accept it by accident.
 */
const FIELDS = [
  { env: "PROD_WORKER_NAME", placeholder: "REPLACE_ME_worker_name" },
  { env: "PROD_HOST", placeholder: "REPLACE_ME.invalid" },
  { env: "PROD_D1_DATABASE_NAME", placeholder: "REPLACE_ME_d1_name" },
  { env: "PROD_D1_DATABASE_ID", placeholder: "00000000-0000-0000-0000-000000000000" },
  { env: "PROD_R2_BUCKET", placeholder: "REPLACE_ME_r2_bucket" },
  { env: "PROD_EMAIL_QUEUE", placeholder: "REPLACE_ME_email_queue" },
  { env: "PROD_BRAND_NAME", placeholder: "REPLACE_ME_brand_name" },
  { env: "PROD_BRAND_TAGLINE", placeholder: "REPLACE_ME_brand_tagline" },
  { env: "PROD_BRAND_DESCRIPTION", placeholder: "REPLACE_ME_brand_description" },
  { env: "PROD_BRAND_EMAIL_SENDER_NAME", placeholder: "REPLACE_ME_brand_sender" },
];

// The host appears twice: as the route pattern and inside APP_BASE_URL. Both
// must move together or sign-in links point at the previous deployment.
const HOST_URL_PLACEHOLDER = "https://REPLACE_ME.invalid";

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

if (rendered.includes("REPLACE_ME")) {
  console.error(
    "::error::a REPLACE_ME placeholder survived rendering; refusing to write",
  );
  process.exit(1);
}

if (rendered === original) {
  console.error("::error::rendering changed nothing; the config is not a template");
  process.exit(1);
}

await writeFile(configUrl, rendered);
console.log(`rendered prod config for ${process.env.PROD_HOST}`);
