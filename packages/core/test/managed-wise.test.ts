import { expect, it } from "vitest";
import {
  createManagedWiseVault,
  validateManagedWiseCredentials,
} from "../src/managed-wise.js";
import { createManagedBillVault } from "../src/managed-bill.js";
const key = (n: number) =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(n)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const keys = {
  custodyKey: key(1),
  fingerprintKey: key(2),
  tenantBinding: "owned-incarnation",
};
it("authenticates tenant, purpose, key and generation without exposing credentials", async () => {
  const vault = await createManagedWiseVault(keys);
  const credentials = {
    token: "PRIVATE_WISE_TOKEN",
    profileId: "90071992547409931234",
  };
  const envelope = await vault.seal(credentials, 1);
  expect(envelope).not.toContain(credentials.token);
  expect(await vault.open(envelope, 1)).toEqual(credentials);
  for (const [reader, generation] of [
    [vault, 2],
    [
      await createManagedWiseVault({
        ...keys,
        tenantBinding: "other-incarnation",
      }),
      1,
    ],
    [await createManagedWiseVault({ ...keys, custodyKey: key(3) }), 1],
    [await createManagedBillVault(keys), 1],
  ] as const)
    await expect(reader.open(envelope, generation)).rejects.toThrow(
      /connection/,
    );
  await expect(vault.open("PRIVATE_INVALID_ENVELOPE", 1)).rejects.toThrow(
    "The Wise connection or administrator authority changed. Restart from settings.",
  );
  expect(await vault.fingerprint(["command", credentials])).toMatch(
    /^[a-f0-9]{64}$/u,
  );
});
it("preserves existing BILL envelope v1 AAD and plaintext semantics after shared extraction", async () => {
  const vault = await createManagedBillVault(keys);
  const credentials = {
    companyId: "owned",
    username: "user",
    password: "PRIVATE_BILL",
    replyToUserId: null,
    environment: "sandbox" as const,
  };
  const envelope = JSON.parse(await vault.seal(credentials, 4)) as {
    nonce: string;
    ciphertext: string;
    key_id: string;
  };
  const bytes = (value: string) =>
    Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0),
    );
  const aes = await crypto.subtle.importKey(
    "raw",
    bytes(keys.custodyKey),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const clear = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes(envelope.nonce),
      tagLength: 128,
      additionalData: new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          purpose: "ezacto-managed-bill-tenant-credential",
          tenant: keys.tenantBinding,
          generation: 4,
          key_id: envelope.key_id,
        }),
      ),
    },
    aes,
    bytes(envelope.ciphertext),
  );
  expect(JSON.parse(new TextDecoder().decode(clear))).toEqual(credentials);
});
it.each([
  { token: "", profileId: "1" },
  { token: "PRIVATE token", profileId: "1" },
  { token: "PRIVATE\u0000token", profileId: "1" },
  { token: "token", profileId: "01" },
  { token: "token", profileId: "1e3" },
  { token: "token", profileId: 1 },
])("refuses invalid credential input without including its value", (value) => {
  expect(() => validateManagedWiseCredentials(value)).toThrow(
    "The Wise connection or administrator authority changed. Restart from settings.",
  );
});
