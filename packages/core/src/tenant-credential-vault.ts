/** Shared envelope implementation. Purpose is selected by the domain wrapper,
 * never by a request or serialized credential. Existing BILL envelopes retain
 * their exact v1 AAD and wire format. */
const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};
const decode = (value: string): Uint8Array =>
  Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const keyBytes = (encoded: string, invalid: () => Error): Uint8Array => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw invalid();
  const bytes = decode(encoded);
  if (bytes.length !== 32 || base64(bytes) !== encoded) throw invalid();
  return bytes;
};

export interface TenantCredentialVault<T> {
  keyId: string;
  seal(value: T, generation: number): Promise<string>;
  open(envelope: string, generation: number): Promise<T>;
  fingerprint(parts: readonly unknown[]): Promise<string>;
}
export const createTenantCredentialVault = async <T>(options: {
  custodyKey: string;
  fingerprintKey: string;
  tenantBinding: string;
  purpose: string;
  validate: (value: unknown) => asserts value is T;
  invalid: () => Error;
}): Promise<TenantCredentialVault<T>> => {
  const { invalid } = options;
  const custody = keyBytes(options.custodyKey, invalid);
  const fingerprintBytes = keyBytes(options.fingerprintKey, invalid);
  if (options.custodyKey === options.fingerprintKey || !options.tenantBinding)
    throw invalid();
  const aesKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(custody),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(fingerprintBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const keyId = hex(
    await crypto.subtle.digest("SHA-256", new Uint8Array(custody)),
  ).slice(0, 32);
  const aad = (generation: number) => {
    if (!Number.isSafeInteger(generation) || generation < 1) throw invalid();
    return encoder.encode(
      JSON.stringify({
        version: 1,
        purpose: options.purpose,
        tenant: options.tenantBinding,
        generation,
        key_id: keyId,
      }),
    );
  };
  return {
    keyId,
    async seal(credentials, generation) {
      options.validate(credentials);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: aad(generation),
          tagLength: 128,
        },
        aesKey,
        encoder.encode(JSON.stringify(credentials)),
      );
      return JSON.stringify({
        version: 1,
        key_id: keyId,
        nonce: base64(nonce),
        ciphertext: base64(new Uint8Array(ciphertext)),
      });
    },
    async open(envelope, generation) {
      try {
        const record = JSON.parse(envelope) as Record<string, unknown>;
        if (
          record.version !== 1 ||
          record.key_id !== keyId ||
          typeof record.nonce !== "string" ||
          typeof record.ciphertext !== "string"
        )
          throw new Error("envelope");
        const clear = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: new Uint8Array(decode(record.nonce)),
            additionalData: aad(generation),
            tagLength: 128,
          },
          aesKey,
          new Uint8Array(decode(record.ciphertext)),
        );
        const credentials = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(clear),
        );
        options.validate(credentials);
        return credentials as T;
      } catch {
        // Never surface parser/crypto detail: it can echo envelope material.
        throw invalid();
      }
    },
    async fingerprint(parts) {
      return hex(
        await crypto.subtle.sign(
          "HMAC",
          hmacKey,
          encoder.encode(JSON.stringify(parts)),
        ),
      );
    },
  };
};
