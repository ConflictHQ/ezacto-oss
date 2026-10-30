import { expect, it } from 'vitest'
import { createWebhookSecretVault, createWebhookSigningSecret } from '../src/webhook-secrets.js'
const identity = { subscriptionId: '00000000-0000-4000-8000-000000000001', generation: 1 }
it('seals random signing keys with a fresh nonce and retains no plaintext in the envelope', async () => {
  const vault = await createWebhookSecretVault('A'.repeat(43)),
    secret = createWebhookSigningSecret()
  const one = await vault.seal(secret, identity),
    two = await vault.seal(secret, identity)
  expect(one).not.toContain(secret)
  expect(one).not.toBe(two)
  expect(await vault.open(one, identity)).toBe(secret)
  expect(await vault.open(two, identity)).toBe(secret)
})
it('refuses cross-subscription, cross-generation, changed and wrong-master-key envelopes', async () => {
  const vault = await createWebhookSecretVault('A'.repeat(43)),
    other = await createWebhookSecretVault('B'.repeat(42) + 'A'),
    secret = createWebhookSigningSecret()
  const sealed = await vault.seal(secret, identity)
  await expect(vault.open(sealed, { ...identity, generation: 2 })).rejects.toThrow()
  await expect(
    vault.open(sealed, { ...identity, subscriptionId: '00000000-0000-4000-8000-000000000002' }),
  ).rejects.toThrow()
  await expect(other.open(sealed, identity)).rejects.toThrow()
  const record = JSON.parse(sealed) as { ciphertext: string; nonce: string }
  for (const patch of [
    {
      ciphertext:
        record.ciphertext[0] === 'A'
          ? 'B' + record.ciphertext.slice(1)
          : 'A' + record.ciphertext.slice(1),
    },
    { nonce: 'A'.repeat(16) },
    { extra: 'private-source-value' },
  ])
    await expect(vault.open(JSON.stringify({ ...record, ...patch }), identity)).rejects.toThrow()
})
it('rejects malformed deployment keys and invalid secret/context inputs with redacted errors', async () => {
  for (const key of ['', 'private-value', 'A'.repeat(42), 'A'.repeat(42) + 'B'])
    await expect(createWebhookSecretVault(key)).rejects.toThrow('could not be completed')
  const vault = await createWebhookSecretVault('A'.repeat(43))
  await expect(vault.seal('arbitrary-private-value', identity)).rejects.toThrow(
    'could not be completed',
  )
  await expect(
    vault.seal(createWebhookSigningSecret(), { ...identity, generation: 0 }),
  ).rejects.toThrow()
})
