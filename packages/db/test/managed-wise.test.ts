import { describe, expect, it } from 'vitest'
import { createAccountClosureRepository } from '../src/account-closure.js'
import { createAccountRetentionRepository } from '../src/account-retention.js'
import { createAccountDeletionRequestRepository } from '../src/account-deletion-requests.js'
import { createApiApp } from '../../api/src/index.js'
import { createApiSessionService } from '../../api/src/sessions.js'
import { installWiseRoutes } from '../../api/src/wise.js'
import { ManagedWiseUnavailableError } from '@ezacto/core'
import { fixture, calls, credentials, data, status, providerState } from './support/managed-wise-fixture.js'

describe.each(['sqlite', 'd1'] as const)('managed Wise read-only %s', (backend) => {
  it('isolates two native tenants through real API reads and never exposes payment or secret capability', async () => {
    const a = await fixture(backend, 'A', '111'),
      b = await fixture(backend, 'B', '222')
    for (const t of [a, b]) {
      expect(data(await t.configure())).toMatchObject({
        generation: 1,
        status: 'configured',
        profileId: t.profileId,
      })
      const before = await t.financial(),
        runtime = await t.runtime()
      expect(runtime).not.toHaveProperty('webhook')
      expect(runtime).not.toHaveProperty('paymentProvider')
      const app = createApiApp({
        authentication: { sessions: createApiSessionService(t.sessions) },
        installApi: (api) => installWiseRoutes(api, runtime.service),
      })
      const call = (path: string, token = t.admin.token, method = 'GET') =>
        app.fetch(
          new Request(`https://owned.example/api/v1/integrations/wise${path}`, {
            method,
            headers: { origin: 'https://owned.example', cookie: `__Host-ezacto_session=${token}`,
              ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            },
            ...(method === 'POST' ? { body: '{}' } : {}),
          }),
        )
      const initialCalls = calls.length
      expect((await call('/recipients', t.member.token)).status).toBe(403)
      expect(calls).toHaveLength(initialCalls)
      const response = await call('')
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        data: {
          configured: true,
          connection: { profile_id: t.profileId, webhooks_verifiable: false },
        },
      })
      const recipients = await call('/recipients')
      expect(recipients.status).toBe(200)
      const text = await recipients.text()
      expect(text).toContain('ending in 2345')
      expect(text).toContain('9007199254740993123')
      expect(text).not.toMatch(/PRIVATE_|123456789012345|accountSummary|accountNumber/)
      for (const path of ['/recipients/link', '/recipients', '/contacts'])
        expect((await call(path, t.admin.token, 'POST')).status).toBe(403)
      expect(
        calls
          .slice(initialCalls)
          .every((call) => call.method === 'GET' && call.profile === t.profileId),
      ).toBe(true)
      expect(await t.store.state()).toMatchObject({ status: 'connected' })
      expect(await t.financial()).toEqual(before)
      expect(JSON.stringify(await t.rows('wise_managed_connection'))).not.toContain(t.token)
    }
    const envelope = (await a.store.readSealed())!
    await expect(b.vault.open(envelope.sealed, envelope.generation)).rejects.toThrow()
  })
  it('requires fresh session/origin/admin authority, fences exact replay, and inventories custody for closure', async () => {
    const t = await fixture(backend)
    const command = {
      commandId: 'a'.repeat(64),
      expectedGeneration: 0,
      credentials: { token: t.token, profileId: t.profileId },
    }
    expect(status(await t.commands.configure(t.request(t.member.token), command))).toBe(403)
    expect(
      status(
        await t.commands.configure(t.request(t.admin.token, 'https://foreign.example'), command),
      ),
    ).toBe(403)
    expect(data(await t.configure()).outcome).toBe('applied')
    expect(data(await t.configure()).outcome).toBe('replayed')
    expect(status(await t.configure('a'.repeat(64), 0, 'PRIVATE_CHANGED'))).toBe(409)
    expect(await t.store.inventory()).toEqual({ sealedCredentials: 1, commandReceipts: 1 })
    await createAccountRetentionRepository(t.db).publish({
      actorUserId: 1,
      expectedVersion: 0,
      now: t.now(),
      policy: {
        frameworks: [],
        retained_records: [
          {
            category: 'billing_and_payments',
            reason: 'Owned fixture review.',
            period: 'One year then review.',
            review_after_days: 30,
          },
        ],
        response_target_days: 14,
        operator_contact: 'privacy@example.test',
        user_notice: 'Reviewed closure.',
        backup_handling: 'Replay closure.',
        acknowledged: true,
      },
    })
    await createAccountDeletionRequestRepository(t.db).request({
      userId: 2,
      id: 'owned-wise-closure',
      now: t.now(),
      expectedPolicyVersion: 1,
    })
    const preview = await createAccountClosureRepository(t.db).preview(1, 'owned-wise-closure')
    expect(preview.inventory).toContainEqual({
      location: 'wise_managed_commands.actor_id',
      count: 1,
      category: 'billing_and_payments',
    })
    expect(preview.inventory).toContainEqual({
      location: 'wise_managed_connection.connected_by_user_id',
      count: 1,
      category: 'billing_and_payments',
    })
    t.tick(15 * 60_000 + 1)
    expect(
      status(
        await t.commands.disconnect(t.request(), {
          commandId: 'b'.repeat(64),
          expectedGeneration: 1,
        }),
      ),
    ).toBe(403)
    expect(status(await t.configure('b'.repeat(64), 1))).toBe(403)
    expect(await t.store.inventory()).toEqual({ sealedCredentials: 1, commandReceipts: 1 })
    await t.store.erase(t.now())
    expect(await t.store.inventory()).toEqual({ sealedCredentials: 0, commandReceipts: 0 })
    expect(await t.store.state()).toMatchObject({ generation: 2, status: 'disconnected' })
  })
  it('refuses late replies after rotation/disconnect and makes provider failures visibly unavailable', async () => {
    const t = await fixture(backend)
    data(await t.configure())
    const runtime = await t.runtime()
    providerState.beforeResponse = async () => {
      data(await t.configure('b'.repeat(64), 1, 'PRIVATE_ROTATED'))
      credentials.set('Bearer PRIVATE_ROTATED', t.profileId)
    }
    await expect(runtime.service.readStatus()).rejects.toBeInstanceOf(ManagedWiseUnavailableError)
    expect(await t.store.state()).toMatchObject({ generation: 2, status: 'configured' })
    providerState.beforeResponse = async () => {
      data(
        await t.commands.disconnect(t.request(), {
          commandId: 'c'.repeat(64),
          expectedGeneration: 2,
        }),
      )
    }
    await expect(runtime.service.readStatus()).rejects.toBeInstanceOf(ManagedWiseUnavailableError)
    const count = calls.length
    expect(await runtime.service.readStatus()).toBeNull()
    expect(calls).toHaveLength(count)
    data(await t.configure('d'.repeat(64), 3))
    providerState.failure = true
    await expect((await t.runtime()).service.readStatus()).rejects.toThrow(
      'The Wise connection is unavailable or changed. Reopen its settings.',
    )
    expect(await t.store.state()).toMatchObject({ generation: 4, status: 'unavailable' })
  })
  it('performs no provider I/O while disabled/disconnected/erased and rejects a foreign profile', async () => {
    const t = await fixture(backend),
      runtime = await t.runtime()
    expect(await runtime.service.readStatus()).toBeNull()
    expect(calls).toHaveLength(0)
    data(await t.configure('a'.repeat(64), 0, t.token, '222'))
    await expect((await t.runtime()).service.readStatus()).rejects.toBeInstanceOf(
      ManagedWiseUnavailableError,
    )
    expect(calls.every((call) => call.path === '/v2/profiles')).toBe(true)
    expect(await t.store.state()).toMatchObject({ status: 'unavailable' })
    t.disable()
    const count = calls.length
    const disabled = await t.runtime()
    expect(disabled.service.configured()).toBe(false)
    expect(await disabled.service.readStatus()).toBeNull()
    expect(await disabled.service.listRecipients()).toEqual([])
    expect(calls).toHaveLength(count)
    await t.store.erase(t.now())
    expect(await disabled.service.readStatus()).toBeNull()
    expect(calls).toHaveLength(count)
  })
})
