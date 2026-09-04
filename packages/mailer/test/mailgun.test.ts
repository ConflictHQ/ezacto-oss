import { describe, expect, it, vi } from "vitest";
import { MailgunMailer, type MailgunConfig } from "../src/mailgun.js";

const config: MailgunConfig = {
  apiKey: "key-test-00000000deadbeef00000000",
  domain: "mail.example.test",
  region: "us",
};

const message = {
  from: { email: "notify@example.test", name: "Ezacto" },
  to: [{ email: "owner@example.test", name: "Avery" }],
  template: "verify_email",
  subject: "Verify your ezacto email",
  text: "Open the one-time verification link.\n\nThis link expires.",
  html: "<p>Open the link.</p>\n<p>This link expires.</p>",
};

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

describe("Mailgun HTTP provider", () => {
  it("[unit] sends a form-encoded POST to the Mailgun v3 messages endpoint and returns a durable receipt", async () => {
    const requests: Request[] = [];
    const ticks = [100, 107];
    const provider = new MailgunMailer(config, {
      monotonicNow: () => ticks.shift()!,
      fetch: async (request) => {
        requests.push(request.clone());
        return response({
          id: "<20260828120000.abc123@mail.example.test>",
          message: "Queued. Thank you.",
        });
      },
    });

    await expect(
      provider.send(message, {
        signal: new AbortController().signal,
        idempotencyKey: "ezacto-email-7",
      }),
    ).resolves.toEqual({
      messageId: "20260828120000.abc123@mail.example.test",
      latencyMs: 7,
    });

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "https://api.mailgun.net/v3/mail.example.test/messages",
    );
    expect(request.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(request.headers.get("authorization")).toBe(
      `Basic ${btoa("api:key-test-00000000deadbeef00000000")}`,
    );

    const body = new URLSearchParams(await request.text());
    expect(body.get("from")).toBe("Ezacto <notify@example.test>");
    expect(body.get("to")).toBe("Avery <owner@example.test>");
    expect(body.get("subject")).toBe("Verify your ezacto email");
    expect(body.get("text")).toBe(
      "Open the one-time verification link.\n\nThis link expires.",
    );
    expect(body.get("html")).toBe(
      "<p>Open the link.</p>\n<p>This link expires.</p>",
    );
    expect(body.get("h:X-Ezacto-Idempotency-Key")).toBe("ezacto-email-7");
    expect(body.get("o:tag")).toBe(
      "ezacto_idempotency_key:ezacto-email-7",
    );
  });

  it("[unit] strips angle brackets from the Mailgun message id", async () => {
    const provider = new MailgunMailer(config, {
      monotonicNow: () => 0,
      fetch: async () =>
        response({ id: "<raw-id@mail.example.test>", message: "Queued." }),
    });

    const receipt = await provider.send(message, {
      signal: new AbortController().signal,
      idempotencyKey: "ezacto-email-1",
    });
    expect(receipt.messageId).toBe("raw-id@mail.example.test");
  });

  it("[unit] uses the EU endpoint when configured for the EU region", async () => {
    const requests: Request[] = [];
    const provider = new MailgunMailer(
      { ...config, region: "eu" },
      {
        monotonicNow: () => 0,
        fetch: async (request) => {
          requests.push(request.clone());
          return response({ id: "<eu-id@mail.example.test>" });
        },
      },
    );

    await provider.send(message, {
      signal: new AbortController().signal,
      idempotencyKey: "ezacto-email-2",
    });
    expect(requests[0]!.url).toBe(
      "https://api.eu.mailgun.net/v3/mail.example.test/messages",
    );
    expect(provider.region).toBe("eu");
  });

  it("[unit] defaults to the US region when none is specified", () => {
    const provider = new MailgunMailer({
      apiKey: "key-test",
      domain: "example.test",
    });
    expect(provider.region).toBe("us");
  });

  it("[unit] throws on an API error status without leaking the response body", async () => {
    const fetch = vi.fn(async () =>
      response({ message: "Forbidden — secret detail" }, 403),
    );
    const provider = new MailgunMailer(config, { fetch });

    await expect(
      provider.send(message, {
        signal: new AbortController().signal,
        idempotencyKey: "ezacto-email-3",
      }),
    ).rejects.toMatchObject({
      name: "MailgunApiError",
      status: 403,
      message: "Mailgun request failed with status 403",
    });
  });

  it("[unit] throws when the Mailgun response is missing a message id", async () => {
    const provider = new MailgunMailer(config, {
      fetch: async () => response({ message: "Queued." }),
    });

    await expect(
      provider.send(message, {
        signal: new AbortController().signal,
        idempotencyKey: "ezacto-email-4",
      }),
    ).rejects.toThrow("Mailgun send receipt is incomplete");
  });

  it("[unit] sends reply-to headers when the message includes replyTo", async () => {
    const requests: Request[] = [];
    const provider = new MailgunMailer(config, {
      monotonicNow: () => 0,
      fetch: async (request) => {
        requests.push(request.clone());
        return response({ id: "<reply-id@mail.example.test>" });
      },
    });

    await provider.send(
      { ...message, replyTo: [{ email: "support@example.test" }] },
      {
        signal: new AbortController().signal,
        idempotencyKey: "ezacto-email-5",
      },
    );

    const body = new URLSearchParams(await requests[0]!.text());
    expect(body.get("h:Reply-To")).toBe("support@example.test");
  });

  it("[unit] sends text-only messages without an html field", async () => {
    const requests: Request[] = [];
    const provider = new MailgunMailer(config, {
      monotonicNow: () => 0,
      fetch: async (request) => {
        requests.push(request.clone());
        return response({ id: "<text-id@mail.example.test>" });
      },
    });

    const textOnly = { ...message };
    delete (textOnly as Record<string, unknown>).html;
    await provider.send(textOnly, {
      signal: new AbortController().signal,
      idempotencyKey: "ezacto-email-6",
    });

    const body = new URLSearchParams(await requests[0]!.text());
    expect(body.get("text")).toBe(message.text);
    expect(body.has("html")).toBe(false);
  });

  it("[unit] never leaks the API key into the request URL or non-auth headers", async () => {
    const requests: Request[] = [];
    const provider = new MailgunMailer(config, {
      monotonicNow: () => 0,
      fetch: async (request) => {
        requests.push(request.clone());
        return response({ id: "<safe-id@mail.example.test>" });
      },
    });

    await provider.send(message, {
      signal: new AbortController().signal,
      idempotencyKey: "ezacto-email-8",
    });

    const request = requests[0]!;
    expect(request.url).not.toContain(config.apiKey);
    const body = await request.text();
    expect(body).not.toContain(config.apiKey);
  });

  it("[unit] rejects domain-shaping input before any network request", () => {
    for (const domain of [
      "https://attacker.test",
      ".leading-dot.test",
      "-leading-hyphen.test",
      "no-tld",
    ]) {
      expect(() => new MailgunMailer({ ...config, domain })).toThrow(
        "Mailgun domain is invalid",
      );
    }
    expect(
      () => new MailgunMailer({ ...config, apiKey: "" }),
    ).toThrow("Mailgun API key is invalid");
    expect(
      () => new MailgunMailer({ ...config, apiKey: "  " }),
    ).toThrow("Mailgun API key is invalid");
  });

  it("[unit] implements the HttpEmailProvider interface expected by the delivery seam", () => {
    const provider = new MailgunMailer(config);
    expect(provider.name).toBe("mailgun");
    expect(typeof provider.send).toBe("function");
  });
});
