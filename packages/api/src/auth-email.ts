import {
  interpolateEmailTemplate,
  type EmailTemplateKind,
  type UnknownEmailTemplateVariablePolicy,
} from '@ezacto/core'
import type { SenderBoundQueuedMailer } from '@ezacto/mailer'
import type { AuthDelivery, AuthMailer } from './password-auth.js'

export interface AuthEmailTemplate {
  kind: EmailTemplateKind
  version: number
  subjectTemplate: string
  textTemplate: string
  htmlTemplate: string | null
  unknownVariablePolicy: UnknownEmailTemplateVariablePolicy
}

export interface AuthEmailTemplateSource {
  getTemplate(kind: EmailTemplateKind): Promise<AuthEmailTemplate | null>
}

const authKind = (delivery: AuthDelivery): EmailTemplateKind =>
  delivery.kind === 'verify_email'
    ? 'auth_email_verification'
    : 'auth_password_reset'

const actionUrl = (delivery: AuthDelivery, appOrigin: string): string => {
  const action = delivery.kind === 'verify_email' ? 'verify-email' : 'password-reset'
  const url = new URL('/', appOrigin)
  url.searchParams.set('auth', action)
  url.searchParams.set('token', delivery.token)
  return url.toString()
}

export const createQueuedAuthMailer = (
  mailer: SenderBoundQueuedMailer,
  templates: AuthEmailTemplateSource,
  organizationName: () => Promise<string>,
  appOrigin: string,
): AuthMailer => {
  const origin = new URL(appOrigin)
  if (origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') {
    throw new TypeError('APP_ORIGIN must be an absolute origin without a path')
  }
  if (origin.protocol !== 'https:' && origin.hostname !== 'localhost') {
    throw new TypeError('APP_ORIGIN must use HTTPS outside localhost')
  }
  return {
    enqueue: async (delivery) => {
      const kind = authKind(delivery)
      const [template, companyName] = await Promise.all([
        templates.getTemplate(kind),
        organizationName(),
      ])
      if (template === null || template.kind !== kind) {
        throw new Error(`active ${kind} email template is unavailable`)
      }
      const values = {
        company_name: companyName,
        action_url: actionUrl(delivery, origin.origin),
        expires_at: delivery.expiresAt,
      }
      await mailer.enqueue({
        to: [{ email: delivery.to }],
        template: `${kind}:v${template.version}`,
        subject: interpolateEmailTemplate(kind, template.subjectTemplate, values, {
          unknownVariable: template.unknownVariablePolicy,
        }),
        text: interpolateEmailTemplate(kind, template.textTemplate, values, {
          unknownVariable: template.unknownVariablePolicy,
        }),
        ...(template.htmlTemplate === null
          ? {}
          : {
              html: interpolateEmailTemplate(kind, template.htmlTemplate, values, {
                unknownVariable: template.unknownVariablePolicy,
                output: 'html',
              }),
            }),
      })
    },
  }
}
