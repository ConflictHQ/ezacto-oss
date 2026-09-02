import { describe, expect, it, vi } from 'vitest'
import {
  createApiApp,
  installEmailConfigurationRoutes,
  type EmailConfigurationService,
  type EmailTemplateConfigurationRecord,
  type SenderIdentityConfigurationRecord,
  type SenderIdentityVerifier,
} from '../src/index.js'

const now = '2026-09-02T00:00:00.000Z'

const template: EmailTemplateConfigurationRecord = {
  kind: 'invoice',
  version: 1,
  subjectTemplate: 'Invoice %invoice_id% from %company_name%',
  textTemplate: 'Invoice %invoice_id% is due %invoice_due_date%.',
  htmlTemplate: null,
  unknownVariablePolicy: 'error',
  createdByUserId: null,
  createdAt: '1970-01-01T00:00:00.000Z',
}

const sender = (
  evidence: SenderIdentityConfigurationRecord['evidence'] = null,
): SenderIdentityConfigurationRecord => ({
  id: 41,
  email: 'billing@example.test',
  displayName: 'Example Billing',
  replyToEmail: 'accounts@example.test',
  provider: 'ses',
  providerIdentity: 'example.test',
  isDefault: false,
  version: 0,
  archivedAt: null,
  createdByUserId: 7,
  createdAt: now,
  updatedAt: now,
  evidence,
})

const verifiedEvidence = {
  version: 1,
  source: 'provider_api' as const,
  identityKind: 'domain' as const,
  verificationStatus: 'verified' as const,
  dkimStatus: 'verified' as const,
  mailFromDomain: 'mail.example.test',
  mailFromStatus: 'verified' as const,
  observedAt: now,
}

const service = (): EmailConfigurationService => ({
  listTemplates: vi.fn(async () => [template]),
  listTemplateVersions: vi.fn(async () => [template]),
  createTemplateVersion: vi.fn(async (input) => ({
    ...template,
    version: input.expectedVersion + 1,
    subjectTemplate: input.subjectTemplate,
    textTemplate: input.textTemplate,
    htmlTemplate: input.htmlTemplate ?? null,
    unknownVariablePolicy: input.unknownVariablePolicy ?? 'error',
    createdByUserId: input.actorUserId,
    createdAt: input.occurredAt,
  })),
  listSenderIdentities: vi.fn(async () => [sender()]),
  getSenderIdentity: vi.fn(async () => sender()),
  createSenderIdentity: vi.fn(async (input) => ({
    ...sender(),
    id: input.id,
    email: input.email,
    displayName: input.displayName,
    replyToEmail: input.replyToEmail ?? null,
    provider: input.provider,
    providerIdentity: input.providerIdentity,
    createdByUserId: input.actorUserId,
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
  })),
  updateSenderIdentity: vi.fn(async (input) => ({
    ...sender(),
    displayName: input.displayName ?? sender().displayName,
    replyToEmail:
      input.replyToEmail === undefined ? sender().replyToEmail : input.replyToEmail,
    version: input.expectedVersion + 1,
    updatedAt: input.occurredAt,
  })),
  recordSenderEvidence: vi.fn(async () => sender(verifiedEvidence)),
  replaySenderEvidence: vi.fn(async () => null),
  setDefaultSenderIdentity: vi.fn(async () => ({
    ...sender(verifiedEvidence),
    isDefault: true,
    version: 1,
  })),
  archiveSenderIdentity: vi.fn(async () => ({
    ...sender(),
    version: 1,
    archivedAt: now,
  })),
})

const harness = (
  profile: 'administrator' | 'member',
  configuration = service(),
  verifier?: SenderIdentityVerifier,
) => {
  const app = createApiApp({
    authentication: {
      sessions: {
        resolve: async () => ({
          type: 'user' as const,
          userId: 7,
          profile,
          managerGrants: [],
          authentication: { kind: 'session' as const, sessionId: 'session-7' },
        }),
      },
      tokens: {
        authenticate: async () => ({
          tokenId: 3,
          userId: 7,
          profile: 'administrator',
          scopes: ['invoices:read'],
        }),
        issue: vi.fn(),
        list: vi.fn(),
        revoke: vi.fn(),
      },
    },
    installApi(api) {
      installEmailConfigurationRoutes(api, {
        service: configuration,
        ...(verifier === undefined ? {} : { verifier }),
        clock: () => now,
      })
    },
  })
  return { app, service: configuration }
}

const mutation = (body: unknown, idempotency = 'email-config-1') => ({
  method: 'POST',
  headers: {
    origin: 'http://localhost',
    'content-type': 'application/json',
    'idempotency-key': idempotency,
  },
  body: JSON.stringify(body),
})

describe('email configuration API', () => {
  it('[api] exposes the closed, source-labelled template vocabulary to administrators', async () => {
    const { app } = harness('administrator')
    const response = await app.request('/api/v1/email-template-variables')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: Array<{
        kind: string
        variables: Array<{ compatibility: string; token: string }>
      }>
    }
    expect(body.data.map((entry: { kind: string }) => entry.kind)).toEqual([
      'invoice',
      'reminder',
      'thank_you',
      'auth_email_verification',
      'auth_password_reset',
    ])
    expect(
      body.data
        .find((entry: { kind: string }) => entry.kind === 'invoice')!
        .variables.filter((variable: { compatibility: string }) =>
          variable.compatibility === 'harvest',
        )
        .map((variable: { token: string }) => variable.token),
    ).toEqual([
      '%company_name%',
      '%invoice_id%',
      '%invoice_issue_month_name%',
      '%invoice_issue_year%',
    ])
  })

  it('[security] confines all email configuration surfaces to administrator sessions', async () => {
    const member = harness('member')
    expect((await member.app.request('/api/v1/email-templates')).status).toBe(403)
    expect((await member.app.request('/api/v1/sender-identities')).status).toBe(403)

    const admin = harness('administrator')
    const tokenResponse = await admin.app.request('/api/v1/email-templates', {
      headers: { authorization: 'Bearer test-token' },
    })
    expect(tokenResponse.status).toBe(403)
    expect(await tokenResponse.json()).toMatchObject({ error: { code: 'session_required' } })
  })

  it('[api] appends an immutable template version with explicit concurrency and idempotency', async () => {
    const configuration = service()
    const { app } = harness('administrator', configuration)
    const response = await app.request(
      '/api/v1/email-templates/invoice/versions',
      mutation({
        expected_version: 1,
        subject_template: 'Invoice %invoice_id%',
        text_template: 'Due %invoice_due_date%',
        html_template: null,
        unknown_variable_policy: 'literal',
      }, 'template-append-1'),
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      data: { kind: 'invoice', version: 2, created_by_user_id: 7 },
    })
    expect(configuration.createTemplateVersion).toHaveBeenCalledWith({
      kind: 'invoice',
      expectedVersion: 1,
      subjectTemplate: 'Invoice %invoice_id%',
      textTemplate: 'Due %invoice_due_date%',
      htmlTemplate: null,
      unknownVariablePolicy: 'literal',
      actorUserId: 7,
      commandId: 'template-append-1',
      occurredAt: now,
    })
  })

  it('[security] derives verification evidence from the provider and replays before provider I/O', async () => {
    const configuration = service()
    vi.mocked(configuration.replaySenderEvidence)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(sender(verifiedEvidence))
    const verifier: SenderIdentityVerifier = {
      provider: 'ses',
      verify: vi.fn(async () => ({
        identityKind: 'domain',
        verificationStatus: 'verified',
        dkimStatus: 'verified',
        mailFromDomain: 'mail.example.test',
        mailFromStatus: 'verified',
        observedAt: now,
      } as const)),
    }
    const { app } = harness('administrator', configuration, verifier)
    const request = () =>
      app.request(
        '/api/v1/sender-identities/41/refresh',
        mutation({ expected_evidence_version: 0 }, 'refresh-41'),
      )

    expect((await request()).status).toBe(200)
    expect((await request()).status).toBe(200)
    expect(verifier.verify).toHaveBeenCalledTimes(1)
    expect(configuration.recordSenderEvidence).toHaveBeenCalledWith({
      id: 41,
      expectedEvidenceVersion: 0,
      evidence: {
        identityKind: 'domain',
        verificationStatus: 'verified',
        dkimStatus: 'verified',
        mailFromDomain: 'mail.example.test',
        mailFromStatus: 'verified',
        observedAt: now,
      },
      actorUserId: 7,
      commandId: 'refresh-41',
      occurredAt: now,
    })

    const injected = await app.request(
      '/api/v1/sender-identities/41/refresh',
      mutation({ expected_evidence_version: 1, verification_status: 'verified' }, 'inject-41'),
    )
    expect(injected.status).toBe(422)
    expect(verifier.verify).toHaveBeenCalledTimes(1)
  })
})
