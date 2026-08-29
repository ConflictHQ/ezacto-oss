export interface QueueContract {
  environment: "dev" | "prod";
  workerName: string;
  host: string;
  queueName: string;
  deadLetterQueue: string;
  maxBatchSize: number;
  maxBatchTimeout: number;
  maxRetries: number;
  retryDelay: number;
  maxConcurrency: number;
}

export interface QueueConvergenceOptions {
  fetch: typeof globalThis.fetch;
  apiToken: string;
  accountId: string;
}

export interface QueueConvergenceResult {
  environment: "dev" | "prod";
  mode: "check" | "deployed" | "provision";
  resources: Array<{
    name: string;
    id: string;
    disposition: "created" | "reused";
  }>;
}

export function readQueueContract(
  environment: string,
  configUrl?: URL,
): Promise<QueueContract>;

export function convergeQueues(
  contract: QueueContract,
  mode: "check" | "deployed" | "provision",
  options: QueueConvergenceOptions,
): Promise<QueueConvergenceResult>;
