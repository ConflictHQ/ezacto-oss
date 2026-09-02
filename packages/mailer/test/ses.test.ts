import { describe, expect, it, vi } from "vitest";
import { SesMailer, type SesMailerConfig } from "../src/index.js";

const config: SesMailerConfig = {
  accessKeyId: "TESTACCESSKEY",
  secretAccessKey: "test-secret-key",
  region: "us-west-2",
  from: "Ezacto <notify@example.test>",
  configurationSet: "ezacto-events",
};

const message = {
  from: { email: "billing@example.test", name: "Billing" },
  replyTo: [{ email: "accounts@example.test", name: "Accounts" }],
  to: [{ email: "owner@example.test", name: "Avery" }],
  template: "verify_email",
  subject: "Verify your ezacto email",
  text: "Open the one-time verification link.\n\nThis link expires.",
  html: "<p>Open the link.</p>\n<p>This link expires.</p>",
};

const response = (
  body: unknown,
  status = 200,
  requestId = "request-1",
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "x-amzn-requestid": requestId },
  });

describe("SES HTTP provider", () => {
  it("[unit] signs deterministic same-origin SES v2 requests and returns a durable receipt", async () => {
    const requests: Request[] = [];
    const ticks = [100, 103, 200, 207];
    const provider = new SesMailer(config, {
      now: () => new Date("2026-08-28T12:34:56.000Z"),
      monotonicNow: () => ticks.shift()!,
      fetch: async (request) => {
        requests.push(request.clone());
        return request.method === "GET"
          ? response({}, 404, "suppression-request")
          : response({ MessageId: "ses-message-7" }, 200, "send-request");
      },
    });

    await expect(
      provider.send(message, {
        signal: new AbortController().signal,
        idempotencyKey: "ezacto-email-7",
      }),
    ).resolves.toEqual({
      messageId: "ses-message-7",
      requestId: "send-request",
      latencyMs: 7,
    });

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      [
        "GET",
        "https://email.us-west-2.amazonaws.com/v2/email/suppression/addresses/owner%40example.test",
      ],
      [
        "POST",
        "https://email.us-west-2.amazonaws.com/v2/email/outbound-emails",
      ],
    ]);
    expect(requests[0]!.headers.get("authorization")).toBe(
      "AWS4-HMAC-SHA256 Credential=TESTACCESSKEY/20260828/us-west-2/ses/aws4_request, SignedHeaders=host;x-amz-date, Signature=c0be361bfff9faf4c0c70ebed1e86bcba232444654400f84e8cf65843f2d6800",
    );
    expect(requests[1]!.headers.get("authorization")).toBe(
      "AWS4-HMAC-SHA256 Credential=TESTACCESSKEY/20260828/us-west-2/ses/aws4_request, SignedHeaders=host;x-amz-date, Signature=c6c6928193ffc6667aeda4adcecc10bdcfc1a3fd8ed237aeedd56c831f465a4e",
    );
    expect(
      requests.map((request) => request.headers.get("x-amz-date")),
    ).toEqual(["20260828T123456Z", "20260828T123456Z"]);
    await expect(requests[1]!.text()).resolves.toBe(
      JSON.stringify({
        FromEmailAddress: "Billing <billing@example.test>",
        Destination: { ToAddresses: ["Avery <owner@example.test>"] },
        Content: {
          Simple: {
            Subject: {
              Data: "Verify your ezacto email",
              Charset: "UTF-8",
            },
            Body: {
              Text: {
                Data: "Open the one-time verification link.\n\nThis link expires.",
                Charset: "UTF-8",
              },
              Html: {
                Data: "<p>Open the link.</p>\n<p>This link expires.</p>",
                Charset: "UTF-8",
              },
            },
            Headers: [
              {
                Name: "X-Ezacto-Idempotency-Key",
                Value: "ezacto-email-7",
              },
            ],
          },
        },
        EmailTags: [
          { Name: "ezacto_idempotency_key", Value: "ezacto-email-7" },
        ],
        ReplyToAddresses: ["Accounts <accounts@example.test>"],
        ConfigurationSetName: "ezacto-events",
      }),
    );
    expect(
      JSON.stringify(requests.map((request) => [...request.headers])),
    ).not.toContain(config.secretAccessKey);
  });

  it("[unit] checks suppression first and rejects a suppressed recipient terminally", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe("GET");
      return response(
        {
          SuppressedDestination: {
            EmailAddress: "owner@example.test",
            Reason: "BOUNCE",
            LastUpdateTime: "2026-08-27T12:00:00Z",
          },
        },
        200,
        "suppression-request",
      );
    });
    const provider = new SesMailer(config, { fetch });

    const rejected = provider.send(message, {
      signal: new AbortController().signal,
      idempotencyKey: "ezacto-email-7",
    });
    await expect(rejected).rejects.toMatchObject({
      name: "EmailProviderTerminalError",
      reason: "recipient_suppressed:BOUNCE",
      message: "email provider rejected delivery permanently",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]![0].url).toContain(
      "/v2/email/suppression/addresses/",
    );
  });

  it("[unit] exposes account, identity, DKIM, and MAIL FROM health through signed APIs", async () => {
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v2/email/account") {
        return response({
          ProductionAccessEnabled: false,
          SendingEnabled: true,
          EnforcementStatus: "HEALTHY",
          SendQuota: {
            Max24HourSend: 200,
            MaxSendRate: 1,
            SentLast24Hours: 4,
          },
        });
      }
      if (url.pathname === "/v2/email/identities") {
        return response({
          EmailIdentities: [
            {
              IdentityName: "example.test",
              IdentityType: "DOMAIN",
              VerificationStatus: "SUCCESS",
              SendingEnabled: true,
            },
          ],
        });
      }
      return response({
        IdentityType: "DOMAIN",
        VerifiedForSendingStatus: true,
        FeedbackForwardingStatus: false,
        DkimAttributes: {
          Status: "SUCCESS",
          SigningEnabled: true,
          SigningAttributesOrigin: "AWS_SES",
        },
        MailFromAttributes: {
          MailFromDomain: "mail.example.test",
          MailFromDomainStatus: "SUCCESS",
          BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
        },
      });
    });
    const provider = new SesMailer(config, { fetch });

    await expect(provider.getAccountHealth()).resolves.toMatchObject({
      productionAccess: false,
      sandbox: true,
      sendingEnabled: true,
      enforcementStatus: "HEALTHY",
      max24HourSend: 200,
      region: "us-west-2",
      configurationSet: "ezacto-events",
    });
    await expect(provider.listIdentities()).resolves.toEqual([
      {
        name: "example.test",
        type: "DOMAIN",
        verificationStatus: "SUCCESS",
        sendingEnabled: true,
      },
    ]);
    await expect(
      provider.getIdentityHealth("example.test"),
    ).resolves.toMatchObject({
      verifiedForSending: true,
      dkim: { status: "SUCCESS", signingEnabled: true },
      mailFrom: { domain: "mail.example.test", status: "SUCCESS" },
    });
    for (const [request] of fetch.mock.calls) {
      expect(new URL(request.url).origin).toBe(
        "https://email.us-west-2.amazonaws.com",
      );
      expect(request.headers.get("authorization")).toContain(
        "/ses/aws4_request",
      );
    }
  });

  it("[unit] rejects endpoint-shaping input before any network request", () => {
    for (const region of [
      "https://attacker.test",
      "us-west-2.attacker.test",
      "us_west_2",
    ]) {
      expect(() => new SesMailer({ ...config, region })).toThrow(
        "SES region is invalid",
      );
    }
    expect(
      () =>
        new SesMailer({ ...config, configurationSet: "events?next=attacker" }),
    ).toThrow("SES configuration set is invalid");
  });
});
