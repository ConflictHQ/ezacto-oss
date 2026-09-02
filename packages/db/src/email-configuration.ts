import type BetterSqlite3 from 'better-sqlite3'
import {
  emailTemplateKinds,
  inspectEmailTemplateVariables,
  type EmailTemplateKind,
  type UnknownEmailTemplateVariablePolicy,
} from '@ezacto/core'
import {
  SenderIdentityUnavailableError,
  senderIdentityEligibilityFailure,
  type SenderIdentityUnavailableCode,
} from '@ezacto/mailer'

export type SenderVerificationStatus =
  | 'pending'
  | 'verified'
  | 'failed'
  | 'temporary_failure'
  | 'operator_configured'
export type SenderDkimStatus = 'pending' | 'verified' | 'failed' | 'not_applicable'
export type SenderMailFromStatus = 'pending' | 'verified' | 'failed' | 'not_configured'

export interface EmailTemplateVersionRecord {
  kind: EmailTemplateKind
  version: number
  subjectTemplate: string
  textTemplate: string
  htmlTemplate: string | null
  unknownVariablePolicy: UnknownEmailTemplateVariablePolicy
  createdByUserId: number | null
  createdAt: string
}

export interface SenderIdentityEvidenceRecord {
  version: number
  source: 'provider_api' | 'deployment_config'
  identityKind: 'email_address' | 'domain'
  verificationStatus: SenderVerificationStatus
  dkimStatus: SenderDkimStatus
  mailFromDomain: string | null
  mailFromStatus: SenderMailFromStatus
  observedAt: string
}

export interface SenderIdentityRecord {
  id: number
  email: string
  displayName: string
  replyToEmail: string | null
  provider: string
  providerIdentity: string
  isDefault: boolean
  version: number
  archivedAt: string | null
  createdByUserId: number
  createdAt: string
  updatedAt: string
  evidence: SenderIdentityEvidenceRecord | null
}

export type EmailTestSendFailureCode =
  | SenderIdentityUnavailableCode
  | 'email_queue_unavailable'

const emailTestSendFailureCodes = new Set<EmailTestSendFailureCode>([
  'sender_identity_missing',
  'sender_identity_archived',
  'sender_identity_not_default',
  'sender_provider_mismatch',
  'sender_provider_unsupported',
  'sender_identity_binding_mismatch',
  'sender_evidence_untrusted',
  'sender_verification_pending',
  'sender_verification_temporary_failure',
  'sender_verification_failed',
  'sender_dkim_pending',
  'sender_dkim_failed',
  'sender_mail_from_pending',
  'sender_mail_from_failed',
  'sender_alignment_missing',
  'sender_deployment_configuration_missing',
  'email_queue_unavailable',
])

export interface EmailTestSendCommandRecord {
  commandId: string
  senderIdentityId: number
  templateKind: 'invoice' | 'reminder' | 'thank_you'
  templateVersion: number
  actorUserId: number
  inputFingerprint: string
  status: 'pending' | 'completed' | 'failed'
  deliveryId: number | null
  failureCode: EmailTestSendFailureCode | null
  createdAt: string
  updatedAt: string
}

export interface EmailTestSendClaim {
  record: EmailTestSendCommandRecord
  claimed: boolean
}

export type EmailConfigurationErrorCode =
  | 'not_found'
  | 'version_conflict'
  | 'evidence_conflict'
  | 'command_id_reused'
  | 'invalid_input'
  | 'sender_unverified'

export class EmailConfigurationError extends Error {
  constructor(
    readonly code: EmailConfigurationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'EmailConfigurationError'
  }
}

export interface CreateTemplateVersionInput {
  kind: EmailTemplateKind
  expectedVersion: number
  subjectTemplate: string
  textTemplate: string
  htmlTemplate?: string | null
  unknownVariablePolicy?: UnknownEmailTemplateVariablePolicy
  actorUserId: number
  commandId: string
  occurredAt: string
}

export interface CreateSenderIdentityInput {
  id: number
  email: string
  displayName: string
  replyToEmail?: string | null
  provider: string
  providerIdentity: string
  actorUserId: number
  commandId: string
  occurredAt: string
}

export interface UpdateSenderIdentityInput {
  id: number
  expectedVersion: number
  displayName?: string
  replyToEmail?: string | null
  actorUserId: number
  commandId: string
  occurredAt: string
}

export interface RecordSenderEvidenceInput {
  id: number
  expectedEvidenceVersion: number
  evidence: Omit<SenderIdentityEvidenceRecord, 'version'>
  actorUserId: number
  commandId: string
  occurredAt: string
}

export interface EmailConfigurationStore {
  listTemplates(): Promise<readonly EmailTemplateVersionRecord[]>
  getTemplate(kind: EmailTemplateKind, version?: number): Promise<EmailTemplateVersionRecord | null>
  getVerifiedUserEmail(userId: number): Promise<string | null>
  listTemplateVersions(kind: EmailTemplateKind): Promise<readonly EmailTemplateVersionRecord[]>
  createTemplateVersion(input: Readonly<CreateTemplateVersionInput>): Promise<EmailTemplateVersionRecord>
  listSenderIdentities(): Promise<readonly SenderIdentityRecord[]>
  getSenderIdentity(id: number): Promise<SenderIdentityRecord | null>
  createSenderIdentity(input: Readonly<CreateSenderIdentityInput>): Promise<SenderIdentityRecord>
  updateSenderIdentity(input: Readonly<UpdateSenderIdentityInput>): Promise<SenderIdentityRecord>
  recordSenderEvidence(input: Readonly<RecordSenderEvidenceInput>): Promise<SenderIdentityRecord>
  replaySenderEvidence(input: Readonly<{
    id: number
    expectedEvidenceVersion: number
    actorUserId: number
    commandId: string
  }>): Promise<SenderIdentityRecord | null>
  setDefaultSenderIdentity(input: Readonly<{
    id: number
    expectedVersion: number
    actorUserId: number
    commandId: string
    occurredAt: string
  }>): Promise<SenderIdentityRecord>
  archiveSenderIdentity(input: Readonly<{
    id: number
    expectedVersion: number
    actorUserId: number
    commandId: string
    occurredAt: string
  }>): Promise<SenderIdentityRecord>
  beginTestSend(input: Readonly<{
    senderIdentityId: number
    templateKind: 'invoice' | 'reminder' | 'thank_you'
    templateVersion: number
    recipientEmail: string
    variables: Readonly<Record<string, string>>
    actorUserId: number
    commandId: string
    occurredAt: string
  }>): Promise<EmailTestSendClaim>
  completeTestSend(input: Readonly<{
    commandId: string
    actorUserId: number
    deliveryId: number
    occurredAt: string
  }>): Promise<EmailTestSendCommandRecord>
  failTestSend(input: Readonly<{
    commandId: string
    actorUserId: number
    failureCode: EmailTestSendFailureCode
    occurredAt: string
  }>): Promise<EmailTestSendCommandRecord>
  resolveSenderIdentity(id?: number): Promise<SenderIdentityRecord | null>
}

type NativeClient = BetterSqlite3.Database | D1Database
type Statement = { text: string; params?: readonly unknown[] }

const isD1 = (database: NativeClient): database is D1Database =>
  !('transaction' in database)

const first = async <T>(
  database: NativeClient,
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> => {
  if (isD1(database)) return database.prepare(text).bind(...params).first<T>()
  return (database.prepare(text).get(...params) as T | undefined) ?? null
}

const all = async <T>(
  database: NativeClient,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> => {
  if (isD1(database)) return (await database.prepare(text).bind(...params).all<T>()).results
  return database.prepare(text).all(...params) as T[]
}

const atomic = async (database: NativeClient, statements: readonly Statement[]): Promise<void> => {
  if (isD1(database)) {
    await database.batch(
      statements.map(({ text, params = [] }) => database.prepare(text).bind(...params)),
    )
    return
  }
  database.transaction(() => {
    for (const statement of statements) {
      database.prepare(statement.text).run(...(statement.params ?? []))
    }
  }).immediate()
}

const positiveId = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new EmailConfigurationError('invalid_input', `${field} must be a positive safe integer.`)
  }
  return value
}

const version = (value: number, field: string, allowZero = false): number => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new EmailConfigurationError('invalid_input', `${field} is invalid.`)
  }
  return value
}

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u

const timestamp = (value: string, field: string): string => {
  if (
    typeof value !== 'string' ||
    !timestampPattern.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new EmailConfigurationError('invalid_input', `${field} must be a canonical UTC timestamp.`)
  }
  return value
}

const commandId = (value: string): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
    throw new EmailConfigurationError('invalid_input', 'commandId is invalid.')
  }
  return value
}

const bounded = (
  value: string,
  field: string,
  maximum: number,
  trim = true,
  allowControls = false,
): string => {
  if (typeof value !== 'string') {
    throw new EmailConfigurationError('invalid_input', `${field} must be a string.`)
  }
  const normalized = value.normalize('NFC')
  const result = trim ? normalized.trim() : normalized
  if (
    result.trim().length === 0 ||
    [...result].length > maximum ||
    (!allowControls && /\p{Cc}/u.test(result))
  ) {
    throw new EmailConfigurationError('invalid_input', `${field} is invalid.`)
  }
  return result
}

const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

const email = (value: string, field: string): string => {
  const normalized = bounded(value, field, 254).toLowerCase()
  const separator = normalized.lastIndexOf('@')
  if (
    !emailPattern.test(normalized) ||
    separator !== normalized.indexOf('@') ||
    !domainPattern.test(normalized.slice(separator + 1))
  ) {
    throw new EmailConfigurationError('invalid_input', `${field} is invalid.`)
  }
  return normalized
}

const optionalEmail = (value: string | null | undefined, field: string): string | null =>
  value === undefined || value === null ? null : email(value, field)

const domain = (value: string, field: string): string => {
  const normalized = bounded(value, field, 253).toLowerCase()
  if (!domainPattern.test(normalized)) {
    throw new EmailConfigurationError('invalid_input', `${field} is invalid.`)
  }
  return normalized
}

const provider = (value: string): string => {
  const normalized = bounded(value, 'provider', 64).toLowerCase()
  if (!/^[a-z0-9_-]+$/u.test(normalized)) {
    throw new EmailConfigurationError('invalid_input', 'provider is invalid.')
  }
  return normalized
}

const fingerprint = async (input: unknown): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input))),
  )
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const canonicalTestVariables = (
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new EmailConfigurationError('invalid_input', 'variables must be an object.')
  }
  const entries = Object.entries(values)
  if (entries.length > 32) {
    throw new EmailConfigurationError('invalid_input', 'variables has too many entries.')
  }
  const result: Record<string, string> = {}
  for (const [name, value] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(name) || typeof value !== 'string') {
      throw new EmailConfigurationError('invalid_input', 'variables contains invalid input.')
    }
    result[name] = bounded(value, `variables.${name}`, 2_000, false, true)
  }
  return result
}

const templateSelect = `SELECT version.template_kind AS kind, version.version,
  version.subject_template AS subjectTemplate, version.text_template AS textTemplate,
  version.html_template AS htmlTemplate,
  version.unknown_variable_policy AS unknownVariablePolicy,
  version.created_by_user_id AS createdByUserId, version.created_at AS createdAt
  FROM email_template_versions version`

interface RawSender {
  id: number
  email: string
  displayName: string
  replyToEmail: string | null
  provider: string
  providerIdentity: string
  isDefault: number | boolean
  version: number
  archivedAt: string | null
  createdByUserId: number
  createdAt: string
  updatedAt: string
  evidenceVersion: number | null
  evidenceSource: 'provider_api' | 'deployment_config' | null
  evidenceIdentityKind: 'email_address' | 'domain' | null
  verificationStatus: SenderVerificationStatus | null
  dkimStatus: SenderDkimStatus | null
  mailFromDomain: string | null
  mailFromStatus: SenderMailFromStatus | null
  evidenceObservedAt: string | null
}

const senderSelect = `SELECT identity.id, identity.email,
  identity.display_name AS displayName, identity.reply_to_email AS replyToEmail,
  identity.provider, identity.provider_identity AS providerIdentity,
  identity.is_default AS isDefault, identity.version,
  identity.archived_at AS archivedAt,
  identity.created_by_user_id AS createdByUserId,
  identity.created_at AS createdAt, identity.updated_at AS updatedAt,
  evidence.evidence_version AS evidenceVersion, evidence.source AS evidenceSource,
  evidence.identity_kind AS evidenceIdentityKind,
  evidence.verification_status AS verificationStatus,
  evidence.dkim_status AS dkimStatus, evidence.mail_from_domain AS mailFromDomain,
  evidence.mail_from_status AS mailFromStatus,
  evidence.observed_at AS evidenceObservedAt
  FROM sender_identities identity
  LEFT JOIN sender_identity_evidence evidence
    ON evidence.sender_identity_id = identity.id
    AND evidence.evidence_version = (
      SELECT max(latest.evidence_version) FROM sender_identity_evidence latest
      WHERE latest.sender_identity_id = identity.id
    )`

const senderRecord = (row: RawSender): SenderIdentityRecord => ({
  id: row.id,
  email: row.email,
  displayName: row.displayName,
  replyToEmail: row.replyToEmail,
  provider: row.provider,
  providerIdentity: row.providerIdentity,
  isDefault: Boolean(row.isDefault),
  version: row.version,
  archivedAt: row.archivedAt,
  createdByUserId: row.createdByUserId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  evidence:
    row.evidenceVersion === null ||
    row.evidenceSource === null ||
    row.evidenceIdentityKind === null ||
    row.verificationStatus === null ||
    row.dkimStatus === null ||
    row.mailFromStatus === null ||
    row.evidenceObservedAt === null
      ? null
      : {
          version: row.evidenceVersion,
          source: row.evidenceSource,
          identityKind: row.evidenceIdentityKind,
          verificationStatus: row.verificationStatus,
          dkimStatus: row.dkimStatus,
          mailFromDomain: row.mailFromDomain,
          mailFromStatus: row.mailFromStatus,
          observedAt: row.evidenceObservedAt,
        },
})

interface RawCommand {
  commandKind?: string
  templateKind?: EmailTemplateKind
  expectedVersion?: number
  resultVersion?: number
  senderIdentityId?: number
  actorUserId: number
  inputFingerprint: string
  resultJson: string | Record<string, unknown>
}

interface RawTestSendCommand {
  commandId: string
  senderIdentityId: number
  templateKind: 'invoice' | 'reminder' | 'thank_you'
  templateVersion: number
  actorUserId: number
  inputFingerprint: string
  status: 'pending' | 'completed' | 'failed'
  deliveryId: number | null
  failureCode: EmailTestSendFailureCode | null
  createdAt: string
  updatedAt: string
}

const parsedResult = <T>(row: RawCommand): T => {
  const result = typeof row.resultJson === 'string' ? JSON.parse(row.resultJson) : row.resultJson
  if (
    typeof result !== 'object' ||
    result === null ||
    Reflect.get(result, 'schema_version') !== 1 ||
    typeof Reflect.get(result, 'data') !== 'object' ||
    Reflect.get(result, 'data') === null
  ) {
    throw new Error('email configuration command receipt is invalid')
  }
  return Reflect.get(result, 'data') as T
}

const jsonResult = (data: unknown): string => JSON.stringify({ schema_version: 1, data })

const createStore = (database: NativeClient): EmailConfigurationStore => {
  const readSender = async (id: number): Promise<SenderIdentityRecord | null> => {
    const row = await first<RawSender>(database, `${senderSelect} WHERE identity.id = ?`, [id])
    return row === null ? null : senderRecord(row)
  }

  const readSenderCommand = (id: string): Promise<RawCommand | null> =>
    first<RawCommand>(
      database,
      `SELECT command_kind AS commandKind, sender_identity_id AS senderIdentityId,
        actor_user_id AS actorUserId, input_fingerprint AS inputFingerprint,
        result_json AS resultJson FROM sender_identity_commands WHERE command_id = ?`,
      [id],
    )

  const readTestSendCommand = (id: string): Promise<EmailTestSendCommandRecord | null> =>
    first<RawTestSendCommand>(
      database,
      `SELECT command_id AS commandId, sender_identity_id AS senderIdentityId,
        template_kind AS templateKind, template_version AS templateVersion,
        actor_user_id AS actorUserId, input_fingerprint AS inputFingerprint,
        status, delivery_id AS deliveryId, failure_code AS failureCode,
        created_at AS createdAt, updated_at AS updatedAt
       FROM email_test_send_commands WHERE command_id = ?`,
      [id],
    )

  const replaySender = <T>(
    command: RawCommand,
    expected: { kind: string; identityId: number; actorUserId: number; inputFingerprint: string },
  ): T => {
    if (
      command.commandKind !== expected.kind ||
      command.senderIdentityId !== expected.identityId ||
      command.actorUserId !== expected.actorUserId ||
      command.inputFingerprint !== expected.inputFingerprint
    ) {
      throw new EmailConfigurationError(
        'command_id_reused',
        'The Idempotency-Key was already used with different email configuration input.',
      )
    }
    return parsedResult<T>(command)
  }

  const senderMutation = async (
    expected: { kind: string; identityId: number; actorUserId: number; commandId: string; fingerprint: string },
    statements: readonly Statement[],
    fallbackCode: EmailConfigurationErrorCode,
    fallbackMessage: string,
  ): Promise<SenderIdentityRecord> => {
    const prior = await readSenderCommand(expected.commandId)
    if (prior !== null) {
      return replaySender(prior, {
        kind: expected.kind,
        identityId: expected.identityId,
        actorUserId: expected.actorUserId,
        inputFingerprint: expected.fingerprint,
      })
    }
    try {
      await atomic(database, statements)
    } catch (error) {
      const raced = await readSenderCommand(expected.commandId)
      if (raced !== null) {
        return replaySender(raced, {
          kind: expected.kind,
          identityId: expected.identityId,
          actorUserId: expected.actorUserId,
          inputFingerprint: expected.fingerprint,
        })
      }
      void error
      throw new EmailConfigurationError(fallbackCode, fallbackMessage)
    }
    const completed = await readSenderCommand(expected.commandId)
    if (completed === null) throw new EmailConfigurationError(fallbackCode, fallbackMessage)
    return replaySender(completed, {
      kind: expected.kind,
      identityId: expected.identityId,
      actorUserId: expected.actorUserId,
      inputFingerprint: expected.fingerprint,
    })
  }

  return {
    async listTemplates() {
      return all<EmailTemplateVersionRecord>(
        database,
        `${templateSelect}
         JOIN email_template_heads head
           ON head.template_kind = version.template_kind
          AND head.current_version = version.version
         ORDER BY version.template_kind`,
      )
    },

    async getVerifiedUserEmail(userId) {
      const row = await first<{ address: string }>(
        database,
        `SELECT address FROM user_emails
         WHERE user_id = ? AND verified_at IS NOT NULL AND invalidated_at IS NULL
         ORDER BY is_primary DESC, id LIMIT 1`,
        [positiveId(userId, 'userId')],
      )
      return row?.address ?? null
    },

    async getTemplate(kind, requestedVersion) {
      if (!(emailTemplateKinds as readonly string[]).includes(kind)) {
        throw new EmailConfigurationError('invalid_input', 'Email template kind is unsupported.')
      }
      const row = await first<EmailTemplateVersionRecord>(
        database,
        requestedVersion === undefined
          ? `${templateSelect} JOIN email_template_heads head
               ON head.template_kind = version.template_kind
              AND head.current_version = version.version
             WHERE version.template_kind = ?`
          : `${templateSelect} WHERE version.template_kind = ? AND version.version = ?`,
        requestedVersion === undefined ? [kind] : [kind, version(requestedVersion, 'version')],
      )
      return row
    },

    async listTemplateVersions(kind) {
      if (!(emailTemplateKinds as readonly string[]).includes(kind)) {
        throw new EmailConfigurationError('invalid_input', 'Email template kind is unsupported.')
      }
      return all<EmailTemplateVersionRecord>(
        database,
        `${templateSelect} WHERE version.template_kind = ? ORDER BY version.version DESC`,
        [kind],
      )
    },

    async createTemplateVersion(input) {
      if (!(emailTemplateKinds as readonly string[]).includes(input.kind)) {
        throw new EmailConfigurationError('invalid_input', 'Email template kind is unsupported.')
      }
      const expectedVersion = version(input.expectedVersion, 'expectedVersion')
      const actorUserId = positiveId(input.actorUserId, 'actorUserId')
      const id = commandId(input.commandId)
      const at = timestamp(input.occurredAt, 'occurredAt')
      const subjectTemplate = bounded(input.subjectTemplate, 'subjectTemplate', 998)
      const textTemplate = bounded(input.textTemplate, 'textTemplate', 1_000_000, false, true)
      const htmlTemplate =
        input.htmlTemplate === undefined || input.htmlTemplate === null
          ? null
          : bounded(input.htmlTemplate, 'htmlTemplate', 2_000_000, false, true)
      const unknownVariablePolicy = input.unknownVariablePolicy ?? 'error'
      if (unknownVariablePolicy !== 'error' && unknownVariablePolicy !== 'literal') {
        throw new EmailConfigurationError('invalid_input', 'Unknown-variable policy is invalid.')
      }
      if (unknownVariablePolicy === 'error') {
        const failures = [
          ...inspectEmailTemplateVariables(input.kind, subjectTemplate),
          ...inspectEmailTemplateVariables(input.kind, textTemplate),
          ...(htmlTemplate === null ? [] : inspectEmailTemplateVariables(input.kind, htmlTemplate)),
        ]
        if (failures.length > 0) {
          throw new EmailConfigurationError('invalid_input', failures[0]!.message)
        }
      }
      const nextVersion = expectedVersion + 1
      if (!Number.isSafeInteger(nextVersion)) {
        throw new EmailConfigurationError('invalid_input', 'Template version is exhausted.')
      }
      const inputFingerprint = await fingerprint({
        kind: input.kind,
        expectedVersion,
        subjectTemplate,
        textTemplate,
        htmlTemplate,
        unknownVariablePolicy,
      })
      const readCommand = (): Promise<RawCommand | null> =>
        first<RawCommand>(
          database,
          `SELECT template_kind AS templateKind, expected_version AS expectedVersion,
            result_version AS resultVersion, actor_user_id AS actorUserId,
            input_fingerprint AS inputFingerprint, result_json AS resultJson
            FROM email_template_commands WHERE command_id = ?`,
          [id],
        )
      const replay = (row: RawCommand): EmailTemplateVersionRecord => {
        if (
          row.templateKind !== input.kind ||
          row.expectedVersion !== expectedVersion ||
          row.resultVersion !== nextVersion ||
          row.actorUserId !== actorUserId ||
          row.inputFingerprint !== inputFingerprint
        ) {
          throw new EmailConfigurationError(
            'command_id_reused',
            'The Idempotency-Key was already used with different template input.',
          )
        }
        return parsedResult<EmailTemplateVersionRecord>(row)
      }
      const prior = await readCommand()
      if (prior !== null) return replay(prior)
      const result: EmailTemplateVersionRecord = {
        kind: input.kind,
        version: nextVersion,
        subjectTemplate,
        textTemplate,
        htmlTemplate,
        unknownVariablePolicy,
        createdByUserId: actorUserId,
        createdAt: at,
      }
      try {
        await atomic(database, [
          {
            text: `INSERT INTO email_template_versions (
              template_kind, version, subject_template, text_template, html_template,
              unknown_variable_policy, created_by_user_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              input.kind,
              nextVersion,
              subjectTemplate,
              textTemplate,
              htmlTemplate,
              unknownVariablePolicy,
              actorUserId,
              at,
            ],
          },
          {
            text: `UPDATE email_template_heads SET current_version = ?, updated_at = ?
              WHERE template_kind = ? AND current_version = ?`,
            params: [nextVersion, at, input.kind, expectedVersion],
          },
          { text: `INSERT INTO _email_configuration_assertions (ok) VALUES (changes())` },
          { text: `DELETE FROM _email_configuration_assertions` },
          {
            text: `INSERT INTO email_template_commands (
              command_id, template_kind, expected_version, result_version, actor_user_id,
              input_fingerprint, occurred_at, result_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              id,
              input.kind,
              expectedVersion,
              nextVersion,
              actorUserId,
              inputFingerprint,
              at,
              jsonResult(result),
            ],
          },
        ])
      } catch (error) {
        const raced = await readCommand()
        if (raced !== null) return replay(raced)
        const current = await this.getTemplate(input.kind)
        if (current !== null && current.version !== expectedVersion) {
          throw new EmailConfigurationError(
            'version_conflict',
            `Template ${input.kind} is now at version ${current.version}.`,
          )
        }
        throw error
      }
      const completed = await readCommand()
      if (completed === null) throw new Error('email template command did not complete')
      return replay(completed)
    },

    async listSenderIdentities() {
      return (
        await all<RawSender>(
          database,
          `${senderSelect} ORDER BY identity.archived_at IS NOT NULL, identity.is_default DESC,
            identity.email, identity.id`,
        )
      ).map(senderRecord)
    },

    getSenderIdentity(id) {
      return readSender(positiveId(id, 'sender identity id'))
    },

    async createSenderIdentity(input) {
      const identityId = positiveId(input.id, 'sender identity id')
      const actorUserId = positiveId(input.actorUserId, 'actorUserId')
      const id = commandId(input.commandId)
      const at = timestamp(input.occurredAt, 'occurredAt')
      const address = email(input.email, 'email')
      const displayName = bounded(input.displayName, 'displayName', 200)
      const replyToEmail = optionalEmail(input.replyToEmail, 'replyToEmail')
      const providerName = provider(input.provider)
      const rawProviderIdentity = bounded(input.providerIdentity, 'providerIdentity', 320)
      const providerIdentity =
        providerName === 'ses'
          ? rawProviderIdentity.includes('@')
            ? email(rawProviderIdentity, 'providerIdentity')
            : domain(rawProviderIdentity, 'providerIdentity')
          : providerName === 'smtp'
            ? email(rawProviderIdentity, 'providerIdentity')
          : rawProviderIdentity
      const inputFingerprint = await fingerprint({
        identityId,
        address,
        displayName,
        replyToEmail,
        providerName,
        providerIdentity,
      })
      const result: SenderIdentityRecord = {
        id: identityId,
        email: address,
        displayName,
        replyToEmail,
        provider: providerName,
        providerIdentity,
        isDefault: false,
        version: 0,
        archivedAt: null,
        createdByUserId: actorUserId,
        createdAt: at,
        updatedAt: at,
        evidence: null,
      }
      return senderMutation(
        {
          kind: 'sender.create',
          identityId,
          actorUserId,
          commandId: id,
          fingerprint: inputFingerprint,
        },
        [
          {
            text: `INSERT INTO sender_identities (
              id, email, display_name, reply_to_email, provider, provider_identity,
              created_by_user_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              identityId,
              address,
              displayName,
              replyToEmail,
              providerName,
              providerIdentity,
              actorUserId,
              at,
              at,
            ],
          },
          {
            text: `INSERT INTO sender_identity_commands (
              command_id, command_kind, sender_identity_id, actor_user_id,
              input_fingerprint, occurred_at, result_json
            ) VALUES (?, 'sender.create', ?, ?, ?, ?, ?)`,
            params: [id, identityId, actorUserId, inputFingerprint, at, jsonResult(result)],
          },
        ],
        'version_conflict',
        'The sender identity could not be created.',
      )
    },

    async updateSenderIdentity(input) {
      const identityId = positiveId(input.id, 'sender identity id')
      const actorUserId = positiveId(input.actorUserId, 'actorUserId')
      const expectedVersion = version(input.expectedVersion, 'expectedVersion', true)
      const id = commandId(input.commandId)
      const at = timestamp(input.occurredAt, 'occurredAt')
      if (input.displayName === undefined && input.replyToEmail === undefined) {
        throw new EmailConfigurationError('invalid_input', 'At least one sender field is required.')
      }
      const displayNamePatch =
        input.displayName === undefined
          ? undefined
          : bounded(input.displayName, 'displayName', 200)
      const replyToEmailPatch =
        input.replyToEmail === undefined
          ? undefined
          : optionalEmail(input.replyToEmail, 'replyToEmail')
      const inputFingerprint = await fingerprint({
        identityId,
        expectedVersion,
        displayName: displayNamePatch,
        replyToEmail: replyToEmailPatch,
      })
      const prior = await readSenderCommand(id)
      if (prior !== null) {
        return replaySender(prior, {
          kind: 'sender.update',
          identityId,
          actorUserId,
          inputFingerprint,
        })
      }
      const current = await readSender(identityId)
      if (current === null || current.archivedAt !== null) {
        throw new EmailConfigurationError('not_found', 'Sender identity not found.')
      }
      if (current.version !== expectedVersion) {
        throw new EmailConfigurationError(
          'version_conflict',
          'The sender identity changed before this update.',
        )
      }
      const displayName = displayNamePatch ?? current.displayName
      const replyToEmail =
        replyToEmailPatch === undefined ? current.replyToEmail : replyToEmailPatch
      const result = {
        ...current,
        displayName,
        replyToEmail,
        version: expectedVersion + 1,
        updatedAt: at,
      }
      return senderMutation(
        {
          kind: 'sender.update',
          identityId,
          actorUserId,
          commandId: id,
          fingerprint: inputFingerprint,
        },
        [
          {
            text: `UPDATE sender_identities
              SET display_name = ?, reply_to_email = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND version = ? AND archived_at IS NULL`,
            params: [displayName, replyToEmail, at, identityId, expectedVersion],
          },
          { text: `INSERT INTO _email_configuration_assertions (ok) VALUES (changes())` },
          { text: `DELETE FROM _email_configuration_assertions` },
          {
            text: `INSERT INTO sender_identity_commands (
              command_id, command_kind, sender_identity_id, actor_user_id,
              input_fingerprint, occurred_at, result_json
            ) VALUES (?, 'sender.update', ?, ?, ?, ?, ?)`,
            params: [id, identityId, actorUserId, inputFingerprint, at, jsonResult(result)],
          },
        ],
        'version_conflict',
        'The sender identity changed before this update.',
      )
    },

    async recordSenderEvidence(input) {
      const identityId = positiveId(input.id, 'sender identity id')
      const actorUserId = positiveId(input.actorUserId, 'actorUserId')
      const expectedEvidenceVersion = version(
        input.expectedEvidenceVersion,
        'expectedEvidenceVersion',
        true,
      )
      const id = commandId(input.commandId)
      const at = timestamp(input.occurredAt, 'occurredAt')
      const observedAt = timestamp(input.evidence.observedAt, 'evidence.observedAt')
      const allowedVerification: readonly SenderVerificationStatus[] = [
        'pending',
        'verified',
        'failed',
        'temporary_failure',
        'operator_configured',
      ]
      const allowedDkim: readonly SenderDkimStatus[] = [
        'pending',
        'verified',
        'failed',
        'not_applicable',
      ]
      const allowedMailFrom: readonly SenderMailFromStatus[] = [
        'pending',
        'verified',
        'failed',
        'not_configured',
      ]
      const allowedIdentityKinds = ['email_address', 'domain'] as const
      if (
        (input.evidence.source !== 'provider_api' &&
          input.evidence.source !== 'deployment_config') ||
        !allowedIdentityKinds.includes(input.evidence.identityKind) ||
        !allowedVerification.includes(input.evidence.verificationStatus) ||
        !allowedDkim.includes(input.evidence.dkimStatus) ||
        !allowedMailFrom.includes(input.evidence.mailFromStatus)
      ) {
        throw new EmailConfigurationError('invalid_input', 'Sender evidence status is invalid.')
      }
      const mailFromDomain =
        input.evidence.mailFromDomain === null
          ? null
          : domain(input.evidence.mailFromDomain, 'mailFromDomain')
      if (
        (input.evidence.mailFromStatus === 'not_configured') !== (mailFromDomain === null)
      ) {
        throw new EmailConfigurationError(
          'invalid_input',
          'MAIL FROM domain and status do not describe the same provider observation.',
        )
      }
      if (
        input.evidence.source === 'deployment_config'
          ? input.evidence.verificationStatus !== 'operator_configured' ||
            input.evidence.identityKind !== 'email_address' ||
            input.evidence.dkimStatus !== 'not_applicable' ||
            input.evidence.mailFromStatus !== 'not_configured' ||
            mailFromDomain !== null
          : input.evidence.verificationStatus === 'operator_configured'
      ) {
        throw new EmailConfigurationError(
          'invalid_input',
          'Sender evidence source and statuses are inconsistent.',
        )
      }
      const evidence: SenderIdentityEvidenceRecord = {
        version: expectedEvidenceVersion + 1,
        source: input.evidence.source,
        identityKind: input.evidence.identityKind,
        verificationStatus: input.evidence.verificationStatus,
        dkimStatus: input.evidence.dkimStatus,
        mailFromDomain,
        mailFromStatus: input.evidence.mailFromStatus,
        observedAt,
      }
      const inputFingerprint = await fingerprint({ identityId, expectedEvidenceVersion, evidence })
      const prior = await readSenderCommand(id)
      if (prior !== null) {
        return replaySender(prior, {
          kind: 'sender.evidence',
          identityId,
          actorUserId,
          inputFingerprint,
        })
      }
      const identity = await readSender(identityId)
      if (identity === null || identity.archivedAt !== null) {
        throw new EmailConfigurationError('not_found', 'Sender identity not found.')
      }
      if (
        (identity.provider === 'ses' && evidence.source !== 'provider_api') ||
        (identity.provider === 'smtp' && evidence.source !== 'deployment_config') ||
        (identity.provider !== 'ses' && identity.provider !== 'smtp') ||
        (identity.provider === 'smtp' &&
          identity.providerIdentity.normalize('NFC').trim().toLowerCase() !==
            identity.email.normalize('NFC').trim().toLowerCase())
      ) {
        throw new EmailConfigurationError(
          'invalid_input',
          'Sender evidence source does not match the configured provider binding.',
        )
      }
      if ((identity.evidence?.version ?? 0) !== expectedEvidenceVersion) {
        throw new EmailConfigurationError(
          'evidence_conflict',
          'Newer sender verification evidence was recorded first.',
        )
      }
      const result = { ...identity, evidence }
      return senderMutation(
        {
          kind: 'sender.evidence',
          identityId,
          actorUserId,
          commandId: id,
          fingerprint: inputFingerprint,
        },
        [
          {
            text: `INSERT INTO sender_identity_evidence (
              sender_identity_id, evidence_version, source, identity_kind, verification_status,
              dkim_status, mail_from_domain, mail_from_status, observed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              identityId,
              evidence.version,
              evidence.source,
              evidence.identityKind,
              evidence.verificationStatus,
              evidence.dkimStatus,
              evidence.mailFromDomain,
              evidence.mailFromStatus,
              evidence.observedAt,
            ],
          },
          {
            text: `INSERT INTO sender_identity_commands (
              command_id, command_kind, sender_identity_id, actor_user_id,
              input_fingerprint, occurred_at, result_json
            ) VALUES (?, 'sender.evidence', ?, ?, ?, ?, ?)`,
            params: [id, identityId, actorUserId, inputFingerprint, at, jsonResult(result)],
          },
        ],
        'evidence_conflict',
        'Newer sender verification evidence was recorded first.',
      )
    },

    async replaySenderEvidence(input) {
      const identityId = positiveId(input.id, 'sender identity id')
      const actorUserId = positiveId(input.actorUserId, 'actorUserId')
      const expectedEvidenceVersion = version(
        input.expectedEvidenceVersion,
        'expectedEvidenceVersion',
        true,
      )
      const id = commandId(input.commandId)
      const existing = await readSenderCommand(id)
      if (existing === null) return null
      if (
        existing.commandKind !== 'sender.evidence' ||
        existing.senderIdentityId !== identityId ||
        existing.actorUserId !== actorUserId
      ) {
        throw new EmailConfigurationError(
          'command_id_reused',
          'The Idempotency-Key was already used with different email configuration input.',
        )
      }
      const result = parsedResult<SenderIdentityRecord>(existing)
      if (result.evidence?.version !== expectedEvidenceVersion + 1) {
        throw new EmailConfigurationError(
          'command_id_reused',
          'The Idempotency-Key was already used with a different evidence version.',
        )
      }
      return result
    },

    async setDefaultSenderIdentity(input) {
      const identityId = positiveId(input.id, 'sender identity id')
      const actorUserId = positiveId(input.actorUserId, 'actorUserId')
      const expectedVersion = version(input.expectedVersion, 'expectedVersion', true)
      const id = commandId(input.commandId)
      const at = timestamp(input.occurredAt, 'occurredAt')
      const inputFingerprint = await fingerprint({ identityId, expectedVersion })
      const prior = await readSenderCommand(id)
      if (prior !== null) {
        return replaySender(prior, {
          kind: 'sender.default',
          identityId,
          actorUserId,
          inputFingerprint,
        })
      }
      const current = await readSender(identityId)
      if (current === null || current.archivedAt !== null) {
        throw new EmailConfigurationError('not_found', 'Sender identity not found.')
      }
      const eligibilityFailure = senderIdentityEligibilityFailure(current)
      if (eligibilityFailure !== null) {
        throw new EmailConfigurationError(
          'sender_unverified',
          new SenderIdentityUnavailableError(eligibilityFailure, current.id).message,
        )
      }
      if (current.version !== expectedVersion) {
        throw new EmailConfigurationError(
          'version_conflict',
          'The sender identity changed before this update.',
        )
      }
      const result = {
        ...current,
        isDefault: true,
        version: current.isDefault ? current.version : expectedVersion + 1,
        updatedAt: current.isDefault ? current.updatedAt : at,
      }
      const statements: Statement[] = []
      if (!current.isDefault) {
        statements.push(
          {
            text: `UPDATE sender_identities SET is_default = 0,
              version = version + 1, updated_at = ?
              WHERE is_default = 1 AND archived_at IS NULL AND id <> ?`,
            params: [at, identityId],
          },
          {
            text: `UPDATE sender_identities SET is_default = 1,
              version = version + 1, updated_at = ?
              WHERE id = ? AND version = ? AND archived_at IS NULL`,
            params: [at, identityId, expectedVersion],
          },
          { text: `INSERT INTO _email_configuration_assertions (ok) VALUES (changes())` },
          { text: `DELETE FROM _email_configuration_assertions` },
        )
      }
      statements.push({
        text: `INSERT INTO sender_identity_commands (
          command_id, command_kind, sender_identity_id, actor_user_id,
          input_fingerprint, occurred_at, result_json
        ) VALUES (?, 'sender.default', ?, ?, ?, ?, ?)`,
        params: [id, identityId, actorUserId, inputFingerprint, at, jsonResult(result)],
      })
      return senderMutation(
        {
          kind: 'sender.default',
          identityId,
          actorUserId,
          commandId: id,
          fingerprint: inputFingerprint,
        },
        statements,
        'version_conflict',
        'The sender identity changed before this update.',
      )
    },

    async archiveSenderIdentity(input) {
      const identityId = positiveId(input.id, 'sender identity id')
      const actorUserId = positiveId(input.actorUserId, 'actorUserId')
      const expectedVersion = version(input.expectedVersion, 'expectedVersion', true)
      const id = commandId(input.commandId)
      const at = timestamp(input.occurredAt, 'occurredAt')
      const inputFingerprint = await fingerprint({ identityId, expectedVersion })
      const prior = await readSenderCommand(id)
      if (prior !== null) {
        return replaySender(prior, {
          kind: 'sender.archive',
          identityId,
          actorUserId,
          inputFingerprint,
        })
      }
      const current = await readSender(identityId)
      if (current === null) throw new EmailConfigurationError('not_found', 'Sender identity not found.')
      if (current.isDefault) {
        throw new EmailConfigurationError(
          'version_conflict',
          'Select another verified default sender before archiving this identity.',
        )
      }
      if (current.archivedAt !== null || current.version !== expectedVersion) {
        throw new EmailConfigurationError(
          'version_conflict',
          'The sender identity changed before this update.',
        )
      }
      const result = {
        ...current,
        version: expectedVersion + 1,
        archivedAt: at,
        updatedAt: at,
      }
      return senderMutation(
        {
          kind: 'sender.archive',
          identityId,
          actorUserId,
          commandId: id,
          fingerprint: inputFingerprint,
        },
        [
          {
            text: `UPDATE sender_identities SET archived_at = ?,
              version = version + 1, updated_at = ?
              WHERE id = ? AND version = ? AND archived_at IS NULL AND is_default = 0`,
            params: [at, at, identityId, expectedVersion],
          },
          { text: `INSERT INTO _email_configuration_assertions (ok) VALUES (changes())` },
          { text: `DELETE FROM _email_configuration_assertions` },
          {
            text: `INSERT INTO sender_identity_commands (
              command_id, command_kind, sender_identity_id, actor_user_id,
              input_fingerprint, occurred_at, result_json
            ) VALUES (?, 'sender.archive', ?, ?, ?, ?, ?)`,
            params: [id, identityId, actorUserId, inputFingerprint, at, jsonResult(result)],
          },
        ],
        'version_conflict',
        'The sender identity changed before this update.',
      )
    },

    async beginTestSend(input) {
      const senderIdentityId = positiveId(input.senderIdentityId, 'senderIdentityId')
      const actorUserId = positiveId(input.actorUserId, 'actorUserId')
      const templateVersion = version(input.templateVersion, 'templateVersion')
      const id = commandId(input.commandId)
      const at = timestamp(input.occurredAt, 'occurredAt')
      if (!(['invoice', 'reminder', 'thank_you'] as const).includes(input.templateKind)) {
        throw new EmailConfigurationError(
          'invalid_input',
          'Only organization message templates can be test-sent.',
        )
      }
      const recipientEmail = email(input.recipientEmail, 'recipientEmail')
      const variables = canonicalTestVariables(input.variables)
      const inputFingerprint = await fingerprint({
        senderIdentityId,
        templateKind: input.templateKind,
        templateVersion,
        recipientEmail,
        variables,
      })
      const replay = (record: EmailTestSendCommandRecord): EmailTestSendCommandRecord => {
        if (
          record.senderIdentityId !== senderIdentityId ||
          record.templateKind !== input.templateKind ||
          record.templateVersion !== templateVersion ||
          record.actorUserId !== actorUserId ||
          record.inputFingerprint !== inputFingerprint
        ) {
          throw new EmailConfigurationError(
            'command_id_reused',
            'The Idempotency-Key was already used with different test-send input.',
          )
        }
        return record
      }
      const prior = await readTestSendCommand(id)
      if (prior !== null) return { record: replay(prior), claimed: false }
      try {
        await atomic(database, [
          {
            text: `INSERT INTO email_test_send_commands (
              command_id, sender_identity_id, template_kind, template_version,
              actor_user_id, input_fingerprint, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            params: [
              id,
              senderIdentityId,
              input.templateKind,
              templateVersion,
              actorUserId,
              inputFingerprint,
              at,
              at,
            ],
          },
        ])
      } catch (error) {
        const raced = await readTestSendCommand(id)
        if (raced !== null) return { record: replay(raced), claimed: false }
        throw error
      }
      const created = await readTestSendCommand(id)
      if (created === null) throw new Error('email test-send command did not begin')
      return { record: replay(created), claimed: true }
    },

    async completeTestSend(input) {
      const id = commandId(input.commandId)
      const actorUserId = positiveId(input.actorUserId, 'actorUserId')
      const deliveryId = positiveId(input.deliveryId, 'deliveryId')
      const at = timestamp(input.occurredAt, 'occurredAt')
      const prior = await readTestSendCommand(id)
      if (prior === null || prior.actorUserId !== actorUserId) {
        throw new EmailConfigurationError('command_id_reused', 'Test-send command was not reserved.')
      }
      if (prior.status === 'completed' && prior.deliveryId === deliveryId) return prior
      if (prior.status !== 'pending') {
        throw new EmailConfigurationError('command_id_reused', 'Test-send command is already complete.')
      }
      await atomic(database, [
        {
          text: `UPDATE email_test_send_commands
            SET status = 'completed', delivery_id = ?, updated_at = ?
            WHERE command_id = ? AND actor_user_id = ? AND status = 'pending'`,
          params: [deliveryId, at, id, actorUserId],
        },
        { text: `INSERT INTO _email_configuration_assertions (ok) VALUES (changes())` },
        { text: `DELETE FROM _email_configuration_assertions` },
      ])
      const completed = await readTestSendCommand(id)
      if (completed === null || completed.status !== 'completed') {
        throw new Error('email test-send command did not complete')
      }
      return completed
    },

    async failTestSend(input) {
      const id = commandId(input.commandId)
      const actorUserId = positiveId(input.actorUserId, 'actorUserId')
      const at = timestamp(input.occurredAt, 'occurredAt')
      if (!emailTestSendFailureCodes.has(input.failureCode)) {
        throw new EmailConfigurationError('invalid_input', 'Test-send failure code is invalid.')
      }
      const prior = await readTestSendCommand(id)
      if (prior === null || prior.actorUserId !== actorUserId) {
        throw new EmailConfigurationError('command_id_reused', 'Test-send command was not reserved.')
      }
      if (prior.status === 'failed' && prior.failureCode === input.failureCode) return prior
      if (prior.status !== 'pending') {
        throw new EmailConfigurationError('command_id_reused', 'Test-send command is already complete.')
      }
      await atomic(database, [
        {
          text: `UPDATE email_test_send_commands
            SET status = 'failed', failure_code = ?, updated_at = ?
            WHERE command_id = ? AND actor_user_id = ? AND status = 'pending'`,
          params: [input.failureCode, at, id, actorUserId],
        },
        { text: `INSERT INTO _email_configuration_assertions (ok) VALUES (changes())` },
        { text: `DELETE FROM _email_configuration_assertions` },
      ])
      const failed = await readTestSendCommand(id)
      if (failed === null || failed.status !== 'failed') {
        throw new Error('email test-send command did not fail')
      }
      return failed
    },

    async resolveSenderIdentity(id) {
      const row = await first<RawSender>(
        database,
        id === undefined
          ? `${senderSelect} WHERE identity.archived_at IS NULL
             ORDER BY identity.is_default DESC, identity.id LIMIT 1`
          : `${senderSelect} WHERE identity.id = ? AND identity.archived_at IS NULL`,
        id === undefined ? [] : [positiveId(id, 'sender identity id')],
      )
      return row === null ? null : senderRecord(row)
    },
  }
}

export const createContainerEmailConfigurationStore = (
  database: BetterSqlite3.Database,
): EmailConfigurationStore => createStore(database)

export const createD1EmailConfigurationStore = (
  database: D1Database,
): EmailConfigurationStore => createStore(database)
