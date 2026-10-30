/**
 * Work-item integrations (issue 1008, slice 1): the provider-neutral rules for
 * connecting an issue tracker and linking its items to time.
 *
 * Nothing here knows how a tracker is reached. A provider is a name and the
 * name of the deployment secret that holds its credential; everything else a
 * provider does lives behind `WorkItemProvider` in `@ezacto/integrations`.
 */

/**
 * The providers an instance can connect. The value names the deployment secret
 * that holds the credential, which is chosen here and never by a caller: a
 * connect request that could name its own secret could point a provider at any
 * secret the deployment holds.
 */
export const workItemProviders = {
  github: { credentialSecret: 'GITHUB_WORK_ITEMS_CREDENTIAL' },
} as const

export type WorkItemProviderId = keyof typeof workItemProviders

export const isWorkItemProvider = (value: unknown): value is WorkItemProviderId =>
  typeof value === 'string' && Object.hasOwn(workItemProviders, value)

export const workItemConnectionStatuses = ['active', 'disconnected'] as const
export type WorkItemConnectionStatus = (typeof workItemConnectionStatuses)[number]

export const maximumWorkItemIdLength = 256
export const maximumWorkItemUrlLength = 2048

/**
 * A provider's own identity for an item (for GitHub, `owner/repo#123`). Opaque
 * to eZacto beyond being a single printable token: it is compared byte for
 * byte, so two spellings of one item are the provider adapter's to reconcile
 * before they get here.
 */
export const normalizeWorkItemId = (value: string): string => {
  const trimmed = value.trim()
  if (
    trimmed === '' ||
    trimmed.length > maximumWorkItemIdLength ||
    // eslint-disable-next-line no-control-regex
    /[\s\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw new RangeError('A work item id is one printable token of at most 256 characters.')
  }
  return trimmed
}

/** Only an http(s) address is ever stored: the link is rendered as an anchor. */
export const normalizeWorkItemUrl = (value: string): string => {
  const trimmed = value.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new RangeError('A work item url must be an absolute http or https address.')
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    trimmed.length > maximumWorkItemUrlLength
  ) {
    throw new RangeError('A work item url must be an absolute http or https address.')
  }
  return parsed.href
}

export class WorkItemConnectionNotFoundError extends Error {
  readonly code = 'work_item_connection_not_found' as const

  constructor() {
    super('The requested work item connection does not exist.')
    this.name = 'WorkItemConnectionNotFoundError'
  }
}

/** A link cannot be made through a connection that was disconnected. */
export class WorkItemConnectionInactiveError extends Error {
  readonly code = 'work_item_connection_inactive' as const

  constructor() {
    super('This work item connection is disconnected.')
    this.name = 'WorkItemConnectionInactiveError'
  }
}

export class WorkItemLinkNotFoundError extends Error {
  readonly code = 'work_item_link_not_found' as const

  constructor() {
    super('The requested work item link does not exist.')
    this.name = 'WorkItemLinkNotFoundError'
  }
}

/** The time entry or project is missing, or is not the actor's to link. */
export class WorkItemTargetNotFoundError extends Error {
  readonly code = 'work_item_target_not_found' as const

  constructor(readonly target: 'time_entry' | 'project') {
    super(`The ${target === 'time_entry' ? 'time entry' : 'project'} to link does not exist.`)
    this.name = 'WorkItemTargetNotFoundError'
  }
}

/** The same target is already linked through this connection. */
export class WorkItemLinkExistsError extends Error {
  readonly code = 'work_item_link_exists' as const

  constructor() {
    super('That target is already linked through this connection.')
    this.name = 'WorkItemLinkExistsError'
  }
}
