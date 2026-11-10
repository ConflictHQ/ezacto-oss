import { expect, it, vi } from 'vitest'
import { readContainerConfig } from '../src/config.js'
import { createContainerRuntime, ManagedDeelUnsupportedRuntimeError } from '../src/runtime.js'

it('refuses managed Deel before storage, factory invocation or deployment credential fallback', async () => {
  const config = readContainerConfig({
    APP_BASE_URL: 'https://owned.example',
    API_CURSOR_SIGNING_KEY: Buffer.alloc(32, 0x42).toString('base64url'),
    SMTP_URL: 'smtps://fixture:private@smtp.example.test:465', SMTP_FROM: 'Owned <mail@example.test>',
    EZACTO_DATA_DIR: '/dev/null/managed-deel',
    DEEL_TOKEN: 'PRIVATE_FOREIGN_DEPLOYMENT_TOKEN', DEEL_SYNC_START_DATE: '2026-01-01',
  })
  const managedDeel = { configured: vi.fn(() => true), compose: vi.fn(async () => null) }
  const attempt = createContainerRuntime(config, { managedDeel })
  await expect(attempt).rejects.toBeInstanceOf(ManagedDeelUnsupportedRuntimeError)
  await expect(attempt).rejects.toMatchObject({ code: 'capability_unsupported' })
  expect(managedDeel.configured).not.toHaveBeenCalled()
  expect(managedDeel.compose).not.toHaveBeenCalled()
})
