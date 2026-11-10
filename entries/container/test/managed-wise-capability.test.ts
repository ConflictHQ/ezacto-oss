import { expect, it, vi } from 'vitest'
import { readContainerConfig } from '../src/config.js'
import { createContainerRuntime, ManagedWiseUnsupportedRuntimeError } from '../src/runtime.js'

it('refuses managed Wise before storage, factory invocation or deployment credential fallback', async () => {
  const config = readContainerConfig({
    APP_BASE_URL: 'https://owned.example',
    API_CURSOR_SIGNING_KEY: Buffer.alloc(32, 0x42).toString('base64url'),
    SMTP_URL: 'smtps://fixture:private@smtp.example.test:465', SMTP_FROM: 'Owned <mail@example.test>',
    EZACTO_DATA_DIR: '/dev/null/managed-wise',
    WISE_TOKEN: 'PRIVATE_FOREIGN_DEPLOYMENT_TOKEN',
  })
  const managedWise = { configured: vi.fn(() => true), compose: vi.fn(async () => null) }
  const attempt = createContainerRuntime(config, { managedWise })
  await expect(attempt).rejects.toBeInstanceOf(ManagedWiseUnsupportedRuntimeError)
  await expect(attempt).rejects.toMatchObject({ code: 'capability_unsupported' })
  expect(managedWise.configured).not.toHaveBeenCalled()
  expect(managedWise.compose).not.toHaveBeenCalled()
})
