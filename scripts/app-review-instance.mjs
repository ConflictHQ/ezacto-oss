// One named self-hosted test instance, never an arbitrary preview deployment.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { deploySecretPayload } from "./render-deploy-secrets.mjs";
import {
  parseJsonc,
  readQueueContract,
  convergeQueues,
} from "./provision-cloudflare-queues.mjs";
import { readR2Contract, convergeR2 } from "./provision-cloudflare-r2.mjs";

export const REVIEW = Object.freeze({
  host: "review.ezacto.io",
  worker: "ezacto-app-review",
  database: "ezacto-app-review",
  bucket: "ezacto-app-review-attachments",
  queue: "ezacto-app-review-email",
});
const configUrl = new URL("../entries/worker/wrangler.jsonc", import.meta.url);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function reviewSecrets(env) {
  const bootstrap = env.REVIEW_BOOTSTRAP_TOKEN ?? "";
  const password = env.REVIEW_OWNER_PASSWORD ?? "";
  if (!/^ezacto_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/.test(bootstrap)) {
    throw new Error("REVIEW_BOOTSTRAP_TOKEN must be a generated eZacto token");
  }
  if (password.length < 24 || password.length > 128 || /\s/.test(password)) {
    throw new Error(
      "REVIEW_OWNER_PASSWORD must contain 24–128 non-whitespace characters",
    );
  }
  // Whitelist review-specific credentials; never inherit prod integrations.
  return deploySecretPayload({
    API_CURSOR_SIGNING_KEY: env.REVIEW_CURSOR_SIGNING_KEY,
    EZACTO_BOOTSTRAP_TOKEN: bootstrap,
  });
}

export async function resolveDatabase(run) {
  const list = () => {
    const result = JSON.parse(run(["d1", "list", "--json"]));
    if (!Array.isArray(result)) throw new Error("Invalid D1 inventory");
    return result.filter((item) => item.name === REVIEW.database);
  };
  let matches = list();
  if (matches.length === 0) {
    run(["d1", "create", REVIEW.database]);
    matches = list();
  }
  if (matches.length !== 1 || !uuid.test(matches[0].uuid ?? "")) {
    throw new Error(
      "D1 must resolve to one exact review database with a valid ID",
    );
  }
  return matches[0].uuid;
}

export function renderEnvironment(databaseId) {
  if (
    !uuid.test(databaseId) ||
    databaseId === "00000000-0000-0000-0000-000000000000"
  ) {
    throw new Error("Invalid review D1 database ID");
  }
  return {
    PROD_WORKER_NAME: REVIEW.worker,
    PROD_HOST: REVIEW.host,
    PROD_D1_DATABASE_NAME: REVIEW.database,
    PROD_D1_DATABASE_ID: databaseId,
    PROD_R2_BUCKET: REVIEW.bucket,
    PROD_EMAIL_QUEUE: REVIEW.queue,
    PROD_BRAND_NAME: "eZacto Review",
    PROD_BRAND_TAGLINE: "A self-hosted test workspace.",
    PROD_BRAND_DESCRIPTION:
      "Fictional business records for app review. No customer data.",
    PROD_BRAND_EMAIL_SENDER_NAME: "eZacto Review",
  };
}

export async function assertReviewConfig(url = configUrl) {
  const config = parseJsonc(await readFile(url, "utf8"));
  const prod = config.env?.prod;
  if (
    prod?.name !== REVIEW.worker ||
    prod.workers_dev !== false ||
    prod.routes?.length !== 1 ||
    prod.routes[0].pattern !== REVIEW.host ||
    prod.routes[0].custom_domain !== true ||
    prod.vars?.ENVIRONMENT !== "prod" ||
    prod.vars.APP_BASE_URL !== `https://${REVIEW.host}` ||
    prod.vars.DEMO_MODE !== undefined ||
    prod.d1_databases?.length !== 1 ||
    prod.d1_databases[0].binding !== "DB" ||
    prod.d1_databases[0].database_name !== REVIEW.database ||
    !uuid.test(prod.d1_databases[0].database_id ?? "") ||
    prod.d1_databases[0].database_id === "00000000-0000-0000-0000-000000000000"
  ) {
    throw new Error("Review instance identity or isolation drifted");
  }
  const queue = await readQueueContract("prod", url);
  const bucket = await readR2Contract("prod", url);
  if (
    bucket.bucketName !== REVIEW.bucket ||
    prod.queues.producers[0].queue !== REVIEW.queue ||
    prod.queues.consumers[0].queue !== REVIEW.queue ||
    prod.queues.consumers[0].dead_letter_queue !== `${REVIEW.queue}-dlq`
  ) {
    throw new Error("Review instance storage or queue identity drifted");
  }
  return { queue, bucket, databaseId: prod.d1_databases[0].database_id };
}

export function requireVerifiedR2(result) {
  if (
    result.resources?.length !== 1 ||
    result.resources[0].name !== REVIEW.bucket ||
    !["created", "reused"].includes(result.resources[0].disposition)
  ) {
    throw new Error(
      "Review R2 bucket must be verified; assumed existence is insufficient",
    );
  }
}

export async function verifyDatabaseBinding(databaseId, options) {
  const response = await options.fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/workers/scripts/${REVIEW.worker}/settings`,
    {
      headers: { authorization: `Bearer ${options.apiToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok) throw new Error("Cannot verify deployed review D1 binding");
  const payload = await response.json();
  const bindings = payload.result?.bindings;
  const matches = Array.isArray(bindings)
    ? bindings.filter((binding) => binding.name === "DB")
    : [];
  if (
    payload.success !== true ||
    matches.length !== 1 ||
    matches[0].type !== "d1" ||
    (matches[0].database_id ?? matches[0].id) !== databaseId ||
    (matches[0].id !== undefined && matches[0].id !== databaseId)
  ) {
    throw new Error("Deployed review D1 binding drifted");
  }
}

async function main(mode) {
  if (process.env.GITHUB_REF !== "refs/heads/main")
    throw new Error("Review deployment requires main");
  const options = {
    fetch,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  };
  if (!options.accountId || !options.apiToken)
    throw new Error("Cloudflare credentials are missing");
  if (mode === "prepare") {
    reviewSecrets(process.env); // Validate before creating any remote resource.
    const databaseId = await resolveDatabase((args) =>
      execFileSync("npx", ["--no-install", "wrangler", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    execFileSync(
      process.execPath,
      [new URL("./render-wrangler-prod.mjs", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          ...renderEnvironment(databaseId),
          EZACTO_WRANGLER_CONFIG: configUrl.pathname,
        },
        stdio: "pipe",
      },
    );
  } else if (mode !== "deployed") {
    throw new Error("Expected prepare or deployed");
  }
  const { queue, bucket, databaseId } = await assertReviewConfig();
  const convergenceMode = mode === "prepare" ? "provision" : "deployed";
  await convergeQueues(queue, convergenceMode, options);
  requireVerifiedR2(await convergeR2(bucket, convergenceMode, options));
  if (mode === "deployed") await verifyDatabaseBinding(databaseId, options);
  console.log(`Review ${mode}: fixed resource identities verified`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv[2]).catch(() => {
    // Child process exceptions can contain stdout, stderr and credential args.
    console.error(
      "Review resource preparation/verification failed; check configuration and Cloudflare permissions",
    );
    process.exitCode = 1;
  });
}
