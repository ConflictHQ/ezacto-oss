import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createWiseRuntime, type WiseDeliveryPort } from "../src/wise/runtime.js";
import { WISE_SANDBOX_WEBHOOK_PUBLIC_KEY } from "../src/wise/webhook.js";

/**
 * Issue 543. One delivery, start to finish: verify, parse, claim, act.
 *
 * The order is the correctness. Verifying last parses a forged body; claiming
 * last lets two concurrent retries both act, and settling a payout twice is the
 * failure the transfer log exists to prevent.
 *
 * The body and signature are Wise's own, from their published verification
 * example, so what is exercised here is the real wire shape rather than one
 * these tests invented.
 */

const NOW = new Date("2026-09-13T12:00:00.000Z");

const SIGNED_BODY =
  '{"data":{"resource":{"id":49983981,"profile_id":16055450,"account_id":14124090,"type":"transfer"},"current_state":"incoming_payment_waiting","previous_state":null,"occurred_at":"2021-08-23T10:12:50Z"},"subscription_id":"90aa8e14-4ef1-4a56-861c-f3c9cde097ea","event_type":"transfers#state-change","schema_version":"2.0.0","sent_at":"2021-08-23T10:12:50Z"}';

const SIGNATURE =
  "wKcKCYXAzxNgiu7xmoDm943NUni7Rz33QN8JkEA9dWSGebgndonabgSj18Y4C08OrwVmueGsED2s00M7DtJVcYKOS1i3G4TMVx+mgM3aL9djMBkQtiYNBFUd6wrPI7ZUNHv/TrlKSjTMc+6JFvUvJ7owY3z85e3I4jLRLJowMFvO8kvCJ60+1pY9wDwZvtZ//WS93LrwGjk9Dvwzpmu0w+P4J75tETT5qC3Uv0y5G2yO8SEoO3yNP/tg/BOli02niHb53vEOUWUb9bly6thnfMoXoiV/osoGxgF20R58RlvkAmezyyl1Sv542TfS2DpiwVnmjjjkCyXeSUcKookYLQ==";

/**
 * A body in a state we act on, signed here rather than by Wise.
 *
 * Wise's published example is `incoming_payment_waiting`, which is deliberately
 * not final, so exercising settlement needs a body they never signed. Signing
 * it with a key this test generates keeps the verification real -- the runtime
 * is given that key as its configured public key, and nothing is stubbed out.
 */
const signedWith = async (body: string) => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const base64 = btoa(String.fromCharCode(...der));
  const pem = `-----BEGIN PUBLIC KEY-----\n${(base64.match(/.{1,64}/gu) ?? []).join("\n")}\n-----END PUBLIC KEY-----`;
  const sign = async (payload: string) =>
    btoa(
      String.fromCharCode(
        ...new Uint8Array(
          await crypto.subtle.sign(
            "RSASSA-PKCS1-v1_5",
            pair.privateKey,
            new TextEncoder().encode(payload),
          ),
        ),
      ),
    );
  return { pem, signature: await sign(body), sign };
};

const transferBody = (state: string, id = "49983981") =>
  `{"data":{"resource":{"id":${id},"profile_id":16055450,"type":"transfer"},"current_state":"${state}","previous_state":"processing","occurred_at":"2026-09-13T10:00:00Z"},"subscription_id":"sub-1","event_type":"transfers#state-change","schema_version":"2.0.0","sent_at":"2026-09-13T10:00:01Z"}`;

const port = (overrides: Partial<WiseDeliveryPort> = {}): WiseDeliveryPort => ({
  process: vi.fn(async () => undefined),
  ...overrides,
})

const runtime = (
  parts: { deliveries?: WiseDeliveryPort; publicKey?: string; environment?: string } = {},
) => {
  const deliveries = parts.deliveries ?? port();
  return {
    deliveries,
    wise: createWiseRuntime({
      config: {
        token: "token-value",
        profileId: undefined,
        webhookPublicKey: parts.publicKey ?? WISE_SANDBOX_WEBHOOK_PUBLIC_KEY,
      },
      accounts: {
        listForUser: vi.fn(async () => []),
        listForProvider: vi.fn(async () => []),
  awaitingDestination: vi.fn(async () => []),
        link: vi.fn(async () => ({ outcome: "unknown_user" as const })),
        markVerified: vi.fn(async () => undefined),
        detach: vi.fn(async () => false),
      },
      deliveries,
      now: () => NOW,
    }),
  };
};

const deliver = (
  wise: ReturnType<typeof runtime>["wise"],
  input: { payload: string; signature: string | null; deliveryId?: string | null; isTest?: boolean },
) =>
  wise.webhook!.receiveWebhook({
    payload: input.payload,
    signature: input.signature,
    // `??` here would swallow an explicit null, which is the case one test is
    // specifically about.
    deliveryId: "deliveryId" in input ? input.deliveryId! : "delivery-1",
    isTest: input.isTest ?? false,
  });

const payloadIdentity = (body: string) =>
  `wise-body-sha256:${createHash("sha256").update(body).digest("hex")}`;

describe("a signed delivery (#543)", () => {
  it("[money] accepts Wise's own, and records what it said", async () => {
    const { wise, deliveries } = runtime();
    expect(await deliver(wise, { payload: SIGNED_BODY, signature: SIGNATURE })).toEqual({
      accepted: true,
    });
    expect(deliveries.process).toHaveBeenCalledWith({
      deliveryId: payloadIdentity(SIGNED_BODY),
      subscriptionId: "90aa8e14-4ef1-4a56-861c-f3c9cde097ea",
      eventType: "transfers#state-change",
      transferId: "49983981",
      currentState: "incoming_payment_waiting",
      occurredAt: "2021-08-23T10:12:50Z",
      now: "2026-09-13T12:00:00.000Z",
      outcome: null,
      skippedReason: "state incoming_payment_waiting is not final",
    });
  });

  it("[money] refuses an unsigned or wrongly signed delivery, and records nothing", async () => {
    const { wise, deliveries } = runtime();
    expect(await deliver(wise, { payload: SIGNED_BODY, signature: null })).toEqual({
      accepted: false,
    });
    expect(
      await deliver(wise, { payload: SIGNED_BODY.replace("49983981", "49983982"), signature: SIGNATURE }),
    ).toEqual({ accepted: false });
    // Nothing about a forged request reaches the ledger.
    expect(deliveries.process).not.toHaveBeenCalled();
  });

  it("[money] answers the subscription ping before the key is configured", async () => {
    // The deadlock the first version created: the route refused to exist
    // without the signing key, and the key comes from a webhook page you
    // cannot finish without an endpoint that answers. A deployment could never
    // get from one state to the other.
    const keyless = createWiseRuntime({
      config: { token: "t", profileId: undefined, webhookPublicKey: undefined },
      accounts: {
        listForUser: vi.fn(async () => []),
        listForProvider: vi.fn(async () => []),
  awaitingDestination: vi.fn(async () => []),
        link: vi.fn(async () => ({ outcome: "unknown_user" as const })),
        markVerified: vi.fn(async () => undefined),
        detach: vi.fn(async () => false),
      },
      deliveries: port(),
      now: () => NOW,
    });
    expect(keyless.webhook).toBeDefined();
    expect(
      await keyless.webhook!.receiveWebhook({
        payload: SIGNED_BODY,
        signature: null,
        deliveryId: null,
        isTest: true,
      }),
    ).toEqual({ accepted: true });
  });

  it("[money] still refuses a real delivery it cannot verify", async () => {
    // Answering the ping is safe because a test does nothing. Everything that
    // touches money stays behind the key.
    const deliveries = port();
    const keyless = createWiseRuntime({
      config: { token: "t", profileId: undefined, webhookPublicKey: undefined },
      accounts: {
        listForUser: vi.fn(async () => []),
        listForProvider: vi.fn(async () => []),
  awaitingDestination: vi.fn(async () => []),
        link: vi.fn(async () => ({ outcome: "unknown_user" as const })),
        markVerified: vi.fn(async () => undefined),
        detach: vi.fn(async () => false),
      },
      deliveries,
      now: () => NOW,
    });
    expect(
      await keyless.webhook!.receiveWebhook({
        payload: SIGNED_BODY,
        signature: SIGNATURE,
        deliveryId: "d-1",
        isTest: false,
      }),
    ).toEqual({ accepted: false });
    expect(deliveries.process).not.toHaveBeenCalled();
  });

  it("[money] has no webhook where deliveries cannot be recorded", async () => {
    // An unverifiable claim about money is not one to act on because a value
    // was missing, and a route that cannot verify is better not mounted.
    const bare = createWiseRuntime({
      config: { token: "t", profileId: undefined, webhookPublicKey: WISE_SANDBOX_WEBHOOK_PUBLIC_KEY },
      accounts: {
        listForUser: vi.fn(async () => []),
        listForProvider: vi.fn(async () => []),
  awaitingDestination: vi.fn(async () => []),
        link: vi.fn(async () => ({ outcome: "unknown_user" as const })),
        markVerified: vi.fn(async () => undefined),
        detach: vi.fn(async () => false),
      },
      now: () => NOW,
    });
    expect(bare.webhook).toBeUndefined();
  });

  it("[unit] accepts Wise's subscription ping without recording a fact about money", async () => {
    const { wise, deliveries } = runtime();
    expect(
      await deliver(wise, { payload: SIGNED_BODY, signature: SIGNATURE, isTest: true }),
    ).toEqual({ accepted: true });
    expect(deliveries.process).not.toHaveBeenCalled();
  });

  it("[money] still verifies the ping, so a subscription cannot be proved by a forgery", async () => {
    const { wise } = runtime();
    expect(
      await deliver(wise, { payload: SIGNED_BODY, signature: "bogus", isTest: true }),
    ).toEqual({ accepted: false });
  });
});

describe('processing a verified event atomically (#1202)', () => {
  it.each([
    ['outgoing_payment_sent', 'sent'],
    ['cancelled', 'failed'],
    ['funds_refunded', 'failed'],
    ['charged_back', 'failed'],
    ['bounced_back', 'failed'],
  ])('passes %s as the local %s outcome in one operation', async (state, outcome) => {
    const body = transferBody(state)
    const { pem, signature } = await signedWith(body)
    const { wise, deliveries } = runtime({ publicKey: pem })
    expect(await deliver(wise, { payload: body, signature })).toEqual({ accepted: true })
    expect(deliveries.process).toHaveBeenCalledTimes(1)
    expect(deliveries.process).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: payloadIdentity(body),
        transferId: '49983981',
        currentState: state,
        outcome,
        skippedReason: null,
      }),
    )
  })
  it('records in-flight and unsupported events without a settlement outcome', async () => {
    for (const [body, reason] of [
      [transferBody('processing'), 'state processing is not final'],
      [
        '{"data":{"amount":100,"currency":"USD","occurred_at":"2026-09-13T10:00:00Z"},"subscription_id":"sub-1","event_type":"balances#credit","sent_at":"2026-09-13T10:00:01Z"}',
        'event type balances#credit is not acted on',
      ],
    ] as const) {
      const { pem, signature } = await signedWith(body)
      const { wise, deliveries } = runtime({ publicKey: pem })
      await deliver(wise, { payload: body, signature })
      expect(deliveries.process).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: null, skippedReason: reason }),
      )
    }
  })
  it('passes each verified retry to the store under the same signed body identity', async () => {
    const body = transferBody('outgoing_payment_sent')
    const { pem, signature } = await signedWith(body)
    const { wise, deliveries } = runtime({ publicKey: pem })
    for (const deliveryId of ['first', 'changed', null])
      await deliver(wise, { payload: body, signature, deliveryId })
    expect(deliveries.process).toHaveBeenCalledTimes(3)
    for (const [input] of vi.mocked(deliveries.process).mock.calls)
      expect(input.deliveryId).toBe(payloadIdentity(body))
  })
  it('keeps different signed UTF-8 payloads distinct even with one unsigned header', async () => {
    const body = transferBody('outgoing_payment_sent').replace('"sub-1"', '"sub-☃"')
    const other = body.replace('☃', '\\u2603')
    const { pem, signature, sign } = await signedWith(body)
    const { wise, deliveries } = runtime({ publicKey: pem })
    await deliver(wise, { payload: body, signature, deliveryId: 'same' })
    await deliver(wise, { payload: other, signature: await sign(other), deliveryId: 'same' })
    expect(deliveries.process).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ deliveryId: payloadIdentity(body), subscriptionId: 'sub-☃' }),
    )
    expect(deliveries.process).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ deliveryId: payloadIdentity(other), subscriptionId: 'sub-☃' }),
    )
    expect(payloadIdentity(body)).not.toBe(payloadIdentity(other))
    expect(await deliver(wise, { payload: other, signature })).toEqual({ accepted: false })
    expect(deliveries.process).toHaveBeenCalledTimes(2)
  })
  it('does not acknowledge a local processing failure', async () => {
    const body = transferBody('outgoing_payment_sent')
    const { pem, signature } = await signedWith(body)
    const failure = new Error('local transaction failed')
    const { wise } = runtime({
      publicKey: pem,
      deliveries: port({
        process: vi.fn(async () => {
          throw failure
        }),
      }),
    })
    await expect(deliver(wise, { payload: body, signature })).rejects.toBe(failure)
  })
  it('accepts an unreadable signed body without inventing stored work', async () => {
    const body = 'not json at all'
    const { pem, signature } = await signedWith(body)
    const { wise, deliveries } = runtime({ publicKey: pem })
    expect(await deliver(wise, { payload: body, signature })).toEqual({ accepted: true })
    expect(deliveries.process).not.toHaveBeenCalled()
  })
})
