export interface R2Contract {
  environment: "dev" | "prod";
  workerName: string;
  host: string;
  binding: "ATTACHMENTS";
  bucketName: string;
}

export interface R2ConvergenceOptions {
  fetch: typeof globalThis.fetch;
  apiToken: string;
  accountId: string;
}

export interface R2ConvergenceResult {
  environment: "dev" | "prod";
  mode: "check" | "deployed" | "provision";
  resources: Array<{
    name: string;
    disposition: "created" | "reused";
  }>;
}

export function readR2Contract(
  environment: string,
  configUrl?: URL,
): Promise<R2Contract>;

export function convergeR2(
  contract: R2Contract,
  mode: "check" | "deployed" | "provision",
  options: R2ConvergenceOptions,
): Promise<R2ConvergenceResult>;
