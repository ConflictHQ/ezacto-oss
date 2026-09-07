import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectEmailTemplateVariables } from '@ezacto/core'
import {
  createContainerEmailConfigurationStore,
  createD1EmailConfigurationStore,
  EmailConfigurationError,
  type EmailConfigurationStore,
} from '../src/email-configuration.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

const initial = '2026-09-02T04:00:00.000Z'
const later = '2026-09-02T04:01:00.000Z'
const latest = '2026-09-02T04:02:00.000Z'

interface Harness {
  store: EmailConfigurationStore
  run(sql: string, bindings?: readonly unknown[]): Promise<void>
  rows<T>(sql: string, bindings?: readonly unknown[]): Promise<T[]>
  close(): Promise<void>
}

const containerHarness = (): Harness => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  database.exec('BEGIN')
  database.prepare(
    `INSERT INTO organizations (id, name, modules, created_at, updated_at)
     VALUES (1, 'North Peak Studio', '{"invoices":true}', ?, ?)`,
  ).run(initial, initial)
  database.prepare(
    `INSERT INTO users (
      id, first_name, last_name, profile, manager_grants, is_owner, created_at, updated_at
    ) VALUES (1, 'Avery', 'Owner', 'administrator', '[]', 0, ?, ?)`,
  ).run(initial, initial)
  database.prepare(
    `INSERT INTO user_emails (
      id, user_id, address, verified_at, is_primary, created_at, updated_at
    ) VALUES (1, 1, 'owner@example.test', ?, 1, ?, ?)`,
  ).run(initial, initial, initial)
  database.exec('COMMIT')
  return {
    store: createContainerEmailConfigurationStore(database),
    run: async (sql, bindings = []) => {
      database.prepare(sql).run(...bindings)
    },
    rows: async <T>(sql: string, bindings: readonly unknown[] = []) =>
      database.prepare(sql).all(...bindings) as T[],
    close: async () => {
      database.close()
    },
  }
}

const d1Harness = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  await database.batch([
    database
      .prepare(
        `INSERT INTO organizations (id, name, modules, created_at, updated_at)
         VALUES (1, 'North Peak Studio', '{"invoices":true}', ?, ?)`,
      )
      .bind(initial, initial),
    database
      .prepare(
        `INSERT INTO users (
          id, first_name, last_name, profile, manager_grants, is_owner, created_at, updated_at
        ) VALUES (1, 'Avery', 'Owner', 'administrator', '[]', 0, ?, ?)`,
      )
      .bind(initial, initial),
    database
      .prepare(
        `INSERT INTO user_emails (
          id, user_id, address, verified_at, is_primary, created_at, updated_at
        ) VALUES (1, 1, 'owner@example.test', ?, 1, ?, ?)`,
      )
      .bind(initial, initial, initial),
  ])
  return {
    store: createD1EmailConfigurationStore(database),
    run: async (sql, bindings = []) => {
      await database.prepare(sql).bind(...bindings).run()
    },
    rows: async <T>(sql: string, bindings: readonly unknown[] = []) =>
      (await database.prepare(sql).bind(...bindings).all<T>()).results,
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async () => containerHarness()],
  ['D1', d1Harness],
] as const

for (const [runtime, factory] of factories) {
  describe(`email configuration (${runtime})`, () => {
    let harness: Harness | undefined
    afterEach(async () => harness?.close())

    it('[unit] seeds all template types and appends immutable idempotent versions', async () => {
      harness = await factory()
      const templates = await harness.store.listTemplates()
      expect(templates.map(({ kind, version }) => [kind, version])).toEqual([
        ['auth_email_verification', 1],
        ['auth_password_reset', 1],
        ['invoice', 1],
        ['reminder', 1],
        ['thank_you', 1],
      ])
      for (const seeded of templates) {
        expect([
          ...inspectEmailTemplateVariables(seeded.kind, seeded.subjectTemplate),
          ...inspectEmailTemplateVariables(seeded.kind, seeded.textTemplate),
          ...(seeded.htmlTemplate === null
            ? []
            : inspectEmailTemplateVariables(seeded.kind, seeded.htmlTemplate)),
        ]).toEqual([])
      }

      const input = {
        kind: 'invoice' as const,
        expectedVersion: 1,
        subjectTemplate: 'Invoice #%invoice_id% from %company_name%',
        textTemplate: 'Invoice %invoice_number% totals %invoice_amount%.',
        htmlTemplate: '<p>Invoice %invoice_number% totals %invoice_amount%.</p>',
        actorUserId: 1,
        commandId: 'template-invoice-v2',
        occurredAt: later,
      }
      const created = await harness.store.createTemplateVersion(input)
      await expect(harness.store.createTemplateVersion(input)).resolves.toEqual(created)
      expect(created).toMatchObject({ kind: 'invoice', version: 2, createdByUserId: 1 })
      expect(await harness.store.listTemplateVersions('invoice')).toHaveLength(2)

      await expect(
        harness.store.createTemplateVersion({
          ...input,
          subjectTemplate: 'Changed input',
        }),
      ).rejects.toMatchObject({ code: 'command_id_reused' })
      await expect(
        harness.store.createTemplateVersion({
          ...input,
          commandId: 'unknown-variable',
          expectedVersion: 2,
          subjectTemplate: 'Invoice %invented_harvest_variable%',
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' })
      expect(await harness.store.listTemplateVersions('invoice')).toHaveLength(2)

      await expect(
        harness.store.createTemplateVersion({
          kind: 'thank_you',
          expectedVersion: 1,
          subjectTemplate: 'Thanks for %invoice_id%',
          textTemplate: 'Imported literal: %future_harvest_variable%',
          unknownVariablePolicy: 'literal',
          actorUserId: 1,
          commandId: 'literal-import-template',
          occurredAt: later,
        }),
      ).resolves.toMatchObject({
        kind: 'thank_you',
        version: 2,
        unknownVariablePolicy: 'literal',
      })

      await expect(
        harness.run(
          `UPDATE email_template_versions SET subject_template = 'tampered'
           WHERE template_kind = 'invoice' AND version = 1`,
        ),
      ).rejects.toThrow(/immutable/)
      await expect(
        harness.run(
          `DELETE FROM email_template_versions
           WHERE template_kind = 'invoice' AND version = 1`,
        ),
      ).rejects.toThrow(/immutable/)
      await expect(
        harness.run(
          `UPDATE email_template_heads SET current_version = 1
           WHERE template_kind = 'invoice'`,
        ),
      ).rejects.toThrow(/advance exactly one/)
      await expect(
        harness.run(
          `UPDATE email_template_heads SET updated_at = ?
           WHERE template_kind = 'invoice'`,
          [latest],
        ),
      ).rejects.toThrow(/advance exactly one/)
      await expect(
        harness.run(
          `UPDATE email_template_commands SET occurred_at = ?
           WHERE command_id = 'template-invoice-v2'`,
          [latest],
        ),
      ).rejects.toThrow(/immutable/)
      await expect(
        harness.run(
          `DELETE FROM email_template_commands
           WHERE command_id = 'template-invoice-v2'`,
        ),
      ).rejects.toThrow(/immutable/)
    })

    it('[concurrency] serializes version races and preserves the winner exactly', async () => {
      harness = await factory()
      const base = {
        kind: 'reminder' as const,
        expectedVersion: 1,
        subjectTemplate: 'Reminder for %invoice_number%',
        textTemplate: 'Due %invoice_due_date%.',
        actorUserId: 1,
        occurredAt: later,
      }
      const settled = await Promise.allSettled([
        harness.store.createTemplateVersion({ ...base, commandId: 'reminder-race-a' }),
        harness.store.createTemplateVersion({
          ...base,
          commandId: 'reminder-race-b',
          textTemplate: 'Invoice %invoice_number% is due %invoice_due_date%.',
        }),
      ])
      expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect(settled.filter(({ status }) => status === 'rejected')).toHaveLength(1)
      const rejected = settled.find(({ status }) => status === 'rejected')
      expect(rejected).toMatchObject({ reason: { code: 'version_conflict' } })
      expect(await harness.store.listTemplateVersions('reminder')).toHaveLength(2)

      await harness.store.createSenderIdentity({
        id: 77,
        email: 'race@example.test',
        displayName: 'Race Sender',
        provider: 'ses',
        providerIdentity: 'race.example.test',
        actorUserId: 1,
        commandId: 'sender-race-create',
        occurredAt: initial,
      })
      const senderUpdates = await Promise.allSettled([
        harness.store.updateSenderIdentity({
          id: 77,
          expectedVersion: 0,
          displayName: 'Race A',
          actorUserId: 1,
          commandId: 'sender-race-a',
          occurredAt: later,
        }),
        harness.store.updateSenderIdentity({
          id: 77,
          expectedVersion: 0,
          displayName: 'Race B',
          actorUserId: 1,
          commandId: 'sender-race-b',
          occurredAt: later,
        }),
      ])
      expect(senderUpdates.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect(senderUpdates.filter(({ status }) => status === 'rejected')).toHaveLength(1)
      expect(await harness.store.getSenderIdentity(77)).toMatchObject({ version: 1 })

      const evidenceUpdates = await Promise.allSettled([
        harness.store.recordSenderEvidence({
          id: 77,
          expectedEvidenceVersion: 0,
          evidence: {
            source: 'provider_api',
            identityKind: 'domain',
            verificationStatus: 'pending',
            dkimStatus: 'pending',
            mailFromDomain: null,
            mailFromStatus: 'not_configured',
            observedAt: latest,
          },
          actorUserId: 1,
          commandId: 'sender-evidence-race-a',
          occurredAt: latest,
        }),
        harness.store.recordSenderEvidence({
          id: 77,
          expectedEvidenceVersion: 0,
          evidence: {
            source: 'provider_api',
            identityKind: 'domain',
            verificationStatus: 'failed',
            dkimStatus: 'failed',
            mailFromDomain: null,
            mailFromStatus: 'not_configured',
            observedAt: latest,
          },
          actorUserId: 1,
          commandId: 'sender-evidence-race-b',
          occurredAt: latest,
        }),
      ])
      expect(evidenceUpdates.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect(evidenceUpdates.filter(({ status }) => status === 'rejected')).toHaveLength(1)
      expect((await harness.store.getSenderIdentity(77))?.evidence).toMatchObject({ version: 1 })
    })

    it('[security] keeps SMTP deployment attestations provider-bound and append-only', async () => {
      harness = await factory()
      await harness.store.createSenderIdentity({
        id: 45,
        email: 'billing@example.test',
        displayName: 'SMTP Billing',
        provider: 'smtp',
        providerIdentity: 'billing@example.test',
        actorUserId: 1,
        commandId: 'smtp-sender-create',
        occurredAt: initial,
      })
      await expect(harness.store.setDefaultSenderIdentity({
        id: 45,
        expectedVersion: 0,
        actorUserId: 1,
        commandId: 'smtp-default-too-soon',
        occurredAt: later,
      })).rejects.toMatchObject({ code: 'sender_unverified' })
      await expect(harness.store.recordSenderEvidence({
        id: 45,
        expectedEvidenceVersion: 0,
        evidence: {
          source: 'provider_api',
          identityKind: 'email_address',
          verificationStatus: 'verified',
          dkimStatus: 'verified',
          mailFromDomain: null,
          mailFromStatus: 'not_configured',
          observedAt: later,
        },
        actorUserId: 1,
        commandId: 'smtp-forged-provider-evidence',
        occurredAt: later,
      })).rejects.toMatchObject({ code: 'invalid_input' })

      const attested = await harness.store.recordSenderEvidence({
        id: 45,
        expectedEvidenceVersion: 0,
        evidence: {
          source: 'deployment_config',
          identityKind: 'email_address',
          verificationStatus: 'operator_configured',
          dkimStatus: 'not_applicable',
          mailFromDomain: null,
          mailFromStatus: 'not_configured',
          observedAt: later,
        },
        actorUserId: 1,
        commandId: 'smtp-deployment-attestation',
        occurredAt: later,
      })
      expect(attested.evidence).toMatchObject({
        version: 1,
        source: 'deployment_config',
        verificationStatus: 'operator_configured',
      })
      await expect(harness.store.setDefaultSenderIdentity({
        id: 45,
        expectedVersion: 0,
        actorUserId: 1,
        commandId: 'smtp-default-attested',
        occurredAt: latest,
      })).resolves.toMatchObject({ id: 45, isDefault: true })

      await harness.store.createSenderIdentity({
        id: 46,
        email: 'ses@example.test',
        displayName: 'SES Sender',
        provider: 'ses',
        providerIdentity: 'ses@example.test',
        actorUserId: 1,
        commandId: 'ses-cross-source-create',
        occurredAt: initial,
      })
      await expect(harness.store.recordSenderEvidence({
        id: 46,
        expectedEvidenceVersion: 0,
        evidence: {
          source: 'deployment_config',
          identityKind: 'email_address',
          verificationStatus: 'operator_configured',
          dkimStatus: 'not_applicable',
          mailFromDomain: null,
          mailFromStatus: 'not_configured',
          observedAt: later,
        },
        actorUserId: 1,
        commandId: 'ses-forged-deployment-attestation',
        occurredAt: later,
      })).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(harness.run(
        `INSERT INTO sender_identity_evidence (
          sender_identity_id, evidence_version, source, identity_kind,
          verification_status, dkim_status, mail_from_domain, mail_from_status, observed_at
        ) VALUES (46, 1, 'deployment_config', 'email_address',
          'operator_configured', 'not_applicable', NULL, 'not_configured', ?)`,
        [later],
      )).rejects.toThrow(/source does not match provider binding/)
    })

    it('[security] attests Mailgun senders from deployment configuration only', async () => {
      harness = await factory()
      await expect(harness.store.createSenderIdentity({
        id: 47,
        email: 'billing@example.test',
        displayName: 'Mailgun Billing',
        provider: 'mailgun',
        providerIdentity: 'example.test',
        actorUserId: 1,
        commandId: 'mailgun-domain-sender-create',
        occurredAt: initial,
      })).rejects.toMatchObject({ code: 'invalid_input' })
      await harness.store.createSenderIdentity({
        id: 47,
        email: 'billing@example.test',
        displayName: 'Mailgun Billing',
        provider: 'mailgun',
        providerIdentity: 'billing@example.test',
        actorUserId: 1,
        commandId: 'mailgun-sender-create',
        occurredAt: initial,
      })
      await expect(harness.store.recordSenderEvidence({
        id: 47,
        expectedEvidenceVersion: 0,
        evidence: {
          source: 'provider_api',
          identityKind: 'domain',
          verificationStatus: 'verified',
          dkimStatus: 'verified',
          mailFromDomain: null,
          mailFromStatus: 'not_configured',
          observedAt: later,
        },
        actorUserId: 1,
        commandId: 'mailgun-forged-provider-evidence',
        occurredAt: later,
      })).rejects.toMatchObject({ code: 'invalid_input' })

      const attested = await harness.store.recordSenderEvidence({
        id: 47,
        expectedEvidenceVersion: 0,
        evidence: {
          source: 'deployment_config',
          identityKind: 'email_address',
          verificationStatus: 'operator_configured',
          dkimStatus: 'not_applicable',
          mailFromDomain: null,
          mailFromStatus: 'not_configured',
          observedAt: later,
        },
        actorUserId: 1,
        commandId: 'mailgun-deployment-attestation',
        occurredAt: later,
      })
      expect(attested.evidence).toMatchObject({
        version: 1,
        source: 'deployment_config',
        verificationStatus: 'operator_configured',
      })
      await expect(harness.store.setDefaultSenderIdentity({
        id: 47,
        expectedVersion: 0,
        actorUserId: 1,
        commandId: 'mailgun-default-attested',
        occurredAt: latest,
      })).resolves.toMatchObject({ id: 47, isDefault: true })
    })

    it('[concurrency] reserves and replays persisted organization test-send commands', async () => {
      harness = await factory()
      await expect(harness.store.getVerifiedUserEmail(1)).resolves.toBe(
        'owner@example.test',
      )
      await harness.store.createSenderIdentity({
        id: 51,
        email: 'billing@example.test',
        displayName: 'Billing',
        provider: 'ses',
        providerIdentity: 'example.test',
        actorUserId: 1,
        commandId: 'test-send-sender',
        occurredAt: initial,
      })
      const input = {
        senderIdentityId: 51,
        templateKind: 'invoice' as const,
        templateVersion: 1,
        recipientEmail: 'owner@example.test',
        variables: {
          company_name: 'North Peak Studio',
          invoice_id: '51',
          invoice_number: 'INV-51',
          invoice_amount: '$100.00',
          invoice_due_date: '2026-09-30',
        },
        actorUserId: 1,
        commandId: 'test-send-51',
        occurredAt: later,
      }
      const claims = await Promise.all([
        harness.store.beginTestSend(input),
        harness.store.beginTestSend(input),
      ])
      expect(claims.filter(({ claimed }) => claimed)).toHaveLength(1)
      expect(claims.map(({ record }) => record.status)).toEqual([
        'pending',
        'pending',
      ])
      await expect(
        harness.store.beginTestSend({
          ...input,
          variables: { ...input.variables, invoice_id: 'different' },
        }),
      ).rejects.toMatchObject({ code: 'command_id_reused' })

      await harness.run(
        `INSERT INTO email_log (
          id, to_json, template, subject, from_json, created_at, updated_at
        ) VALUES (91, ?, 'invoice:v1:test', 'Test invoice', ?, ?, ?)`,
        [
          JSON.stringify([{ email: 'owner@example.test' }]),
          JSON.stringify({ email: 'billing@example.test', name: 'Billing' }),
          latest,
          latest,
        ],
      )
      const completed = await harness.store.completeTestSend({
        commandId: input.commandId,
        actorUserId: 1,
        deliveryId: 91,
        occurredAt: latest,
      })
      expect(completed).toMatchObject({ status: 'completed', deliveryId: 91 })
      await expect(harness.store.beginTestSend(input)).resolves.toMatchObject({
        claimed: false,
        record: { status: 'completed', deliveryId: 91 },
      })
      await expect(
        harness.run(
          `UPDATE email_test_send_commands SET status = 'failed', delivery_id = NULL,
            failure_code = 'email_queue_unavailable', updated_at = ?
           WHERE command_id = 'test-send-51'`,
          [latest],
        ),
      ).rejects.toThrow(/transition is invalid/)
      await expect(
        harness.run(
          `DELETE FROM email_test_send_commands WHERE command_id = 'test-send-51'`,
        ),
      ).rejects.toThrow(/immutable/)
    })

    it('[security] keeps sender bindings immutable and requires provider evidence before defaulting', async () => {
      harness = await factory()
      const createInput = {
        id: 42,
        email: 'Billing@NorthPeak.test',
        displayName: 'North Peak Billing',
        replyToEmail: 'accounts@northpeak.test',
        provider: 'ses',
        providerIdentity: 'northpeak.test',
        actorUserId: 1,
        commandId: 'sender-create-42',
        occurredAt: initial,
      }
      const created = await harness.store.createSenderIdentity(createInput)
      await expect(harness.store.createSenderIdentity(createInput)).resolves.toEqual(created)
      expect(created).toMatchObject({
        id: 42,
        email: 'billing@northpeak.test',
        isDefault: false,
        evidence: null,
      })
      await expect(
        harness.store.setDefaultSenderIdentity({
          id: 42,
          expectedVersion: 0,
          actorUserId: 1,
          commandId: 'sender-default-too-soon',
          occurredAt: later,
        }),
      ).rejects.toMatchObject({ code: 'sender_unverified' })

      await harness.store.createSenderIdentity({
        id: 43,
        email: 'receipts@northpeak.test',
        displayName: 'North Peak Receipts',
        provider: 'ses',
        providerIdentity: 'receipts@northpeak.test',
        actorUserId: 1,
        commandId: 'sender-create-43',
        occurredAt: initial,
      })
      await harness.store.recordSenderEvidence({
        id: 43,
        expectedEvidenceVersion: 0,
        evidence: {
          source: 'provider_api',
          identityKind: 'email_address',
          verificationStatus: 'verified',
          dkimStatus: 'not_applicable',
          mailFromDomain: null,
          mailFromStatus: 'not_configured',
          observedAt: later,
        },
        actorUserId: 1,
        commandId: 'sender-evidence-email-address-unaligned',
        occurredAt: later,
      })
      await expect(
        harness.store.setDefaultSenderIdentity({
          id: 43,
          expectedVersion: 0,
          actorUserId: 1,
          commandId: 'sender-default-email-address-unaligned',
          occurredAt: later,
        }),
      ).rejects.toMatchObject({
        code: 'sender_unverified',
        message: expect.stringMatching(/DKIM|MAIL FROM/),
      })
      await expect(
        harness.run(
          `UPDATE sender_identities SET is_default = 1, version = 1, updated_at = ?
           WHERE id = 43`,
          [later],
        ),
      ).rejects.toThrow(/aligned provider evidence/)
      await harness.store.recordSenderEvidence({
        id: 43,
        expectedEvidenceVersion: 1,
        evidence: {
          source: 'provider_api',
          identityKind: 'email_address',
          verificationStatus: 'verified',
          dkimStatus: 'not_applicable',
          mailFromDomain: 'bounce.unrelated.test',
          mailFromStatus: 'verified',
          observedAt: latest,
        },
        actorUserId: 1,
        commandId: 'sender-evidence-email-address-unaligned-mail-from',
        occurredAt: latest,
      })
      await expect(
        harness.store.setDefaultSenderIdentity({
          id: 43,
          expectedVersion: 0,
          actorUserId: 1,
          commandId: 'sender-default-email-address-wrong-mail-from',
          occurredAt: latest,
        }),
      ).rejects.toMatchObject({ code: 'sender_unverified' })
      await harness.store.recordSenderEvidence({
        id: 43,
        expectedEvidenceVersion: 2,
        evidence: {
          source: 'provider_api',
          identityKind: 'email_address',
          verificationStatus: 'verified',
          dkimStatus: 'not_applicable',
          mailFromDomain: 'bounce.northpeak.test',
          mailFromStatus: 'verified',
          observedAt: latest,
        },
        actorUserId: 1,
        commandId: 'sender-evidence-email-address-aligned-mail-from',
        occurredAt: latest,
      })
      await expect(
        harness.store.setDefaultSenderIdentity({
          id: 43,
          expectedVersion: 0,
          actorUserId: 1,
          commandId: 'sender-default-email-address-aligned-mail-from',
          occurredAt: latest,
        }),
      ).resolves.toMatchObject({ id: 43, isDefault: true, version: 1 })

      await harness.store.createSenderIdentity({
        id: 44,
        email: 'notices@northpeak.test',
        displayName: 'North Peak Notices',
        provider: 'ses',
        providerIdentity: 'unrelated.test',
        actorUserId: 1,
        commandId: 'sender-create-44',
        occurredAt: initial,
      })
      await harness.store.recordSenderEvidence({
        id: 44,
        expectedEvidenceVersion: 0,
        evidence: {
          source: 'provider_api',
          identityKind: 'domain',
          verificationStatus: 'verified',
          dkimStatus: 'verified',
          mailFromDomain: null,
          mailFromStatus: 'not_configured',
          observedAt: latest,
        },
        actorUserId: 1,
        commandId: 'sender-evidence-domain-binding-mismatch',
        occurredAt: latest,
      })
      await expect(
        harness.store.setDefaultSenderIdentity({
          id: 44,
          expectedVersion: 0,
          actorUserId: 1,
          commandId: 'sender-default-domain-binding-mismatch',
          occurredAt: latest,
        }),
      ).rejects.toMatchObject({
        code: 'sender_unverified',
        message: expect.stringMatching(/exact From address domain/),
      })

      const pending = await harness.store.recordSenderEvidence({
        id: 42,
        expectedEvidenceVersion: 0,
        evidence: {
          source: 'provider_api',
          identityKind: 'domain',
          verificationStatus: 'pending',
          dkimStatus: 'pending',
          mailFromDomain: 'bounce.northpeak.test',
          mailFromStatus: 'pending',
          observedAt: later,
        },
        actorUserId: 1,
        commandId: 'sender-evidence-pending',
        occurredAt: later,
      })
      expect(pending.evidence).toMatchObject({ version: 1, source: 'provider_api' })
      await expect(
        harness.store.replaySenderEvidence({
          id: 42,
          expectedEvidenceVersion: 0,
          actorUserId: 1,
          commandId: 'sender-evidence-pending',
        }),
      ).resolves.toEqual(pending)
      await expect(
        harness.store.replaySenderEvidence({
          id: 42,
          expectedEvidenceVersion: 1,
          actorUserId: 1,
          commandId: 'sender-evidence-pending',
        }),
      ).rejects.toMatchObject({ code: 'command_id_reused' })
      await expect(
        harness.store.setDefaultSenderIdentity({
          id: 42,
          expectedVersion: 0,
          actorUserId: 1,
          commandId: 'sender-default-still-pending',
          occurredAt: later,
        }),
      ).rejects.toMatchObject({ code: 'sender_unverified' })

      const verified = await harness.store.recordSenderEvidence({
        id: 42,
        expectedEvidenceVersion: 1,
        evidence: {
          source: 'provider_api',
          identityKind: 'domain',
          verificationStatus: 'verified',
          dkimStatus: 'verified',
          mailFromDomain: 'bounce.northpeak.test',
          mailFromStatus: 'verified',
          observedAt: latest,
        },
        actorUserId: 1,
        commandId: 'sender-evidence-verified',
        occurredAt: latest,
      })
      expect(verified.evidence).toMatchObject({ version: 2, verificationStatus: 'verified' })
      await expect(
        harness.store.recordSenderEvidence({
          id: 42,
          expectedEvidenceVersion: 0,
          evidence: {
            source: 'provider_api',
            identityKind: 'domain',
            verificationStatus: 'pending',
            dkimStatus: 'pending',
            mailFromDomain: 'bounce.northpeak.test',
            mailFromStatus: 'pending',
            observedAt: later,
          },
          actorUserId: 1,
          commandId: 'sender-evidence-pending',
          occurredAt: later,
        }),
      ).resolves.toEqual(pending)
      const selected = await harness.store.setDefaultSenderIdentity({
        id: 42,
        expectedVersion: 0,
        actorUserId: 1,
        commandId: 'sender-default-verified',
        occurredAt: latest,
      })
      expect(selected).toMatchObject({ isDefault: true, version: 1 })
      await expect(harness.store.resolveSenderIdentity()).resolves.toMatchObject({ id: 42 })

      await expect(
        harness.run(`UPDATE sender_identities SET email = 'other@northpeak.test' WHERE id = 42`),
      ).rejects.toThrow(/immutable/)
      await expect(
        harness.run(`UPDATE sender_identities SET display_name = 'Tampered' WHERE id = 42`),
      ).rejects.toThrow(/version must advance/)
      await expect(
        harness.run(`DELETE FROM sender_identities WHERE id = 42`),
      ).rejects.toThrow(/archived/)
      await expect(
        harness.run(
          `UPDATE sender_identity_evidence SET dkim_status = 'failed'
           WHERE sender_identity_id = 42 AND evidence_version = 2`,
        ),
      ).rejects.toThrow(/immutable/)
      await expect(
        harness.run(
          `UPDATE sender_identity_commands SET occurred_at = ?
           WHERE command_id = 'sender-evidence-verified'`,
          [initial],
        ),
      ).rejects.toThrow(/immutable/)
      await expect(
        harness.run(
          `DELETE FROM sender_identity_commands
           WHERE command_id = 'sender-evidence-verified'`,
        ),
      ).rejects.toThrow(/immutable/)
      await expect(
        harness.store.archiveSenderIdentity({
          id: 42,
          expectedVersion: 1,
          actorUserId: 1,
          commandId: 'archive-default',
          occurredAt: latest,
        }),
      ).rejects.toMatchObject({ code: 'version_conflict' })
    })
  })
}

describe('email configuration tenancy', () => {
  it('[security] structurally isolates identical sender identities in separate databases', async () => {
    const first = containerHarness()
    const second = containerHarness()
    try {
      await first.store.createSenderIdentity({
        id: 7,
        email: 'billing@example.test',
        displayName: 'First Tenant',
        provider: 'ses',
        providerIdentity: 'example.test',
        actorUserId: 1,
        commandId: 'tenant-first',
        occurredAt: initial,
      })
      await second.store.createSenderIdentity({
        id: 7,
        email: 'billing@example.test',
        displayName: 'Second Tenant',
        provider: 'ses',
        providerIdentity: 'example.test',
        actorUserId: 1,
        commandId: 'tenant-second',
        occurredAt: initial,
      })
      expect((await first.store.getSenderIdentity(7))?.displayName).toBe('First Tenant')
      expect((await second.store.getSenderIdentity(7))?.displayName).toBe('Second Tenant')
      expect(EmailConfigurationError).toBeTypeOf('function')
    } finally {
      await first.close()
      await second.close()
    }
  })
})
