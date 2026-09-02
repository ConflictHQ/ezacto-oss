import type { Context, Hono } from 'hono'
import {
  emailTemplateKinds,
  interpolateEmailTemplate,
  variablesForEmailTemplate,
  EmailTemplateVariableError,
  type EmailTemplateKind,
} from '@ezacto/core'
import {
  EmailQueueUnavailableError,
  SenderIdentityUnavailableError,
  type SenderBoundQueuedMailer,
  type SenderIdentityUnavailableCode,
} from '@ezacto/mailer'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext, UserPrincipal } from './context.js'
import { ApiError, readJsonBody, validationError, type FieldError } from './errors.js'

export interface EmailTemplateConfigurationRecord {
  kind: EmailTemplateKind
  version: number
  subjectTemplate: string
  textTemplate: string
  htmlTemplate: string | null
  unknownVariablePolicy: 'error' | 'literal'
  createdByUserId: number | null
  createdAt: string
}

export interface SenderEvidenceConfigurationRecord {
  version: number
  source: 'provider_api'
  identityKind: 'email_address' | 'domain'
  verificationStatus: 'pending' | 'verified' | 'failed' | 'temporary_failure'
  dkimStatus: 'pending' | 'verified' | 'failed' | 'not_applicable'
  mailFromDomain: string | null
  mailFromStatus: 'pending' | 'verified' | 'failed' | 'not_configured'
  observedAt: string
}

export interface SenderIdentityConfigurationRecord {
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
  evidence: SenderEvidenceConfigurationRecord | null
}

export interface EmailConfigurationService {
  listTemplates(): Promise<readonly EmailTemplateConfigurationRecord[]>
  getTemplate(
    kind: EmailTemplateKind,
    version?: number,
  ): Promise<EmailTemplateConfigurationRecord | null>
  getVerifiedUserEmail(userId: number): Promise<string | null>
  listTemplateVersions(kind: EmailTemplateKind): Promise<readonly EmailTemplateConfigurationRecord[]>
  createTemplateVersion(input: Readonly<{
    kind: EmailTemplateKind
    expectedVersion: number
    subjectTemplate: string
    textTemplate: string
    htmlTemplate?: string | null
    unknownVariablePolicy?: 'error' | 'literal'
    actorUserId: number
    commandId: string
    occurredAt: string
  }>): Promise<EmailTemplateConfigurationRecord>
  listSenderIdentities(): Promise<readonly SenderIdentityConfigurationRecord[]>
  getSenderIdentity(id: number): Promise<SenderIdentityConfigurationRecord | null>
  createSenderIdentity(input: Readonly<{
    id: number
    email: string
    displayName: string
    replyToEmail?: string | null
    provider: string
    providerIdentity: string
    actorUserId: number
    commandId: string
    occurredAt: string
  }>): Promise<SenderIdentityConfigurationRecord>
  updateSenderIdentity(input: Readonly<{
    id: number
    expectedVersion: number
    displayName?: string
    replyToEmail?: string | null
    actorUserId: number
    commandId: string
    occurredAt: string
  }>): Promise<SenderIdentityConfigurationRecord>
  recordSenderEvidence(input: Readonly<{
    id: number
    expectedEvidenceVersion: number
    evidence: Omit<SenderEvidenceConfigurationRecord, 'version' | 'source'>
    actorUserId: number
    commandId: string
    occurredAt: string
  }>): Promise<SenderIdentityConfigurationRecord>
  replaySenderEvidence(input: Readonly<{
    id: number
    expectedEvidenceVersion: number
    actorUserId: number
    commandId: string
  }>): Promise<SenderIdentityConfigurationRecord | null>
  setDefaultSenderIdentity(input: Readonly<{
    id: number
    expectedVersion: number
    actorUserId: number
    commandId: string
    occurredAt: string
  }>): Promise<SenderIdentityConfigurationRecord>
  archiveSenderIdentity(input: Readonly<{
    id: number
    expectedVersion: number
    actorUserId: number
    commandId: string
    occurredAt: string
  }>): Promise<SenderIdentityConfigurationRecord>
  beginTestSend(input: Readonly<{
    senderIdentityId: number
    templateKind: 'invoice' | 'reminder' | 'thank_you'
    templateVersion: number
    recipientEmail: string
    variables: Readonly<Record<string, string>>
    actorUserId: number
    commandId: string
    occurredAt: string
  }>): Promise<{
    claimed: boolean
    record: EmailTestSendCommandRecord
  }>
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
}

export type EmailTestSendFailureCode =
  | SenderIdentityUnavailableCode
  | 'email_queue_unavailable'

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

export interface ProviderSenderIdentityEvidence {
  identityKind: SenderEvidenceConfigurationRecord['identityKind']
  verificationStatus: SenderEvidenceConfigurationRecord['verificationStatus']
  dkimStatus: SenderEvidenceConfigurationRecord['dkimStatus']
  mailFromDomain: string | null
  mailFromStatus: SenderEvidenceConfigurationRecord['mailFromStatus']
  observedAt: string
}

export interface SenderIdentityVerifier {
  provider: string
  verify(
    identity: Readonly<SenderIdentityConfigurationRecord>,
    signal: AbortSignal,
  ): Promise<ProviderSenderIdentityEvidence>
}

export interface EmailConfigurationRouteOptions {
  service: EmailConfigurationService
  verifier?: SenderIdentityVerifier
  organizationMailer?: SenderBoundQueuedMailer
  clock(): string
}

interface ServiceError {
  code: string
  message: string
}

const serviceError = (error: unknown): error is ServiceError =>
  typeof error === 'object' &&
  error !== null &&
  typeof Reflect.get(error, 'code') === 'string' &&
  typeof Reflect.get(error, 'message') === 'string'

const translate = (error: unknown): never => {
  if (!serviceError(error)) throw error
  if (error.code === 'not_found') {
    throw new ApiError({ status: 404, code: 'not_found', message: error.message })
  }
  if (
    error.code === 'version_conflict' ||
    error.code === 'evidence_conflict' ||
    error.code === 'command_id_reused' ||
    error.code === 'sender_unverified'
  ) {
    throw new ApiError({ status: 409, code: error.code, message: error.message })
  }
  if (error.code === 'invalid_input') {
    throw validationError([
      { field: 'body', code: 'invalid', message: error.message },
    ])
  }
  throw error
}

const requireAdministrator = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): UserPrincipal => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator') {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can manage email templates and sender identities.',
    })
  }
  return principal
}

const objectBody = async (context: Parameters<typeof readJsonBody>[0]) => {
  const body = await readJsonBody<unknown>(context, { maxBytes: 2_100_000 })
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationError([
      { field: 'body', code: 'invalid_object', message: 'body must be a JSON object' },
    ])
  }
  return body as Record<string, unknown>
}

const unknownFields = (
  body: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): FieldError[] =>
  Object.keys(body)
    .filter((field) => !allowed.has(field))
    .map((field) => ({ field, code: 'unknown', message: `${field} is not accepted` }))

const stringField = (
  body: Readonly<Record<string, unknown>>,
  field: string,
  errors: FieldError[],
  options: { required?: boolean; nullable?: boolean; maximum?: number } = {},
): string | null | undefined => {
  const value = body[field]
  if (value === undefined) {
    if (options.required) errors.push({ field, code: 'required', message: `${field} is required` })
    return undefined
  }
  if (value === null && options.nullable) return null
  const maximum = options.maximum ?? 1_000_000
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    [...value].length > maximum ||
    value.includes('\u0000')
  ) {
    errors.push({ field, code: 'invalid_string', message: `${field} is invalid` })
    return undefined
  }
  return value
}

const integerField = (
  body: Readonly<Record<string, unknown>>,
  field: string,
  errors: FieldError[],
): number | undefined => {
  const value = body[field]
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    errors.push({ field, code: 'invalid_integer', message: `${field} must be a non-negative integer` })
    return undefined
  }
  return value as number
}

const idempotencyKey = <Bindings extends object>(context: Context<ApiContext<Bindings>>): string => {
  const value = context.req.header('idempotency-key')
  if (value === undefined || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
    throw validationError([
      {
        field: 'Idempotency-Key',
        code: value === undefined ? 'required' : 'invalid',
        message:
          'Idempotency-Key must use 1-128 ASCII letters, digits, dot, underscore, colon, or dash.',
      },
    ])
  }
  return value
}

const resourceId = (value: string | undefined): number => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) {
    throw validationError([{ field: 'id', code: 'invalid', message: 'id must be a positive integer' }])
  }
  const id = Number(value)
  if (!Number.isSafeInteger(id)) {
    throw validationError([{ field: 'id', code: 'invalid', message: 'id must be a positive integer' }])
  }
  return id
}

const stableId = async (actorUserId: number, command: string): Promise<number> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`sender-identity\u0000${actorUserId}\u0000${command}`),
    ),
  )
  let result = 0
  for (const byte of digest.slice(0, 6)) result = result * 256 + byte
  return result === 0 ? 1 : result
}

const templateData = (record: EmailTemplateConfigurationRecord) => ({
  kind: record.kind,
  version: record.version,
  subject_template: record.subjectTemplate,
  text_template: record.textTemplate,
  html_template: record.htmlTemplate,
  unknown_variable_policy: record.unknownVariablePolicy,
  created_by_user_id: record.createdByUserId,
  created_at: record.createdAt,
})

const senderData = (record: SenderIdentityConfigurationRecord) => ({
  id: record.id,
  email: record.email,
  display_name: record.displayName,
  reply_to_email: record.replyToEmail,
  provider: record.provider,
  provider_identity: record.providerIdentity,
  is_default: record.isDefault,
  version: record.version,
  archived_at: record.archivedAt,
  evidence:
    record.evidence === null
      ? null
      : {
          version: record.evidence.version,
          source: record.evidence.source,
          identity_kind: record.evidence.identityKind,
          verification_status: record.evidence.verificationStatus,
          dkim_status: record.evidence.dkimStatus,
          mail_from_domain: record.evidence.mailFromDomain,
          mail_from_status: record.evidence.mailFromStatus,
          observed_at: record.evidence.observedAt,
        },
  created_by_user_id: record.createdByUserId,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
})

const testSendFailure = (
  code: EmailTestSendFailureCode,
  senderIdentityId: number,
): never => {
  if (code === 'email_queue_unavailable') {
    throw new ApiError({
      status: 503,
      code,
      message: 'The email queue did not accept the test message.',
    })
  }
  const error = new SenderIdentityUnavailableError(code, senderIdentityId)
  throw new ApiError({ status: 409, code: error.code, message: error.message })
}

const testSendData = (
  record: EmailTestSendCommandRecord,
  recipientEmail: string,
) => ({
  status: 'queued' as const,
  delivery_id: record.deliveryId,
  sender_identity_id: record.senderIdentityId,
  template_kind: record.templateKind,
  template_version: record.templateVersion,
  recipient_email: recipientEmail,
})

export const installEmailConfigurationRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: EmailConfigurationRouteOptions,
): void => {
  api.get('/email-template-variables', (context) => {
    requireAdministrator(context)
    return context.json(
      {
        data: emailTemplateKinds.map((kind) => ({
          kind,
          variables: variablesForEmailTemplate(kind).map((variable) => ({
            name: variable.name,
            token: variable.token,
            description: variable.description,
            compatibility: variable.compatibility,
          })),
        })),
        links: { self: '/api/v1/email-template-variables' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.get('/email-templates', async (context) => {
    requireAdministrator(context)
    return context.json(
      {
        data: (await options.service.listTemplates()).map(templateData),
        links: { self: '/api/v1/email-templates' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.get('/email-templates/:kind/versions', async (context) => {
    requireAdministrator(context)
    const kind = context.req.param('kind') as EmailTemplateKind
    if (!(emailTemplateKinds as readonly string[]).includes(kind)) {
      throw new ApiError({ status: 404, code: 'not_found', message: 'Email template kind not found.' })
    }
    return context.json(
      {
        data: (await options.service.listTemplateVersions(kind)).map(templateData),
        links: { self: `/api/v1/email-templates/${kind}/versions` },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/email-templates/:kind/versions', async (context) => {
    const principal = requireAdministrator(context)
    const commandId = idempotencyKey(context)
    const kind = context.req.param('kind') as EmailTemplateKind
    if (!(emailTemplateKinds as readonly string[]).includes(kind)) {
      throw new ApiError({ status: 404, code: 'not_found', message: 'Email template kind not found.' })
    }
    const body = await objectBody(context)
    const errors = unknownFields(
      body,
      new Set([
        'expected_version',
        'subject_template',
        'text_template',
        'html_template',
        'unknown_variable_policy',
      ]),
    )
    const expectedVersion = integerField(body, 'expected_version', errors)
    const subjectTemplate = stringField(body, 'subject_template', errors, {
      required: true,
      maximum: 998,
    })
    const textTemplate = stringField(body, 'text_template', errors, {
      required: true,
      maximum: 1_000_000,
    })
    const htmlTemplate = stringField(body, 'html_template', errors, {
      nullable: true,
      maximum: 2_000_000,
    })
    const unknownVariablePolicyValue = stringField(
      body,
      'unknown_variable_policy',
      errors,
      { maximum: 7 },
    )
    if (
      unknownVariablePolicyValue !== undefined &&
      unknownVariablePolicyValue !== 'error' &&
      unknownVariablePolicyValue !== 'literal'
    ) {
      errors.push({
        field: 'unknown_variable_policy',
        code: 'invalid_enum',
        message: 'unknown_variable_policy must be error or literal',
      })
    }
    const unknownVariablePolicy =
      unknownVariablePolicyValue === 'error' || unknownVariablePolicyValue === 'literal'
        ? unknownVariablePolicyValue
        : undefined
    if (errors.length > 0) throw validationError(errors)
    try {
      const created = await options.service.createTemplateVersion({
        kind,
        expectedVersion: expectedVersion!,
        subjectTemplate: subjectTemplate!,
        textTemplate: textTemplate!,
        ...(htmlTemplate === undefined ? {} : { htmlTemplate }),
        ...(unknownVariablePolicy === undefined
          ? {}
          : { unknownVariablePolicy }),
        actorUserId: principal.userId,
        commandId,
        occurredAt: options.clock(),
      })
      return context.json({ data: templateData(created) }, 201, { 'cache-control': 'no-store' })
    } catch (error) {
      translate(error)
    }
  })

  api.get('/sender-identities', async (context) => {
    requireAdministrator(context)
    return context.json(
      {
        data: (await options.service.listSenderIdentities()).map(senderData),
        links: { self: '/api/v1/sender-identities' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/sender-identities', async (context) => {
    const principal = requireAdministrator(context)
    const commandId = idempotencyKey(context)
    const body = await objectBody(context)
    const errors = unknownFields(
      body,
      new Set(['email', 'display_name', 'reply_to_email', 'provider', 'provider_identity']),
    )
    const address = stringField(body, 'email', errors, { required: true, maximum: 254 })
    const displayName = stringField(body, 'display_name', errors, {
      required: true,
      maximum: 200,
    })
    const replyToEmail = stringField(body, 'reply_to_email', errors, {
      nullable: true,
      maximum: 254,
    })
    const provider = stringField(body, 'provider', errors, { required: true, maximum: 64 })
    const providerIdentity = stringField(body, 'provider_identity', errors, {
      required: true,
      maximum: 320,
    })
    if (errors.length > 0) throw validationError(errors)
    try {
      const created = await options.service.createSenderIdentity({
        id: await stableId(principal.userId, commandId),
        email: address!,
        displayName: displayName!,
        ...(replyToEmail === undefined ? {} : { replyToEmail }),
        provider: provider!,
        providerIdentity: providerIdentity!,
        actorUserId: principal.userId,
        commandId,
        occurredAt: options.clock(),
      })
      return context.json({ data: senderData(created) }, 201, { 'cache-control': 'no-store' })
    } catch (error) {
      translate(error)
    }
  })

  api.post('/sender-identities/:id/test-send', async (context) => {
    const principal = requireAdministrator(context)
    const commandId = idempotencyKey(context)
    const senderIdentityId = resourceId(context.req.param('id'))
    const body = await objectBody(context)
    const errors = unknownFields(
      body,
      new Set(['template_kind', 'template_version', 'variables', 'confirmed']),
    )
    const rawKind = stringField(body, 'template_kind', errors, {
      required: true,
      maximum: 32,
    })
    const templateKind =
      rawKind === 'invoice' || rawKind === 'reminder' || rawKind === 'thank_you'
        ? rawKind
        : undefined
    if (rawKind !== undefined && templateKind === undefined) {
      errors.push({
        field: 'template_kind',
        code: 'invalid_enum',
        message: 'template_kind must be invoice, reminder, or thank_you',
      })
    }
    const templateVersion = integerField(body, 'template_version', errors)
    if (templateVersion === 0) {
      errors.push({
        field: 'template_version',
        code: 'invalid_integer',
        message: 'template_version must be a positive integer',
      })
    }
    if (body.confirmed !== true) {
      errors.push({
        field: 'confirmed',
        code: 'confirmation_required',
        message: 'confirmed must be true to queue a test email',
      })
    }
    const rawVariables = body.variables
    const variables: Record<string, string> = {}
    if (
      typeof rawVariables !== 'object' ||
      rawVariables === null ||
      Array.isArray(rawVariables)
    ) {
      errors.push({
        field: 'variables',
        code: 'invalid_object',
        message: 'variables must be an object',
      })
    } else if (templateKind !== undefined) {
      const allowed = new Set(
        variablesForEmailTemplate(templateKind).map((variable) => variable.name),
      )
      const entries = Object.entries(rawVariables)
      if (entries.length > 32) {
        errors.push({
          field: 'variables',
          code: 'too_many',
          message: 'variables must contain at most 32 entries',
        })
      }
      for (const [name, value] of entries) {
        if (!allowed.has(name)) {
          errors.push({
            field: `variables.${name}`,
            code: 'unknown',
            message: `${name} is not available to ${templateKind} templates`,
          })
        } else if (
          typeof value !== 'string' ||
          value.trim().length === 0 ||
          [...value].length > 2_000 ||
          value.includes('\u0000')
        ) {
          errors.push({
            field: `variables.${name}`,
            code: 'invalid_string',
            message: `${name} must be a non-empty string of at most 2000 characters`,
          })
        } else {
          variables[name] = value
        }
      }
    }
    if (errors.length > 0) throw validationError(errors)

    const [template, recipientEmail] = await Promise.all([
      options.service.getTemplate(templateKind!, templateVersion!),
      options.service.getVerifiedUserEmail(principal.userId),
    ])
    if (template === null) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The requested persisted email-template version does not exist.',
      })
    }
    if (recipientEmail === null) {
      throw new ApiError({
        status: 409,
        code: 'verified_admin_email_required',
        message: 'Verify an email address for the acting administrator before sending a test.',
      })
    }
    let subject: string
    let text: string
    let html: string | undefined
    try {
      subject = interpolateEmailTemplate(template.kind, template.subjectTemplate, variables, {
        unknownVariable: template.unknownVariablePolicy,
      })
      text = interpolateEmailTemplate(template.kind, template.textTemplate, variables, {
        unknownVariable: template.unknownVariablePolicy,
      })
      html =
        template.htmlTemplate === null
          ? undefined
          : interpolateEmailTemplate(template.kind, template.htmlTemplate, variables, {
              unknownVariable: template.unknownVariablePolicy,
              output: 'html',
            })
    } catch (error) {
      if (error instanceof EmailTemplateVariableError) {
        throw validationError([
          {
            field: `variables.${error.variable}`,
            code: error.code,
            message: error.message,
          },
        ])
      }
      throw error
    }
    const mailer = options.organizationMailer
    if (mailer === undefined) {
      throw new ApiError({
        status: 503,
        code: 'organization_mailer_unavailable',
        message: 'Organization email delivery is not configured for this deployment.',
      })
    }
    try {
      await mailer.assertAvailable(senderIdentityId)
    } catch (error) {
      if (error instanceof SenderIdentityUnavailableError) {
        throw new ApiError({ status: 409, code: error.code, message: error.message })
      }
      throw error
    }
    const claim = await options.service.beginTestSend({
        senderIdentityId,
        templateKind: templateKind!,
        templateVersion: templateVersion!,
        recipientEmail,
        variables,
        actorUserId: principal.userId,
        commandId,
        occurredAt: options.clock(),
      }).catch((error: unknown) => translate(error))
    if (!claim.claimed) {
      if (claim.record.status === 'completed') {
        return context.json(
          { data: testSendData(claim.record, recipientEmail) },
          202,
          { 'cache-control': 'no-store' },
        )
      }
      if (claim.record.status === 'failed') {
        testSendFailure(claim.record.failureCode!, senderIdentityId)
      }
      throw new ApiError({
        status: 409,
        code: 'test_send_in_progress',
        message: 'This test-send command is already in progress.',
      })
    }

    try {
      const delivery = await mailer.enqueue({
        senderIdentityId,
        to: [{ email: recipientEmail }],
        template: `${template.kind}:v${template.version}:test`,
        subject,
        text,
        ...(html === undefined ? {} : { html }),
      })
      const completed = await options.service.completeTestSend({
        commandId,
        actorUserId: principal.userId,
        deliveryId: delivery.id,
        occurredAt: options.clock(),
      })
      return context.json(
        { data: testSendData(completed, recipientEmail) },
        202,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      const failureCode =
        error instanceof SenderIdentityUnavailableError
          ? error.code
          : error instanceof EmailQueueUnavailableError
            ? 'email_queue_unavailable'
            : null
      if (failureCode === null) throw error
      await options.service.failTestSend({
        commandId,
        actorUserId: principal.userId,
        failureCode,
        occurredAt: options.clock(),
      })
      testSendFailure(failureCode, senderIdentityId)
    }
  })

  api.patch('/sender-identities/:id', async (context) => {
    const principal = requireAdministrator(context)
    const commandId = idempotencyKey(context)
    const id = resourceId(context.req.param('id'))
    const body = await objectBody(context)
    const errors = unknownFields(body, new Set(['expected_version', 'display_name', 'reply_to_email']))
    const expectedVersion = integerField(body, 'expected_version', errors)
    const displayName = stringField(body, 'display_name', errors, { maximum: 200 })
    const replyToEmail = stringField(body, 'reply_to_email', errors, {
      nullable: true,
      maximum: 254,
    })
    if (displayName === undefined && replyToEmail === undefined) {
      errors.push({ field: 'body', code: 'empty', message: 'At least one sender field is required' })
    }
    if (errors.length > 0) throw validationError(errors)
    try {
      const updated = await options.service.updateSenderIdentity({
        id,
        expectedVersion: expectedVersion!,
        ...(typeof displayName === 'string' ? { displayName } : {}),
        ...(replyToEmail === undefined ? {} : { replyToEmail }),
        actorUserId: principal.userId,
        commandId,
        occurredAt: options.clock(),
      })
      return context.json({ data: senderData(updated) }, 200, { 'cache-control': 'no-store' })
    } catch (error) {
      translate(error)
    }
  })

  const versionCommand = async (
    context: Context<ApiContext<Bindings>>,
    action: 'default' | 'archive',
  ) => {
    const principal = requireAdministrator(context)
    const commandId = idempotencyKey(context)
    const id = resourceId(context.req.param('id'))
    const body = await objectBody(context)
    const errors = unknownFields(body, new Set(['expected_version']))
    const expectedVersion = integerField(body, 'expected_version', errors)
    if (errors.length > 0) throw validationError(errors)
    try {
      const updated = await (action === 'default'
        ? options.service.setDefaultSenderIdentity({
            id,
            expectedVersion: expectedVersion!,
            actorUserId: principal.userId,
            commandId,
            occurredAt: options.clock(),
          })
        : options.service.archiveSenderIdentity({
            id,
            expectedVersion: expectedVersion!,
            actorUserId: principal.userId,
            commandId,
            occurredAt: options.clock(),
          }))
      return context.json({ data: senderData(updated) }, 200, { 'cache-control': 'no-store' })
    } catch (error) {
      translate(error)
    }
  }

  api.post('/sender-identities/:id/default', (context) => versionCommand(context, 'default'))
  api.post('/sender-identities/:id/archive', (context) => versionCommand(context, 'archive'))

  api.post('/sender-identities/:id/refresh', async (context) => {
    const principal = requireAdministrator(context)
    const commandId = idempotencyKey(context)
    const id = resourceId(context.req.param('id'))
    const body = await objectBody(context)
    const errors = unknownFields(body, new Set(['expected_evidence_version']))
    const expectedEvidenceVersion = integerField(body, 'expected_evidence_version', errors)
    if (errors.length > 0) throw validationError(errors)
    try {
      const replay = await options.service.replaySenderEvidence({
        id,
        expectedEvidenceVersion: expectedEvidenceVersion!,
        actorUserId: principal.userId,
        commandId,
      })
      if (replay !== null) {
        return context.json({ data: senderData(replay) }, 200, { 'cache-control': 'no-store' })
      }
    } catch (error) {
      translate(error)
    }
    const identity = await options.service.getSenderIdentity(id)
    if (identity === null) {
      throw new ApiError({ status: 404, code: 'not_found', message: 'Sender identity not found.' })
    }
    if (options.verifier === undefined || identity.provider !== options.verifier.provider) {
      throw new ApiError({
        status: 409,
        code: 'provider_verification_unavailable',
        message: `Provider verification is not configured for ${identity.provider}.`,
      })
    }
    const evidence = await options.verifier.verify(identity, context.req.raw.signal)
    try {
      const updated = await options.service.recordSenderEvidence({
        id,
        expectedEvidenceVersion: expectedEvidenceVersion!,
        evidence,
        actorUserId: principal.userId,
        commandId,
        occurredAt: options.clock(),
      })
      return context.json({ data: senderData(updated) }, 200, { 'cache-control': 'no-store' })
    } catch (error) {
      translate(error)
    }
  })
}
