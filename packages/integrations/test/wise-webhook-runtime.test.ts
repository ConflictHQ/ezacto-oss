import { describe, expect, it, vi } from "vitest";
import { createWiseRuntime, type WiseDeliveryPort } from "../src/wise/runtime.js";

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
  const signature = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(body)),
      ),
    ),
  );
  return { pem, signature };
};

const transferBody = (state: string, id = "49983981") =>
  `{"data":{"resource":{"id":${id},"profile_id":16055450,"type":"transfer"},"current_state":"${state}","previous_state":"processing","occurred_at":"2026-09-13T10:00:00Z"},"subscription_id":"sub-1","event_type":"transfers#state-change","schema_version":"2.0.0","sent_at":"2026-09-13T10:00:01Z"}`;

const port = (overrides: Partial<WiseDeliveryPort> = {}): WiseDeliveryPort => ({
  claim: vi.fn(async () => ({ claim: "fresh" as const })),
  finish: vi.fn(async () => undefined),
  settleTransfer: vi.fn(async (input: { transferId: string; outcome: "sent" | "failed" }) => ({
    settled: input.outcome,
    transferId: input.transferId,
  })),
  ...overrides,
});

const runtime = (
  parts: { deliveries?: WiseDeliveryPort; publicKey?: string; environment?: string } = {},
) => {
  const deliveries = parts.deliveries ?? port();
  return {
    deliveries,
    wise: createWiseRuntime({
      config: {
        clientId: "client-id",
        clientSecret: "client-secret",
        environment: parts.environment ?? "sandbox",
        appBaseUrl: "https://time.example.test",
        webhookPublicKey: parts.publicKey,
      },
      grants: {
        readCurrent: vi.fn(async () => null),
        beginAuthorization: vi.fn(async () => undefined),
        claimState: vi.fn(async () => ({ claim: "unknown" as const })),
        record: vi.fn(async () => ({ outcome: "unknown_user" as const })),
        revoke: vi.fn(async () => false),
      },
      accounts: {
        listForUser: vi.fn(async () => []),
        link: vi.fn(async () => ({ outcome: "unknown_user" as const })),
        markVerified: vi.fn(async () => undefined),
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

describe("a signed delivery (#543)", () => {
  it("[money] accepts Wise's own, and records what it said", async () => {
    const { wise, deliveries } = runtime();
    expect(await deliver(wise, { payload: SIGNED_BODY, signature: SIGNATURE })).toEqual({
      accepted: true,
    });
    expect(deliveries.claim).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      subscriptionId: "90aa8e14-4ef1-4a56-861c-f3c9cde097ea",
      eventType: "transfers#state-change",
      transferId: "49983981",
      currentState: "incoming_payment_waiting",
      occurredAt: "2021-08-23T10:12:50Z",
      now: "2026-09-13T12:00:00.000Z",
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
    expect(deliveries.claim).not.toHaveBeenCalled();
  });

  it("[money] refuses everything on live until the key is configured", async () => {
    // An unverifiable claim about money is not one to act on because a value
    // was missing from the deployment.
    const { wise, deliveries } = runtime({ environment: "live" });
    expect(await deliver(wise, { payload: SIGNED_BODY, signature: SIGNATURE })).toEqual({
      accepted: false,
    });
    expect(deliveries.claim).not.toHaveBeenCalled();
  });

  it("[unit] accepts Wise's subscription ping without recording a fact about money", async () => {
    const { wise, deliveries } = runtime();
    expect(
      await deliver(wise, { payload: SIGNED_BODY, signature: SIGNATURE, isTest: true }),
    ).toEqual({ accepted: true });
    expect(deliveries.claim).not.toHaveBeenCalled();
  });

  it("[money] still verifies the ping, so a subscription cannot be proved by a forgery", async () => {
    const { wise } = runtime();
    expect(
      await deliver(wise, { payload: SIGNED_BODY, signature: "bogus", isTest: true }),
    ).toEqual({ accepted: false });
  });
});

describe("settling a payout from a state change (#543)", () => {
  it("[money] settles as sent only on outgoing_payment_sent", async () => {
    const body = transferBody("outgoing_payment_sent");
    const { pem, signature } = await signedWith(body);
    const { wise, deliveries } = runtime({ publicKey: pem });
    await deliver(wise, { payload: body, signature });
    expect(deliveries.settleTransfer).toHaveBeenCalledWith({
      transferId: "49983981",
      outcome: "sent",
      failureReason: null,
      now: "2026-09-13T12:00:00.000Z",
    });
    expect(deliveries.finish).toHaveBeenCalledWith("delivery-1", "2026-09-13T12:00:00.000Z", null);
  });

  it("[money] settles as failed on each of Wise's reversals, saying which", async () => {
    for (const state of ["cancelled", "funds_refunded", "charged_back", "bounced_back"]) {
      const body = transferBody(state);
      const { pem, signature } = await signedWith(body);
      const { wise, deliveries } = runtime({ publicKey: pem });
      await deliver(wise, { payload: body, signature });
      expect(deliveries.settleTransfer, state).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "failed", failureReason: `wise reported ${state}` }),
      );
    }
  });

  it("[money] leaves a transfer in flight alone, and says why in the ledger", async () => {
    const body = transferBody("processing");
    const { pem, signature } = await signedWith(body);
    const { wise, deliveries } = runtime({ publicKey: pem });
    await deliver(wise, { payload: body, signature });
    // Marking money as moved while it is still reversible cannot be undone: the
    // log's sent rows are immutable.
    expect(deliveries.settleTransfer).not.toHaveBeenCalled();
    expect(deliveries.finish).toHaveBeenCalledWith(
      "delivery-1",
      "2026-09-13T12:00:00.000Z",
      "state processing is not final",
    );
  });

  it("[money] does nothing twice for a retried delivery", async () => {
    const body = transferBody("outgoing_payment_sent");
    const { pem, signature } = await signedWith(body);
    const { wise, deliveries } = runtime({
      publicKey: pem,
      deliveries: port({ claim: vi.fn(async () => ({ claim: "duplicate" as const })) }),
    });
    expect(await deliver(wise, { payload: body, signature })).toEqual({ accepted: true });
    // 2xx and no further work. Anything else and Wise keeps retrying something
    // already done.
    expect(deliveries.settleTransfer).not.toHaveBeenCalled();
  });

  it("[money] keys a delivery with no id on the event itself, so a retry still collides", async () => {
    const body = transferBody("outgoing_payment_sent");
    const { pem, signature } = await signedWith(body);
    const { wise, deliveries } = runtime({ publicKey: pem });
    await deliver(wise, { payload: body, signature, deliveryId: null });
    expect(deliveries.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "sub-1|transfers#state-change|49983981|outgoing_payment_sent|2026-09-13T10:00:00Z",
      }),
    );
  });

  it("[money] records why a settlement did not land rather than dropping it", async () => {
    const body = transferBody("outgoing_payment_sent");
    const { pem, signature } = await signedWith(body);
    const { wise, deliveries } = runtime({
      publicKey: pem,
      deliveries: port({
        settleTransfer: vi.fn(async () => ({
          settled: "none" as const,
          reason: "no matching payout transfer",
        })),
      }),
    });
    expect(await deliver(wise, { payload: body, signature })).toEqual({ accepted: true });
    expect(deliveries.finish).toHaveBeenCalledWith(
      "delivery-1",
      "2026-09-13T12:00:00.000Z",
      "no matching payout transfer",
    );
  });

  it("[unit] records an event type it does not act on, rather than discarding it", async () => {
    const body =
      '{"data":{"amount":100,"currency":"USD","occurred_at":"2026-09-13T10:00:00Z"},"subscription_id":"sub-1","event_type":"balances#credit","sent_at":"2026-09-13T10:00:01Z"}';
    const { pem, signature } = await signedWith(body);
    const { wise, deliveries } = runtime({ publicKey: pem });
    expect(await deliver(wise, { payload: body, signature })).toEqual({ accepted: true });
    // "We were told and chose not to act" is a different fact from "nothing
    // arrived", and inbound money is #101's seam rather than this one.
    expect(deliveries.finish).toHaveBeenCalledWith(
      "delivery-1",
      "2026-09-13T12:00:00.000Z",
      "event type balances#credit is not acted on",
    );
    expect(deliveries.settleTransfer).not.toHaveBeenCalled();
  });

  it("[unit] accepts a signed body it cannot read, because a retry will not read either", async () => {
    const body = "not json at all";
    const { pem, signature } = await signedWith(body);
    const { wise, deliveries } = runtime({ publicKey: pem });
    expect(await deliver(wise, { payload: body, signature })).toEqual({ accepted: true });
    expect(deliveries.claim).not.toHaveBeenCalled();
  });
});
