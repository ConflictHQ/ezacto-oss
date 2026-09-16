import type {
  EmailAttachment,
  EmailMessage,
  EmailProviderReceipt,
  EmailRecipient,
  HttpEmailProvider,
} from "./index.js";
import { formatAddress } from "./address.js";

export interface MailgunConfig {
  apiKey: string;
  domain: string;
  region?: "us" | "eu";
}

export interface MailgunOptions {
  fetch?: (request: Request) => Promise<Response>;
  monotonicNow?: () => number;
}

interface MailgunResponse {
  body: Record<string, unknown>;
  latencyMs: number;
}

class MailgunApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Mailgun request failed with status ${status}`);
    this.name = "MailgunApiError";
    this.status = status;
  }
}

const domainPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const idempotencyKeyPattern = /^[A-Za-z0-9_-]+$/;
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

const recipientAddress = (recipient: EmailRecipient): string => {
  const email = bounded(
    recipient.email,
    "Mailgun recipient email",
    254,
  ).toLowerCase();
  if (!emailPattern.test(email))
    throw new RangeError("Mailgun recipient email is invalid");
  if (recipient.name === undefined) return email;
  const name = bounded(recipient.name, "Mailgun recipient name", 200);
  // #738. The name is arbitrary user text; unquoted, a comma in it splits one
  // recipient into two and an angle bracket moves the mailbox.
  return formatAddress(email, name);
};

const safeLatency = (started: number, completed: number): number => {
  const latency = Math.round(completed - started);
  if (!Number.isSafeInteger(latency) || latency < 0 || latency > 3_000_000) {
    throw new RangeError("Mailgun monotonic clock returned an invalid latency");
  }
  return latency;
};

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const parseBody = (text: string): Record<string, unknown> => {
  if (text.length === 0) return {};
  if (text.length > responseLimit)
    throw new Error("Mailgun response exceeded size limit");
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const attachmentSizeLimit = 25 * 1024 * 1024;
const forbiddenFilenameCharacters = new Set([
  "/", "\\", ":", "*", "?", '"', "<", ">", "|",
]);

/**
 * The filename reaches the recipient's filesystem, so it is checked rather than
 * trusted: a path separator in it is how a saved attachment lands somewhere the
 * person did not choose.
 */
const attachmentFilename = (value: string, index: number): string => {
  const filename = bounded(value, `Mailgun attachment ${index} filename`, 255);
  for (const character of filename) {
    if (forbiddenFilenameCharacters.has(character)) {
      throw new RangeError(`Mailgun attachment ${index} filename is invalid`);
    }
  }
  if (filename === "." || filename === "..") {
    throw new RangeError(`Mailgun attachment ${index} filename is invalid`);
  }
  return filename;
};

const attachmentBlob = (attachment: EmailAttachment, index: number): Blob => {
  const contentType = bounded(
    attachment.contentType,
    `Mailgun attachment ${index} content type`,
    255,
  );
  if (!(attachment.content instanceof Uint8Array)) {
    throw new TypeError(`Mailgun attachment ${index} content must be bytes`);
  }
  if (attachment.content.byteLength === 0) {
    throw new RangeError(`Mailgun attachment ${index} is empty`);
  }
  if (attachment.content.byteLength > attachmentSizeLimit) {
    throw new RangeError(`Mailgun attachment ${index} exceeds the size limit`);
  }
  return new Blob([attachment.content as BlobPart], { type: contentType });
};

const baseUrl = (region: "us" | "eu"): string =>
  region === "eu"
    ? "https://api.eu.mailgun.net"
    : "https://api.mailgun.net";

/** Workers-compatible Mailgun v3 HTTP provider behind the shared email seam. */
export class MailgunMailer implements HttpEmailProvider {
  readonly name = "mailgun";
  readonly domain: string;
  readonly region: "us" | "eu";

  private readonly authorization: string;
  private readonly fetchImplementation: (request: Request) => Promise<Response>;
  private readonly monotonicNow: () => number;
  private readonly endpoint: string;

  constructor(config: MailgunConfig, options: MailgunOptions = {}) {
    const apiKey = secret(config.apiKey, "Mailgun API key", 512);
    const domain = bounded(config.domain, "Mailgun domain", 253).toLowerCase();
    if (!domainPattern.test(domain))
      throw new RangeError("Mailgun domain is invalid");
    const region = config.region ?? "us";
    if (region !== "us" && region !== "eu")
      throw new RangeError("Mailgun region must be 'us' or 'eu'");

    this.domain = domain;
    this.region = region;
    this.authorization = `Basic ${btoa(`api:${apiKey}`)}`;
    this.fetchImplementation =
      options.fetch ?? (async (request) => globalThis.fetch(request));
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.endpoint = `${baseUrl(region)}/v3/${encodeURIComponent(domain)}/messages`;
  }

  /**
   * Mailgun takes attachments only as multipart, so a message carrying one is
   * posted differently from one that does not. Form encoding stays the path for
   * everything else rather than sending every message as multipart, because the
   * simpler encoding is the one nearly every send uses.
   */
  private async request(
    body: URLSearchParams | FormData,
    signal?: AbortSignal,
  ): Promise<MailgunResponse> {
    const started = this.monotonicNow();
    const multipart = body instanceof FormData;
    const request = new Request(this.endpoint, {
      method: "POST",
      headers: {
        authorization: this.authorization,
        // Left unset for multipart: `fetch` writes it itself, with the boundary,
        // and a hand-written one without a boundary makes the body unparseable.
        ...(multipart
          ? {}
          : { "content-type": "application/x-www-form-urlencoded" }),
      },
      body: multipart ? body : body.toString(),
      ...(signal === undefined ? {} : { signal }),
    });
    const response = await this.fetchImplementation(request);
    const latencyMs = safeLatency(started, this.monotonicNow());
    const parsed = parseBody(await response.text());
    if (!response.ok) throw new MailgunApiError(response.status);
    return { body: parsed, latencyMs };
  }

  async send(
    message: EmailMessage,
    options: { signal: AbortSignal; idempotencyKey: string },
  ): Promise<EmailProviderReceipt> {
    if (!Array.isArray(message.to) || message.to.length < 1) {
      throw new RangeError("Mailgun message requires at least one recipient");
    }
    if (message.to.length > 1_000) {
      throw new RangeError("Mailgun message cannot exceed 1000 recipients");
    }
    const idempotencyKey = bounded(
      options.idempotencyKey,
      "Mailgun idempotency key",
      256,
    );
    if (!idempotencyKeyPattern.test(idempotencyKey)) {
      throw new RangeError("Mailgun idempotency key is invalid");
    }

    const params = new URLSearchParams();
    params.set("from", recipientAddress(message.from));
    for (const recipient of message.to) {
      params.append("to", recipientAddress(recipient));
    }
    if (message.replyTo !== undefined) {
      for (const recipient of message.replyTo) {
        params.append("h:Reply-To", recipientAddress(recipient));
      }
    }
    params.set("subject", bounded(message.subject, "Mailgun subject", 998));
    params.set("text", bodyText(message.text, "Mailgun text body", 1_000_000));
    if (message.html !== undefined) {
      params.set(
        "html",
        bodyText(message.html, "Mailgun HTML body", 2_000_000),
      );
    }
    params.set("h:X-Ezacto-Idempotency-Key", idempotencyKey);
    params.set("o:tag", `ezacto_idempotency_key:${idempotencyKey}`);

    // Validated before the first byte is sent, so a bad filename or an empty
    // file is a refusal rather than a half-built request Mailgun rejects.
    const attachments = message.attachments ?? [];
    if (attachments.length > 10) {
      throw new RangeError("Mailgun message cannot exceed 10 attachments");
    }
    const parts = attachments.map((attachment, index) => ({
      filename: attachmentFilename(attachment.filename, index),
      blob: attachmentBlob(attachment, index),
    }));
    const total = parts.reduce((sum, part) => sum + part.blob.size, 0);
    if (total > attachmentSizeLimit) {
      throw new RangeError("Mailgun attachments exceed the combined size limit");
    }

    let body: URLSearchParams | FormData = params;
    if (parts.length > 0) {
      const form = new FormData();
      for (const [key, value] of params) form.append(key, value);
      for (const part of parts) form.append("attachment", part.blob, part.filename);
      body = form;
    }

    const { body: parsed, latencyMs } = await this.request(body, options.signal);
    const rawId = optionalString(parsed.id);
    if (rawId === null) {
      throw new Error("Mailgun send receipt is incomplete");
    }
    // Mailgun returns message ids wrapped in angle brackets: <id@domain>
    const messageId = rawId.replace(/^<|>$/g, "");
    return { messageId, latencyMs };
  }
}
