import { AwsClient } from "aws4fetch";
import type {
  EmailMessage,
  EmailProviderReceipt,
  EmailRecipient,
  HttpEmailProvider,
} from "./index.js";
import { EmailProviderTerminalError } from "./provider-errors.js";

export interface SesMailerConfig {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  from: string;
  configurationSet?: string;
}

export interface SesMailerOptions {
  fetch?: (request: Request) => Promise<Response>;
  now?: () => Date;
  monotonicNow?: () => number;
}

export interface SesAccountHealth {
  productionAccess: boolean;
  sandbox: boolean;
  sendingEnabled: boolean;
  enforcementStatus: string | null;
  max24HourSend: number | null;
  maxSendRate: number | null;
  sentLast24Hours: number | null;
  region: string;
  configurationSet: string | null;
}

export interface SesIdentitySummary {
  name: string;
  type: string | null;
  verificationStatus: string | null;
  sendingEnabled: boolean;
}

export interface SesIdentityHealth {
  name: string;
  type: string | null;
  verifiedForSending: boolean;
  feedbackForwarding: boolean;
  dkim: {
    status: string | null;
    signingEnabled: boolean;
    signingAttributesOrigin: string | null;
  };
  mailFrom: {
    domain: string | null;
    status: string | null;
    behaviorOnError: string | null;
  };
}

export interface SesSuppression {
  email: string;
  reason: string | null;
  lastUpdate: string | null;
}

interface SesResponse {
  body: Record<string, unknown>;
  requestId: string | null;
  latencyMs: number;
}

class SesApiError extends Error {
  readonly status: number;
  readonly requestId: string | null;

  constructor(status: number, requestId: string | null) {
    super(`SES request failed with status ${status}`);
    this.name = "SesApiError";
    this.status = status;
    this.requestId = requestId;
  }
}

const regionPattern = /^[a-z]{2}(?:-[a-z0-9]+)+-[1-9][0-9]*$/;
const configurationSetPattern = /^[A-Za-z0-9_-]+$/;
const idempotencyKeyPattern = /^[A-Za-z0-9_-]+$/;
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const responseLimit = 1_000_000;

const hasAsciiControl = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 31 || code === 127;
  });

const bounded = (value: string, field: string, maximum: number): string => {
  if (typeof value !== "string")
    throw new TypeError(`${field} must be a string`);
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length === 0 ||
    [...normalized].length > maximum ||
    hasAsciiControl(normalized)
  ) {
    throw new RangeError(`${field} is invalid`);
  }
  return normalized;
};

const bodyText = (value: string, field: string, maximum: number): string => {
  if (typeof value !== "string")
    throw new TypeError(`${field} must be a string`);
  const normalized = value.normalize("NFC");
  if (
    normalized.trim().length === 0 ||
    [...normalized].length > maximum ||
    normalized.includes("\u0000")
  ) {
    throw new RangeError(`${field} is invalid`);
  }
  return normalized;
};

const secret = (value: string, field: string, maximum: number): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    hasAsciiControl(value)
  ) {
    throw new RangeError(`${field} is invalid`);
  }
  return value;
};

const senderAddress = (value: string): string => {
  const normalized = bounded(value, "SES from address", 320);
  const angle = /^[^<>]*<([^<>]+)>$/u.exec(normalized);
  const address = (angle?.[1] ?? normalized).trim().toLowerCase();
  if (!emailPattern.test(address)) {
    throw new RangeError("SES from address is invalid");
  }
  return normalized;
};

const recipientAddress = (recipient: EmailRecipient): string => {
  const email = bounded(
    recipient.email,
    "SES recipient email",
    254,
  ).toLowerCase();
  if (!emailPattern.test(email))
    throw new RangeError("SES recipient email is invalid");
  if (recipient.name === undefined) return email;
  const name = bounded(recipient.name, "SES recipient name", 200);
  return `${name} <${email}>`;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const optionalNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const boolean = (value: unknown): boolean => value === true;

const sigV4Datetime = (value: Date): string => {
  if (!Number.isFinite(value.getTime()))
    throw new RangeError("SES clock is invalid");
  return value.toISOString().replace(/[:-]|\.\d{3}/gu, "");
};

const endpointDomain = (region: string): string =>
  region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";

const safeLatency = (started: number, completed: number): number => {
  const latency = Math.round(completed - started);
  if (!Number.isSafeInteger(latency) || latency < 0 || latency > 3_000_000) {
    throw new RangeError("SES monotonic clock returned an invalid latency");
  }
  return latency;
};

const parseBody = (text: string): Record<string, unknown> => {
  if (text.length === 0) return {};
  if (text.length > responseLimit)
    throw new Error("SES response exceeded size limit");
  try {
    return record(JSON.parse(text));
  } catch {
    return {};
  }
};

/** Workers-compatible SES v2 adapter lifted from ConflictHQ/mailsend@3eb6aa4. */
export class SesMailer implements HttpEmailProvider {
  readonly name = "ses";
  readonly region: string;
  readonly from: string;
  readonly configurationSet: string | null;

  private readonly client: AwsClient;
  private readonly fetchImplementation: (request: Request) => Promise<Response>;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly baseUrl: string;

  constructor(config: SesMailerConfig, options: SesMailerOptions = {}) {
    const accessKeyId = secret(config.accessKeyId, "SES access key id", 256);
    const secretAccessKey = secret(
      config.secretAccessKey,
      "SES secret access key",
      512,
    );
    const sessionToken =
      config.sessionToken === undefined
        ? undefined
        : secret(config.sessionToken, "SES session token", 8_192);
    const region = bounded(config.region, "SES region", 64).toLowerCase();
    if (!regionPattern.test(region))
      throw new RangeError("SES region is invalid");
    const configurationSet =
      config.configurationSet === undefined
        ? null
        : bounded(config.configurationSet, "SES configuration set", 64);
    if (
      configurationSet !== null &&
      !configurationSetPattern.test(configurationSet)
    ) {
      throw new RangeError("SES configuration set is invalid");
    }
    this.region = region;
    this.from = senderAddress(config.from);
    this.configurationSet = configurationSet;
    this.client = new AwsClient({
      accessKeyId,
      secretAccessKey,
      ...(sessionToken === undefined ? {} : { sessionToken }),
      service: "ses",
      region,
      // The durable queue owns retries and backoff. Nested transport retries
      // would hide provider attempts from the delivery ledger.
      retries: 0,
    });
    this.fetchImplementation =
      options.fetch ?? (async (request) => globalThis.fetch(request));
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.baseUrl = `https://email.${region}.${endpointDomain(region)}`;
  }

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<SesResponse> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new TypeError("SES request path must be same-origin");
    }
    const started = this.monotonicNow();
    const signed = await this.client.sign(`${this.baseUrl}${path}`, {
      ...init,
      ...(signal === undefined ? {} : { signal }),
      aws: { datetime: sigV4Datetime(this.now()) },
    });
    const response = await this.fetchImplementation(signed);
    const latencyMs = safeLatency(started, this.monotonicNow());
    const requestId = optionalString(response.headers.get("x-amzn-requestid"));
    const body = parseBody(await response.text());
    if (!response.ok) throw new SesApiError(response.status, requestId);
    return { body, requestId, latencyMs };
  }

  async getAccountHealth(signal?: AbortSignal): Promise<SesAccountHealth> {
    const { body } = await this.request(
      "/v2/email/account",
      { method: "GET" },
      signal,
    );
    const quota = record(body.SendQuota);
    const productionAccess = boolean(body.ProductionAccessEnabled);
    return {
      productionAccess,
      sandbox: !productionAccess,
      sendingEnabled: boolean(body.SendingEnabled),
      enforcementStatus: optionalString(body.EnforcementStatus),
      max24HourSend: optionalNumber(quota.Max24HourSend),
      maxSendRate: optionalNumber(quota.MaxSendRate),
      sentLast24Hours: optionalNumber(quota.SentLast24Hours),
      region: this.region,
      configurationSet: this.configurationSet,
    };
  }

  async listIdentities(signal?: AbortSignal): Promise<SesIdentitySummary[]> {
    const identities: SesIdentitySummary[] = [];
    const seenTokens = new Set<string>();
    let nextToken: string | null = null;
    do {
      const query = new URLSearchParams({ PageSize: "100" });
      if (nextToken !== null) query.set("NextToken", nextToken);
      const { body } = await this.request(
        `/v2/email/identities?${query.toString()}`,
        { method: "GET" },
        signal,
      );
      const page = body.EmailIdentities;
      if (page !== undefined && !Array.isArray(page)) {
        throw new Error("SES identities response is invalid");
      }
      for (const value of page ?? []) {
        const identity = record(value);
        const name = optionalString(identity.IdentityName);
        if (name === null) throw new Error("SES identity response is invalid");
        identities.push({
          name,
          type: optionalString(identity.IdentityType),
          verificationStatus: optionalString(identity.VerificationStatus),
          sendingEnabled: boolean(identity.SendingEnabled),
        });
      }
      nextToken = optionalString(body.NextToken);
      if (nextToken !== null) {
        if (seenTokens.has(nextToken) || seenTokens.size >= 999) {
          throw new Error("SES identity pagination is invalid");
        }
        seenTokens.add(nextToken);
      }
    } while (nextToken !== null);
    return identities;
  }

  async getIdentityHealth(
    identity: string,
    signal?: AbortSignal,
  ): Promise<SesIdentityHealth> {
    const name = bounded(identity, "SES identity", 320);
    const { body } = await this.request(
      `/v2/email/identities/${encodeURIComponent(name)}`,
      { method: "GET" },
      signal,
    );
    const dkim = record(body.DkimAttributes);
    const mailFrom = record(body.MailFromAttributes);
    return {
      name,
      type: optionalString(body.IdentityType),
      verifiedForSending: boolean(body.VerifiedForSendingStatus),
      feedbackForwarding: boolean(body.FeedbackForwardingStatus),
      dkim: {
        status: optionalString(dkim.Status),
        signingEnabled: boolean(dkim.SigningEnabled),
        signingAttributesOrigin: optionalString(dkim.SigningAttributesOrigin),
      },
      mailFrom: {
        domain: optionalString(mailFrom.MailFromDomain),
        status: optionalString(mailFrom.MailFromDomainStatus),
        behaviorOnError: optionalString(mailFrom.BehaviorOnMxFailure),
      },
    };
  }

  async getSuppressedDestination(
    email: string,
    signal?: AbortSignal,
  ): Promise<SesSuppression | null> {
    const normalized = bounded(
      email,
      "SES suppression email",
      254,
    ).toLowerCase();
    if (!emailPattern.test(normalized)) {
      throw new RangeError("SES suppression email is invalid");
    }
    try {
      const { body } = await this.request(
        `/v2/email/suppression/addresses/${encodeURIComponent(normalized)}`,
        { method: "GET" },
        signal,
      );
      const destination = record(body.SuppressedDestination);
      return {
        email: normalized,
        reason: optionalString(destination.Reason),
        lastUpdate: optionalString(destination.LastUpdateTime),
      };
    } catch (error) {
      if (error instanceof SesApiError && error.status === 404) return null;
      throw error;
    }
  }

  async send(
    message: EmailMessage,
    options: { signal: AbortSignal; idempotencyKey: string },
  ): Promise<EmailProviderReceipt> {
    if (!Array.isArray(message.to) || message.to.length < 1) {
      throw new RangeError("SES message requires at least one recipient");
    }
    if (message.to.length > 50) {
      throw new RangeError("SES message cannot exceed 50 recipients");
    }
    const idempotencyKey = bounded(
      options.idempotencyKey,
      "SES idempotency key",
      256,
    );
    if (!idempotencyKeyPattern.test(idempotencyKey)) {
      throw new RangeError("SES idempotency key is invalid");
    }

    for (const recipient of message.to) {
      const suppression = await this.getSuppressedDestination(
        recipient.email,
        options.signal,
      );
      if (suppression !== null) {
        const reported = suppression.reason?.toUpperCase();
        const reason =
          reported === "BOUNCE" || reported === "COMPLAINT"
            ? reported
            : "UNKNOWN";
        throw new EmailProviderTerminalError(`recipient_suppressed:${reason}`);
      }
    }

    const body: Record<string, unknown> = {
      Text: {
        Data: bodyText(message.text, "SES text body", 1_000_000),
        Charset: "UTF-8",
      },
    };
    if (message.html !== undefined) {
      body.Html = {
        Data: bodyText(message.html, "SES HTML body", 2_000_000),
        Charset: "UTF-8",
      };
    }
    const payload: Record<string, unknown> = {
      FromEmailAddress: this.from,
      Destination: { ToAddresses: message.to.map(recipientAddress) },
      Content: {
        Simple: {
          Subject: {
            Data: bounded(message.subject, "SES subject", 998),
            Charset: "UTF-8",
          },
          Body: body,
          Headers: [
            { Name: "X-Ezacto-Idempotency-Key", Value: idempotencyKey },
          ],
        },
      },
      EmailTags: [{ Name: "ezacto_idempotency_key", Value: idempotencyKey }],
    };
    if (this.configurationSet !== null) {
      payload.ConfigurationSetName = this.configurationSet;
    }
    const {
      body: response,
      requestId,
      latencyMs,
    } = await this.request(
      "/v2/email/outbound-emails",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      options.signal,
    );
    const messageId = optionalString(response.MessageId);
    if (messageId === null || requestId === null) {
      throw new Error("SES send receipt is incomplete");
    }
    return { messageId, requestId, latencyMs };
  }
}
