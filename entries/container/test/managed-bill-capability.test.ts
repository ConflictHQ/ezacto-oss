import { expect, it, vi } from 'vitest'
import { readContainerConfig } from '../src/config.js'
import { createContainerRuntime, ManagedBillUnsupportedRuntimeError } from '../src/runtime.js'

it('refuses managed BILL before storage, factory invocation or deployment credential fallback', async () => {
  const config = readContainerConfig({
    APP_BASE_URL: 'https://owned.example',
    API_CURSOR_SIGNING_KEY: Buffer.alloc(32, 0x42).toString('base64url'),
    SMTP_URL: 'smtps://fixture:private@smtp.example.test:465', SMTP_FROM: 'Owned <mail@example.test>',
    EZACTO_DATA_DIR: '/dev/null/managed-bill', BILL_DEV_KEY: 'PRIVATE_FOREIGN_DEV',
    BILL_COMPANY_ID: 'PRIVATE_FOREIGN_COMPANY', BILL_USERNAME: 'PRIVATE_FOREIGN_LOGIN', BILL_PASSWORD: 'PRIVATE_FOREIGN_PASSWORD',
  })
  const managedBill = { configured: vi.fn(() => true), compose: vi.fn(async () => null) }
  const attempt = createContainerRuntime(config, { managedBill })
  await expect(attempt).rejects.toBeInstanceOf(ManagedBillUnsupportedRuntimeError)
  await expect(attempt).rejects.toMatchObject({ code: 'capability_unsupported' })
  expect(managedBill.configured).not.toHaveBeenCalled()
  expect(managedBill.compose).not.toHaveBeenCalled()
})
