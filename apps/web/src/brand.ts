export interface DeploymentBrand {
  readonly name: string
  readonly tagline: string
  readonly description: string
  readonly favicon?: string
  readonly wordmarkLight?: string
  readonly wordmarkDark?: string
  readonly emailSenderName?: string
}

export interface ReportBrand {
  readonly name: string
  readonly header?: string
  readonly footer?: string
}

export const defaultBrand: DeploymentBrand = {
  name: 'ezacto',
  tagline: 'Time, exactly.',
  description: 'Open-source time tracking and invoicing.',
}

export const defaultReportBrand: ReportBrand = {
  name: 'ezacto',
}

export const resolveDeploymentBrand = (override?: Partial<DeploymentBrand>): DeploymentBrand => {
  if (!override) return defaultBrand
  return {
    ...defaultBrand,
    ...Object.fromEntries(
      Object.entries(override).filter(([, v]) => v !== undefined && v !== ''),
    ),
  }
}

export const resolveReportBrand = (override?: Partial<ReportBrand>): ReportBrand => {
  if (!override) return defaultReportBrand
  return {
    ...defaultReportBrand,
    ...Object.fromEntries(
      Object.entries(override).filter(([, v]) => v !== undefined && v !== ''),
    ),
  }
}

export const brandFromEnv = (env: Record<string, string | undefined>): Partial<DeploymentBrand> | undefined => {
  const name = env.BRAND_NAME
  const tagline = env.BRAND_TAGLINE
  const description = env.BRAND_DESCRIPTION
  const favicon = env.BRAND_FAVICON
  const wordmarkLight = env.BRAND_WORDMARK_LIGHT
  const wordmarkDark = env.BRAND_WORDMARK_DARK
  const emailSenderName = env.BRAND_EMAIL_SENDER_NAME
  const partial: Partial<DeploymentBrand> = {
    ...(name ? { name } : {}),
    ...(tagline ? { tagline } : {}),
    ...(description ? { description } : {}),
    ...(favicon ? { favicon } : {}),
    ...(wordmarkLight ? { wordmarkLight } : {}),
    ...(wordmarkDark ? { wordmarkDark } : {}),
    ...(emailSenderName ? { emailSenderName } : {}),
  }
  return Object.keys(partial).length > 0 ? partial : undefined
}
