import { describe, expect, it } from 'vitest'
import {
  createMagicLinkToken,
  verifyMagicLinkToken,
  MAGIC_LINK_TTL_MS,
  type MagicLinkPayload,
} from '../src/magic-link.js'

const signingKey = crypto.getRandomValues(new Uint8Array(32))
const now = '2026-09-01T00:00:00.000Z'

describe('magic-link tokens', () => {
  it('[unit] generates a token with the correct prefix and verifies it', async () => {
    const { token, jti, expiresAt } = await createMagicLinkToken(
      {
        contactEmail: 'alice@example.com',
        contactId: 1,
        clientId: 10,
        ttlMs: MAGIC_LINK_TTL_MS,
      },
      signingKey,
      now,
    )
    expect(token).toMatch(/^ezacto_magic_.+\..+$/)
    expect(jti).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(expiresAt).toBe('2026-09-01T00:15:00.000Z')

    const payload = await verifyMagicLinkToken(token, signingKey, now)
    expect(payload).toMatchObject({
      sub: 'alice@example.com',
      cid: 1,
      cli: 10,
      jti,
    })
    expect(payload!.exp).toBe(Date.parse(expiresAt))
  })

  it('[unit] lowercases and trims email', async () => {
    const { token } = await createMagicLinkToken(
      {
        contactEmail: '  Alice@Example.COM  ',
        contactId: 1,
        clientId: 10,
        ttlMs: MAGIC_LINK_TTL_MS,
      },
      signingKey,
      now,
    )
    const payload = await verifyMagicLinkToken(token, signingKey, now)
    expect(payload!.sub).toBe('alice@example.com')
  })

  it('[security] rejects an expired token', async () => {
    const { token } = await createMagicLinkToken(
      {
        contactEmail: 'bob@example.com',
        contactId: 2,
        clientId: 10,
        ttlMs: 60_000,
      },
      signingKey,
      now,
    )
    const afterExpiry = '2026-09-01T00:01:00.001Z'
    const result = await verifyMagicLinkToken(token, signingKey, afterExpiry)
    expect(result).toBeNull()
  })

  it('[security] rejects a token with a tampered payload', async () => {
    const { token } = await createMagicLinkToken(
      {
        contactEmail: 'charlie@example.com',
        contactId: 3,
        clientId: 10,
        ttlMs: MAGIC_LINK_TTL_MS,
      },
      signingKey,
      now,
    )
    // Flip a character in the payload portion
    const parts = token.split('.')
    const payload = parts[0]!
    const flipped =
      payload.slice(0, payload.length - 1) +
      (payload[payload.length - 1] === 'A' ? 'B' : 'A')
    const tampered = `${flipped}.${parts[1]}`
    const result = await verifyMagicLinkToken(tampered, signingKey, now)
    expect(result).toBeNull()
  })

  it('[security] rejects a token signed with a different key', async () => {
    const differentKey = crypto.getRandomValues(new Uint8Array(32))
    const { token } = await createMagicLinkToken(
      {
        contactEmail: 'dave@example.com',
        contactId: 4,
        clientId: 10,
        ttlMs: MAGIC_LINK_TTL_MS,
      },
      signingKey,
      now,
    )
    const result = await verifyMagicLinkToken(token, differentKey, now)
    expect(result).toBeNull()
  })

  it('[security] rejects a key shorter than 32 bytes', async () => {
    const shortKey = new Uint8Array(16)
    await expect(
      createMagicLinkToken(
        {
          contactEmail: 'x@example.com',
          contactId: 1,
          clientId: 1,
          ttlMs: MAGIC_LINK_TTL_MS,
        },
        shortKey,
        now,
      ),
    ).rejects.toThrow('at least 32 bytes')
  })

  it('[unit] rejects malformed token strings', async () => {
    const garbage = [
      '',
      'not_a_token',
      'ezacto_magic_',
      'ezacto_magic_payloadonly',
      'ezacto_magic_.signature',
      'ezacto_magic_payload.',
    ]
    for (const token of garbage) {
      const result = await verifyMagicLinkToken(token, signingKey, now)
      expect(result).toBeNull()
    }
  })

  it('[unit] produces unique jti on every call', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        createMagicLinkToken(
          {
            contactEmail: 'eve@example.com',
            contactId: 5,
            clientId: 10,
            ttlMs: MAGIC_LINK_TTL_MS,
          },
          signingKey,
          now,
        ),
      ),
    )
    const jtis = new Set(results.map((result) => result.jti))
    expect(jtis.size).toBe(20)
  })

  it('[unit] rejects invalid contact/client ids', async () => {
    for (const [contactId, clientId] of [
      [0, 1],
      [-1, 1],
      [1.5, 1],
      [1, 0],
      [1, -1],
    ] as const) {
      await expect(
        createMagicLinkToken(
          {
            contactEmail: 'x@y.com',
            contactId: contactId as number,
            clientId: clientId as number,
            ttlMs: MAGIC_LINK_TTL_MS,
          },
          signingKey,
          now,
        ),
      ).rejects.toThrow('positive safe integers')
    }
  })

  it('[unit] rejects invalid email', async () => {
    await expect(
      createMagicLinkToken(
        { contactEmail: '', contactId: 1, clientId: 1, ttlMs: MAGIC_LINK_TTL_MS },
        signingKey,
        now,
      ),
    ).rejects.toThrow('valid email')
  })
})
