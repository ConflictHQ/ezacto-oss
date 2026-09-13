import { describe, expect, it } from "vitest";
import {
  WISE_SANDBOX_WEBHOOK_PUBLIC_KEY,
  parseWiseEvent,
  payoutOutcomeFor,
  publicKeyDer,
  verifyWiseSignature,
} from "../src/wise/webhook.js";

/**
 * Issue 543. Wise has no session with us, so the signature is the whole of the
 * authorisation for a request that carries a claim about money.
 *
 * The fixture below is Wise's own: the body, the signature and the key are
 * lifted verbatim from their published verification example. That matters more
 * than the number of assertions around it -- a hand-rolled fixture proves this
 * code agrees with itself, and four integration bugs have already shipped here
 * because the only test was a stub.
 */

const WISE_FIXTURE_BODY =
  '{"data":{"resource":{"id":49983981,"profile_id":16055450,"account_id":14124090,"type":"transfer"},"current_state":"incoming_payment_waiting","previous_state":null,"occurred_at":"2021-08-23T10:12:50Z"},"subscription_id":"90aa8e14-4ef1-4a56-861c-f3c9cde097ea","event_type":"transfers#state-change","schema_version":"2.0.0","sent_at":"2021-08-23T10:12:50Z"}';

const WISE_FIXTURE_SIGNATURE =
  "wKcKCYXAzxNgiu7xmoDm943NUni7Rz33QN8JkEA9dWSGebgndonabgSj18Y4C08OrwVmueGsED2s00M7DtJVcYKOS1i3G4TMVx+mgM3aL9djMBkQtiYNBFUd6wrPI7ZUNHv/TrlKSjTMc+6JFvUvJ7owY3z85e3I4jLRLJowMFvO8kvCJ60+1pY9wDwZvtZ//WS93LrwGjk9Dvwzpmu0w+P4J75tETT5qC3Uv0y5G2yO8SEoO3yNP/tg/BOli02niHb53vEOUWUb9bly6thnfMoXoiV/osoGxgF20R58RlvkAmezyyl1Sv542TfS2DpiwVnmjjjkCyXeSUcKookYLQ==";

const verify = (overrides: { body?: string; signature?: string | null; key?: string } = {}) =>
  verifyWiseSignature({
    body: overrides.body ?? WISE_FIXTURE_BODY,
    signature: overrides.signature === undefined ? WISE_FIXTURE_SIGNATURE : overrides.signature,
    publicKeyPem: overrides.key ?? WISE_SANDBOX_WEBHOOK_PUBLIC_KEY,
  });

describe("the signature, which is the whole authorisation (#543)", () => {
  it("[money] accepts Wise's own signed delivery", async () => {
    expect(await verify()).toBe(true);
  });

  it("[money] refuses the same signature over a tampered body", async () => {
    // One digit of the transfer id. Everything else about the request is
    // identical, which is the attack this exists to refuse.
    const tampered = WISE_FIXTURE_BODY.replace("49983981", "49983982");
    expect(await verify({ body: tampered })).toBe(false);
  });

  it("[money] refuses a body that differs only in insignificant whitespace", async () => {
    // The signature covers the raw bytes, so a body that parses to the same
    // object is still a different payload. This is why the route reads the
    // request as text and verifies before it parses: re-serialising first and
    // checking that would be checking something Wise never signed.
    const pretty = JSON.stringify(JSON.parse(WISE_FIXTURE_BODY), null, 2);
    expect(JSON.parse(pretty)).toEqual(JSON.parse(WISE_FIXTURE_BODY));
    expect(await verify({ body: pretty })).toBe(false);
    // A single trailing newline, which is what a proxy or an editor adds.
    expect(await verify({ body: `${WISE_FIXTURE_BODY}\n` })).toBe(false);
  });

  it("[money] refuses a missing, blank or unparseable signature rather than throwing", async () => {
    // A malformed header is what a forged request looks like, so it is a
    // refusal and not a 500.
    expect(await verify({ signature: null })).toBe(false);
    expect(await verify({ signature: "   " })).toBe(false);
    expect(await verify({ signature: "not base64 !!" })).toBe(false);
  });

  it("[money] refuses a signature made with a different key", async () => {
    // A valid RSA signature over this exact body, from a key that is not Wise's.
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const signed = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(WISE_FIXTURE_BODY),
    );
    const encoded = btoa(String.fromCharCode(...new Uint8Array(signed)));
    expect(await verify({ signature: encoded })).toBe(false);
  });

  it("[unit] refuses a key that is not a PEM rather than importing nothing", async () => {
    expect(await verify({ key: "clearly not a key" })).toBe(false);
    expect(() => publicKeyDer("clearly not a key")).toThrow(/not a PEM/u);
  });

  it("[unit] tolerates a PEM that came through an environment variable", async () => {
    // Pasted into a secret, a PEM arrives with whatever line endings the shell
    // gave it. A key that fails to import reads as a signature that did not
    // verify, which sends somebody looking in the wrong place entirely.
    const windows = WISE_SANDBOX_WEBHOOK_PUBLIC_KEY.replaceAll("\n", "\r\n");
    expect(await verify({ key: windows })).toBe(true);
    expect(await verify({ key: `  ${WISE_SANDBOX_WEBHOOK_PUBLIC_KEY}\n\n` })).toBe(true);
  });
});

describe("reading a delivery (#543)", () => {
  it("[money] reads Wise's own state change, ids as text", () => {
    expect(parseWiseEvent(WISE_FIXTURE_BODY)).toEqual({
      kind: "transfer_state",
      subscriptionId: "90aa8e14-4ef1-4a56-861c-f3c9cde097ea",
      transferId: "49983981",
      profileId: "16055450",
      currentState: "incoming_payment_waiting",
      previousState: null,
      occurredAt: "2021-08-23T10:12:50Z",
    });
  });

  it("[money] keeps a transfer id past 2^53 intact", () => {
    // Raw text, because a JS number literal would round it here and the test
    // would pass against code that also rounds. A rounded transfer id names
    // somebody else's payment.
    const body =
      '{"data":{"resource":{"id":9007199254740993,"type":"transfer"},"current_state":"outgoing_payment_sent"},"subscription_id":"s","event_type":"transfers#state-change","sent_at":"2026-09-13T12:00:00Z"}';
    expect(parseWiseEvent(body)).toMatchObject({ transferId: "9007199254740993" });
  });

  it("[money] records a state Wise has added since as unhandled, never guessed", () => {
    const body =
      '{"data":{"resource":{"id":1,"type":"transfer"},"current_state":"teleported","occurred_at":"2026-09-13T12:00:00Z"},"subscription_id":"s","event_type":"transfers#state-change"}';
    expect(parseWiseEvent(body)).toEqual({
      kind: "unhandled",
      subscriptionId: "s",
      eventType: "transfers#state-change",
      occurredAt: "2026-09-13T12:00:00Z",
    });
  });

  it("[unit] keeps the other subscribed event types as unhandled facts", () => {
    // Account deposits are inbound money -- #101's seam, opposite direction --
    // and transfer issues are a case to look at, not a state to write. Both are
    // recorded so "we were told and did not act" stays distinguishable from
    // "nothing arrived".
    for (const eventType of ["balances#credit", "transfers#active-cases"]) {
      const body = `{"data":{"occurred_at":"2026-09-13T12:00:00Z"},"subscription_id":"s","event_type":"${eventType}"}`;
      expect(parseWiseEvent(body)).toEqual({
        kind: "unhandled",
        subscriptionId: "s",
        eventType,
        occurredAt: "2026-09-13T12:00:00Z",
      });
    }
  });

  it("[unit] returns null for a body that is not an event at all", () => {
    expect(parseWiseEvent("not json")).toBeNull();
    expect(parseWiseEvent("{}")).toBeNull();
    expect(parseWiseEvent('{"event_type":""}')).toBeNull();
  });
});

describe("what a state means for a payout (#543)", () => {
  it("[money] settles only on the two that are final at Wise", () => {
    expect(payoutOutcomeFor("outgoing_payment_sent")).toBe("sent");
    for (const state of ["cancelled", "funds_refunded", "charged_back", "bounced_back"] as const) {
      expect(payoutOutcomeFor(state), state).toBe("failed");
    }
  });

  it("[money] leaves a transfer in flight alone", () => {
    // Writing 'sent' here would mark money as moved while it is still
    // reversible, and the log's sent rows are immutable afterwards.
    for (const state of [
      "incoming_payment_waiting",
      "incoming_payment_initiated",
      "processing",
      "funds_converted",
      "unknown",
    ] as const) {
      expect(payoutOutcomeFor(state), state).toBeNull();
    }
  });
});
