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

/**
 * A mark this instance holds in its own object store (#489), as the render path
 * sees it: a slot and the URL it is served from.
 *
 * `wordmark_light` is the mark for a light ground and `wordmark_dark` the mark
 * for a dark one. That is the ground, not the ink — the app topbar and the
 * sign-in splash are both painted `--ez-ink`, so they take `wordmark_dark`,
 * and the document shell an invoice is read on is `--ez-ground`, so it takes
 * `wordmark_light`. Named for the ink instead, an operator uploads a
 * dark-on-transparent mark to the slot that draws on near-black and it
 * disappears.
 */
export interface StoredBrandAsset {
  readonly slot: 'wordmark_light' | 'wordmark_dark' | 'favicon'
  readonly url: string
}

const brandFieldForSlot: Readonly<
  Record<StoredBrandAsset['slot'], 'wordmarkLight' | 'wordmarkDark' | 'favicon'>
> = {
  wordmark_light: 'wordmarkLight',
  wordmark_dark: 'wordmarkDark',
  favicon: 'favicon',
}

export const brandFromStoredAssets = (
  assets: readonly StoredBrandAsset[],
): Partial<DeploymentBrand> | undefined => {
  const partial: Partial<DeploymentBrand> = Object.fromEntries(
    assets
      .filter((asset) => asset.url !== '' && asset.slot in brandFieldForSlot)
      .map((asset) => [brandFieldForSlot[asset.slot], asset.url]),
  )
  return Object.keys(partial).length > 0 ? partial : undefined
}

/**
 * The two sources of a brand mark, in order. An uploaded mark wins over the
 * deploy-time URL for the same slot, because uploading one is the newer and
 * more deliberate act: an operator who has just used the settings screen is not
 * expecting a repository variable set months ago to keep the old logo on the
 * sign-in page. The env vars are not deprecated by that — they stay the
 * fallback, so a deployment that already sets them and never uploads anything
 * renders exactly what it rendered before, and removing an uploaded mark
 * returns the slot to whatever the deployment configured.
 *
 * Per slot, not per source: a stored favicon does not displace a configured
 * wordmark, so a half-uploaded brand is half-uploaded rather than half-blank.
 */
export const brandFromSources = (
  env: Record<string, string | undefined>,
  storedAssets: readonly StoredBrandAsset[] = [],
): Partial<DeploymentBrand> | undefined => {
  const partial: Partial<DeploymentBrand> = {
    ...brandFromEnv(env),
    ...brandFromStoredAssets(storedAssets),
  }
  return Object.keys(partial).length > 0 ? partial : undefined
}
