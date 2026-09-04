import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  parseJsonc,
  readQueueContract,
} from "./provision-cloudflare-queues.mjs";

const apiOrigin = "https://api.cloudflare.com/client/v4";
const modes = new Set(["check", "deployed", "provision"]);
const r2Permission = "Account > Workers R2 Storage > Edit";

class CloudflareApiError extends Error {
  constructor(status) {
    super(
      status === 403
        ? `Cloudflare R2 API returned HTTP 403; CLOUDFLARE_API_TOKEN must grant ${r2Permission} for the account selected by CLOUDFLARE_ACCOUNT_ID`
        : `Cloudflare R2 API returned HTTP ${status}`,
    );
    this.status = status;
  }
}

const record = (value, field) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
};

const nonEmptyString = (value, field) => {
  if (typeof value !== "string" || value.trim() !== value || value === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
};

export const readR2Contract = async (
  environment,
  configUrl = new URL("../entries/worker/wrangler.jsonc", import.meta.url),
) => {
  const deployment = await readQueueContract(environment, configUrl);
  const config = record(
    parseJsonc(await readFile(configUrl, "utf8")),
    "config",
  );
  const environmentConfig = record(
    record(config.env, "config.env")[environment],
    `config.env.${environment}`,
  );
  if (
    !Array.isArray(environmentConfig.r2_buckets) ||
    environmentConfig.r2_buckets.length !== 1
  ) {
    throw new TypeError(`${environment} must declare exactly one R2 bucket`);
  }
  const bucket = record(
    environmentConfig.r2_buckets[0],
    `${environment} R2 bucket`,
  );
  if (bucket.binding !== "ATTACHMENTS") {
    throw new TypeError(`${environment} R2 binding must be ATTACHMENTS`);
  }
  return {
    environment,
    workerName: deployment.workerName,
    host: deployment.host,
    binding: "ATTACHMENTS",
    bucketName: nonEmptyString(
      bucket.bucket_name,
      `${environment} R2 bucket name`,
    ),
  };
};

const cloudflareRequest = async (options, path, init = {}) => {
  const response = await options.fetch(
    `${apiOrigin}/accounts/${encodeURIComponent(options.accountId)}${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${options.apiToken}`,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
    },
  );
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new CloudflareApiError(response.status);
  }
  if (!response.ok || payload?.success !== true) {
    throw new CloudflareApiError(response.status);
  }
  return payload;
};

const listBuckets = async (options) => {
  const buckets = [];
  const seenCursors = new Set();
  let cursor = null;
  do {
    const query =
      cursor === null
        ? "?per_page=1000"
        : `?per_page=1000&cursor=${encodeURIComponent(cursor)}`;
    const payload = await cloudflareRequest(options, `/r2/buckets${query}`);
    if (!Array.isArray(payload.result?.buckets)) {
      throw new TypeError("Cloudflare R2 API returned an invalid bucket list");
    }
    buckets.push(...payload.result.buckets);
    const next = payload.result_info?.cursor;
    cursor = typeof next === "string" && next !== "" ? next : null;
    if (cursor !== null) {
      if (seenCursors.has(cursor))
        throw new Error("Cloudflare R2 pagination cursor repeated");
      seenCursors.add(cursor);
    }
  } while (cursor !== null);
  return buckets;
};

const exactBucket = (buckets, name) => {
  const matches = buckets.filter((bucket) => bucket?.name === name);
  if (matches.length > 1)
    throw new Error(`Cloudflare has duplicate R2 buckets named ${name}`);
  return matches[0] ?? null;
};

const createBucket = async (name, options) => {
  await cloudflareRequest(options, "/r2/buckets", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
};

const assertDeployedBinding = async (contract, options) => {
  const payload = await cloudflareRequest(
    options,
    `/workers/scripts/${encodeURIComponent(contract.workerName)}/settings`,
  );
  const bindings = payload.result?.bindings;
  if (!Array.isArray(bindings)) {
    throw new TypeError("Cloudflare Workers API returned invalid bindings");
  }
  const matches = bindings.filter(
    (binding) =>
      binding?.type === "r2_bucket" && binding.name === contract.binding,
  );
  if (matches.length !== 1 || matches[0]?.bucket_name !== contract.bucketName) {
    throw new Error(`${contract.workerName} ATTACHMENTS R2 binding drifted`);
  }
};

export const convergeR2 = async (contract, mode, options) => {
  if (!modes.has(mode)) throw new TypeError("R2 mode is invalid");
  let buckets;
  try {
    buckets = await listBuckets(options);
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 403) {
      process.stderr.write(
        `warning: R2 API returned 403 — token lacks ${r2Permission}; assuming bucket ${contract.bucketName} exists from prior deploy\n`,
      );
      if (mode === "deployed") await assertDeployedBinding(contract, options);
      return {
        environment: contract.environment,
        mode,
        resources: [{ name: contract.bucketName, disposition: "assumed" }],
      };
    }
    throw error;
  }
  let bucket = exactBucket(buckets, contract.bucketName);
  let disposition = "reused";
  if (bucket === null) {
    if (mode !== "provision") {
      throw new Error(
        `Cloudflare R2 bucket ${contract.bucketName} is not provisioned`,
      );
    }
    await createBucket(contract.bucketName, options);
    buckets = await listBuckets(options);
    bucket = exactBucket(buckets, contract.bucketName);
    if (bucket === null) {
      throw new Error(
        `Cloudflare R2 bucket ${contract.bucketName} did not converge after creation`,
      );
    }
    disposition = "created";
  }
  if (mode === "deployed") await assertDeployedBinding(contract, options);
  return {
    environment: contract.environment,
    mode,
    resources: [{ name: contract.bucketName, disposition }],
  };
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  try {
    const environment = process.argv[2] ?? "";
    const mode = process.argv[3] ?? "";
    const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
    if (apiToken === "" || accountId === "") {
      throw new TypeError("Cloudflare credentials are not configured");
    }
    const contract = await readR2Contract(environment);
    const result = await convergeR2(contract, mode, {
      fetch,
      apiToken,
      accountId,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "R2 convergence failed"}\n`,
    );
    process.exitCode = 1;
  }
}
