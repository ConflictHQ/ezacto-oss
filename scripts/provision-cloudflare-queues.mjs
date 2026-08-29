import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const apiOrigin = "https://api.cloudflare.com/client/v4";
const environments = new Set(["dev", "prod"]);
const modes = new Set(["check", "deployed", "provision"]);

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

const positiveInteger = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
};

const parseJsonc = (source) => {
  let stripped = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        stripped += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (character === "\n") {
        stripped += character;
      }
      continue;
    }
    if (!inString && character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!inString && character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    stripped += character;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    }
  }

  let withoutTrailingCommas = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < stripped.length; index += 1) {
    const character = stripped[index];
    if (!inString && character === ",") {
      let nextIndex = index + 1;
      while (/\s/u.test(stripped[nextIndex] ?? "")) nextIndex += 1;
      if (stripped[nextIndex] === "}" || stripped[nextIndex] === "]") continue;
    }
    withoutTrailingCommas += character;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    }
  }
  return JSON.parse(withoutTrailingCommas);
};

export const readQueueContract = async (
  environment,
  configUrl = new URL("../entries/worker/wrangler.jsonc", import.meta.url),
) => {
  if (!environments.has(environment)) {
    throw new TypeError("environment must be dev or prod");
  }
  const config = record(
    parseJsonc(await readFile(configUrl, "utf8")),
    "config",
  );
  const environmentConfig = record(
    record(config.env, "config.env")[environment],
    `config.env.${environment}`,
  );
  const workerName = nonEmptyString(
    environmentConfig.name,
    `config.env.${environment}.name`,
  );
  if (
    !Array.isArray(environmentConfig.routes) ||
    environmentConfig.routes.length !== 1
  ) {
    throw new TypeError(
      `${environment} must declare exactly one deployment route`,
    );
  }
  const route = record(environmentConfig.routes[0], `${environment} route`);
  const host = nonEmptyString(route.pattern, `${environment} route pattern`);
  const queues = record(
    environmentConfig.queues,
    `config.env.${environment}.queues`,
  );
  if (!Array.isArray(queues.producers) || queues.producers.length !== 1) {
    throw new TypeError(
      `${environment} must declare exactly one queue producer`,
    );
  }
  if (!Array.isArray(queues.consumers) || queues.consumers.length !== 1) {
    throw new TypeError(
      `${environment} must declare exactly one queue consumer`,
    );
  }
  const producer = record(queues.producers[0], `${environment} queue producer`);
  const consumer = record(queues.consumers[0], `${environment} queue consumer`);
  if (producer.binding !== "EMAIL_QUEUE") {
    throw new TypeError(
      `${environment} queue producer binding must be EMAIL_QUEUE`,
    );
  }
  const queueName = nonEmptyString(producer.queue, `${environment} queue name`);
  if (consumer.queue !== queueName) {
    throw new TypeError(
      `${environment} producer and consumer queues must match`,
    );
  }
  const deadLetterQueue = nonEmptyString(
    consumer.dead_letter_queue,
    `${environment} dead-letter queue`,
  );
  if (deadLetterQueue === queueName) {
    throw new TypeError(`${environment} dead-letter queue must be distinct`);
  }

  return {
    environment,
    workerName,
    host,
    queueName,
    deadLetterQueue,
    maxBatchSize: positiveInteger(
      consumer.max_batch_size,
      `${environment} max_batch_size`,
    ),
    maxBatchTimeout: positiveInteger(
      consumer.max_batch_timeout,
      `${environment} max_batch_timeout`,
    ),
    maxRetries: positiveInteger(
      consumer.max_retries,
      `${environment} max_retries`,
    ),
    retryDelay: positiveInteger(
      consumer.retry_delay,
      `${environment} retry_delay`,
    ),
    maxConcurrency: positiveInteger(
      consumer.max_concurrency,
      `${environment} max_concurrency`,
    ),
  };
};

const cloudflareRequest = async (
  fetchImplementation,
  accountId,
  apiToken,
  path,
  init = {},
) => {
  const response = await fetchImplementation(
    `${apiOrigin}/accounts/${encodeURIComponent(accountId)}${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${apiToken}`,
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
    throw new Error(`Cloudflare Queues API returned HTTP ${response.status}`);
  }
  if (!response.ok || payload?.success !== true) {
    throw new Error(`Cloudflare Queues API returned HTTP ${response.status}`);
  }
  return payload;
};

const listQueues = async (options) => {
  const queues = [];
  let page = 1;
  let totalPages = 1;
  do {
    const payload = await cloudflareRequest(
      options.fetch,
      options.accountId,
      options.apiToken,
      `/queues?page=${page}`,
    );
    if (!Array.isArray(payload.result)) {
      throw new TypeError("Cloudflare Queues API returned an invalid list");
    }
    queues.push(...payload.result);
    const reportedPages = payload.result_info?.total_pages;
    totalPages =
      Number.isSafeInteger(reportedPages) && reportedPages > 0
        ? reportedPages
        : 1;
    page += 1;
  } while (page <= totalPages);
  return queues;
};

const exactQueue = (queues, name) => {
  const matches = queues.filter((queue) => queue?.queue_name === name);
  if (matches.length > 1) {
    throw new Error(`Cloudflare has duplicate queues named ${name}`);
  }
  return matches[0] ?? null;
};

const createQueue = async (name, options) => {
  await cloudflareRequest(
    options.fetch,
    options.accountId,
    options.apiToken,
    "/queues",
    { method: "POST", body: JSON.stringify({ queue_name: name }) },
  );
};

const assertDeployedBinding = (queue, contract) => {
  const producerMatches = Array.isArray(queue.producers)
    ? queue.producers.filter(
        (producer) =>
          producer?.type === "worker" &&
          producer.script === contract.workerName,
      )
    : [];
  if (producerMatches.length !== 1) {
    throw new Error(`${contract.workerName} is not the exact queue producer`);
  }
  const consumerMatches = Array.isArray(queue.consumers)
    ? queue.consumers.filter(
        (consumer) =>
          consumer?.type === "worker" &&
          (consumer.script === contract.workerName ||
            consumer.service === contract.workerName),
      )
    : [];
  if (consumerMatches.length !== 1) {
    throw new Error(`${contract.workerName} is not the exact queue consumer`);
  }
  const consumer = consumerMatches[0];
  const settings = consumer.settings ?? {};
  const expected = {
    deadLetterQueue: contract.deadLetterQueue,
    batchSize: contract.maxBatchSize,
    batchTimeoutMs: contract.maxBatchTimeout * 1_000,
    maxRetries: contract.maxRetries,
    retryDelay: contract.retryDelay,
    maxConcurrency: contract.maxConcurrency,
  };
  const actual = {
    deadLetterQueue: consumer.dead_letter_queue,
    batchSize: settings.batch_size,
    batchTimeoutMs: settings.max_wait_time_ms,
    maxRetries: settings.max_retries,
    retryDelay: settings.retry_delay,
    maxConcurrency: settings.max_concurrency,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${contract.workerName} queue consumer settings drifted`);
  }
};

export const convergeQueues = async (contract, mode, options) => {
  if (!modes.has(mode)) throw new TypeError("queue mode is invalid");
  let queues = await listQueues(options);
  const resources = [];
  for (const name of [contract.queueName, contract.deadLetterQueue]) {
    let queue = exactQueue(queues, name);
    let disposition = "reused";
    if (queue === null) {
      if (mode !== "provision") {
        throw new Error(`Cloudflare Queue ${name} is not provisioned`);
      }
      await createQueue(name, options);
      queues = await listQueues(options);
      queue = exactQueue(queues, name);
      if (queue === null) {
        throw new Error(
          `Cloudflare Queue ${name} did not converge after creation`,
        );
      }
      disposition = "created";
    }
    resources.push({
      name,
      id: nonEmptyString(queue.queue_id, `Cloudflare Queue ${name} id`),
      disposition,
    });
  }
  if (mode === "deployed") {
    assertDeployedBinding(exactQueue(queues, contract.queueName), contract);
  }
  return { environment: contract.environment, mode, resources };
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
    const contract = await readQueueContract(environment);
    const result = await convergeQueues(contract, mode, {
      fetch,
      apiToken,
      accountId,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Queue convergence failed"}\n`,
    );
    process.exitCode = 1;
  }
}
