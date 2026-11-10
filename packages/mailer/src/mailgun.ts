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

/** Bound the provider evidence body while reading, not after allocation. */
const readEvidenceBody = async (response: Response, signal: AbortSignal): Promise<string> => {
  const length = response.headers.get("content-length");
  if (length !== null && /^\d+$/u.test(length) && Number(length) > responseLimit) {
    await response.body?.cancel();
    throw new Error("Mailgun evidence response exceeded size limit");
  }
  if (response.body === null) throw new Error("Mailgun evidence response is invalid");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let bytes = 0, result = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > responseLimit) {
        await reader.cancel();
        throw new Error("Mailgun evidence response exceeded size limit");
      }
      result += decoder.decode(part.value, { stream: true });
    }
    return result + decoder.decode();
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
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

  /** Follow only domain-scoped Mailgun event links and bound work and memory. */
  private async reminderEvidencePages(url: URL, signal: AbortSignal): Promise<{ items: unknown[]; complete: boolean }> {
    const items: unknown[] = [];
    const visited = new Set<string>();
    let current = url;
    for (let page = 0; page < 5; page += 1) {
      if (visited.has(current.href)) return { items, complete: false };
      visited.add(current.href);
      const response = await this.fetchImplementation(new Request(current, { method: 'GET',
        headers: { authorization: this.authorization }, redirect: 'error', signal }));
      if (!response.ok) throw new MailgunApiError(response.status);
      const body = parseBody(await readEvidenceBody(response, signal));
      if (!Array.isArray(body.items) || body.items.length > 100) throw new Error('Mailgun evidence response is invalid');
      items.push(...body.items);
      // Mailgun always provides next/previous links; only an empty page ends
      // a traversal. A short page may still have later conflicting evidence.
      if (body.items.length === 0) return { items, complete: true };
      const paging = body.paging && typeof body.paging === 'object' && !Array.isArray(body.paging) ? body.paging as Record<string, unknown> : null;
      if (typeof paging?.next !== 'string' || paging.next.length > 4096) return { items, complete: false };
      let next: URL;
      try { next = new URL(paging.next); } catch { return { items, complete: false }; }
      // Mailgun can encode its cursor in one path segment after /events.
      // Do not let that segment escape the domain-scoped events endpoint.
      let eventPath = next.pathname === url.pathname;
      if (next.pathname.startsWith(`${url.pathname}/`)) {
        const encoded = next.pathname.slice(url.pathname.length + 1);
        try {
          const cursor = decodeURIComponent(encoded);
          eventPath = cursor.length > 0 && cursor !== '.' && cursor !== '..' &&
            !/[\\/%]/u.test(cursor) && ![...cursor].some(character => {
              const code = character.codePointAt(0)!;
              return code < 32 || code === 127;
            });
        } catch { eventPath = false; }
      }
      if (next.origin !== url.origin || !eventPath || next.username || next.password || next.hash) {
        return { items, complete: false };
      }
      current = next;
    }
    return { items, complete: false };
  }

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

  /** Read one bounded page of authenticated provider events. A positive
   * match is an observation only; no match is not evidence of non-delivery. */
  async inspectReminderEvent(input: {
    deliveryId: number; attemptId: string; eventId: string; messageId: string; recipient: string;
    eventType: 'delivered' | 'failed' | 'complained'; begin: number; end: number; signal?: AbortSignal;
  }): Promise<boolean> {
    if (!Number.isSafeInteger(input.deliveryId) || input.deliveryId < 1 ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(input.attemptId) ||
        !Number.isSafeInteger(input.begin) || !Number.isSafeInteger(input.end) || input.end <= input.begin || input.end - input.begin > 86_400) {
      throw new TypeError('Mailgun reminder evidence scope is invalid');
    }
    const eventId = bounded(input.eventId, 'Mailgun event id', 255);
    const messageId = bounded(input.messageId, 'Mailgun message id', 512).replace(/^<|>$/gu, '');
    const recipient = bounded(input.recipient, 'Mailgun recipient', 254).toLowerCase();
    if (!messageId || !emailPattern.test(recipient) || !['delivered', 'failed', 'complained'].includes(input.eventType)) {
      throw new TypeError('Mailgun reminder evidence scope is invalid');
    }
    const key = `ezacto-reminder-${input.deliveryId}-${input.attemptId}`;
    const tag = `ezacto-reminder-${input.attemptId.slice(0, 2)}`;
    const url = new URL(`${baseUrl(this.region)}/v3/${encodeURIComponent(this.domain)}/events`);
    url.search = new URLSearchParams({ begin: String(input.begin), end: String(input.end), ascending: 'yes', limit: '100', tags: tag }).toString();
    const signal = input.signal === undefined ? AbortSignal.timeout(10_000) : AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]);
    const evidence = await this.reminderEvidencePages(url, signal);
    return evidence.items.some(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const item = value as Record<string, unknown>;
      const message = item.message && typeof item.message === 'object' && !Array.isArray(item.message) ? item.message as Record<string, unknown> : null;
      const headers = message?.headers && typeof message.headers === 'object' && !Array.isArray(message.headers) ? message.headers as Record<string, unknown> : null;
      const variables = item['user-variables'] && typeof item['user-variables'] === 'object' && !Array.isArray(item['user-variables']) ? item['user-variables'] as Record<string, unknown> : null;
      const flags = item.flags && typeof item.flags === 'object' && !Array.isArray(item.flags) ? item.flags as Record<string, unknown> : null;
      const rawId = typeof headers?.['message-id'] === 'string' ? headers['message-id'].replace(/^<|>$/gu, '') : null;
      return item.id === eventId && item.event === input.eventType &&
        (input.eventType !== 'failed' || item.severity === 'permanent') && flags?.['is-test-mode'] !== true && rawId === messageId &&
        typeof item.timestamp === 'number' && Number.isFinite(item.timestamp) && item.timestamp >= input.begin && item.timestamp <= input.end &&
        typeof item.recipient === 'string' && item.recipient.toLowerCase() === recipient &&
        Array.isArray(item.tags) && item.tags.includes(tag) && variables?.ezacto_idempotency_key === key;
    });
  }

  /**
   * Find positive provider evidence for an expired reminder claim without
   * relying on a webhook. A missing result (including a truncated page) says
   * nothing about whether Mailgun accepted the request.
   */
  async findReminderReceipt(input: {
    deliveryId: number; attemptId: string; recipients: readonly string[];
    begin: number; end: number; signal?: AbortSignal;
  }): Promise<{ messageId: string; feedback?: Array<{ eventId: string; recipient: string; type: 'failed' | 'complained' }> } | null> {
    if (!Number.isSafeInteger(input.deliveryId) || input.deliveryId < 1 ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(input.attemptId) ||
        !Number.isSafeInteger(input.begin) || !Number.isSafeInteger(input.end) ||
        input.end <= input.begin || input.end - input.begin > 86_400 ||
        !Array.isArray(input.recipients) || input.recipients.length < 1 || input.recipients.length > 1_000) {
      throw new TypeError('Mailgun reminder evidence scope is invalid');
    }
    const recipients = new Set(input.recipients.map(value => {
      const recipient = bounded(value, 'Mailgun recipient', 254).toLowerCase();
      if (!emailPattern.test(recipient)) throw new TypeError('Mailgun reminder evidence scope is invalid');
      return recipient;
    }));
    const key = `ezacto-reminder-${input.deliveryId}-${input.attemptId}`;
    const tag = `ezacto-reminder-${input.attemptId.slice(0, 2)}`;
    const url = new URL(`${baseUrl(this.region)}/v3/${encodeURIComponent(this.domain)}/events`);
    url.search = new URLSearchParams({ begin: String(input.begin), end: String(input.end), ascending: 'yes', limit: '100', tags: tag }).toString();
    const signal = input.signal === undefined ? AbortSignal.timeout(10_000) : AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]);
    const evidence = await this.reminderEvidencePages(url, signal);
    const messageIds = new Set<string>();
    let invalidTerminal = false;
    const feedback = new Map<string, { eventId: string; recipient: string; type: 'failed' | 'complained' }>();
    for (const value of evidence.items) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      const message = item.message && typeof item.message === 'object' && !Array.isArray(item.message) ? item.message as Record<string, unknown> : null;
      const headers = message?.headers && typeof message.headers === 'object' && !Array.isArray(message.headers) ? message.headers as Record<string, unknown> : null;
      const variables = item['user-variables'] && typeof item['user-variables'] === 'object' && !Array.isArray(item['user-variables']) ? item['user-variables'] as Record<string, unknown> : null;
      const flags = item.flags && typeof item.flags === 'object' && !Array.isArray(item.flags) ? item.flags as Record<string, unknown> : null;
      if (!['accepted', 'delivered', 'failed', 'complained'].includes(String(item.event)) ||
          (item.event === 'failed' && item.severity !== 'permanent') ||
          flags?.['is-test-mode'] === true ||
          typeof item.timestamp !== 'number' || !Number.isFinite(item.timestamp) || item.timestamp < input.begin || item.timestamp > input.end ||
          !Array.isArray(item.tags) || !item.tags.includes(tag) || variables?.ezacto_idempotency_key !== key) continue;
      const terminal = item.event === 'failed' || item.event === 'complained';
      if (typeof item.recipient !== 'string' || !recipients.has(item.recipient.toLowerCase()) || typeof headers?.['message-id'] !== 'string') {
        if (terminal) invalidTerminal = true;
        continue;
      }
      try {
        const messageId = bounded(headers['message-id'], 'Mailgun message id', 512).replace(/^<|>$/gu, '');
        if (messageId) {
          messageIds.add(messageId);
          if (terminal) {
            const eventId = bounded(item.id as string, 'Mailgun event id', 255);
            const observation = { eventId, recipient: item.recipient.toLowerCase(), type: item.event as 'failed' | 'complained' };
            const previous = feedback.get(eventId);
            if (previous && (previous.recipient !== observation.recipient || previous.type !== observation.type)) invalidTerminal = true;
            feedback.set(eventId, observation);
          }
        } else if (terminal) invalidTerminal = true;
      } catch { if (terminal) invalidTerminal = true; }
    }
    if (!evidence.complete || messageIds.size !== 1 || invalidTerminal || feedback.size > 100) return null;
    return { messageId: [...messageIds][0]!, ...(feedback.size ? { feedback: [...feedback.values()] } : {}) };
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
    // The cap is on everyone the message is delivered to, and a Cc recipient
    // is delivered to like any other.
    const cc = message.cc ?? [];
    if (message.to.length + cc.length > 1_000) {
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
    for (const recipient of cc) {
      params.append("cc", recipientAddress(recipient));
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
    const reminder = /^ezacto-reminder-[1-9][0-9]*-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u.exec(idempotencyKey);
    if (reminder) {
      // A bounded shard supports provider searches without creating one
      // permanent analytics tag per delivery. The exact attempt is metadata.
      params.set("o:tag", `ezacto-reminder-${reminder[1]!.slice(0, 2)}`);
      params.set("v:ezacto_idempotency_key", idempotencyKey);
    } else params.set("o:tag", `ezacto_idempotency_key:${idempotencyKey}`);

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
