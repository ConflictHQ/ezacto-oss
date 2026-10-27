export class GithubPublicationError extends Error {
  constructor(readonly code: 'invalid' | 'forbidden' | 'conflict' | 'unavailable') {
    super(code)
  }
}
export interface GithubPublicationAuthority {
  userId: number
  sessionId: number
}
export interface GithubPublicationRow {
  id: number
  connection_id: string
  entry_id: number
  destination: string
  spent_date: string | null
  seconds: number | null
  status: string
  source_version: number
  version: number
  remote_id: string | null
  failure_code: string | null
  next_retry_at: number | null
}
export interface GithubPublicationPreview {
  link_id: number
  connection_id: string
  destination: string
  spent_date: string
  seconds: number
  source_version: string
  policy_enabled: boolean
}
export interface GithubPublicationPort {
  list(authority: GithubPublicationAuthority): Promise<{
    policies: { connection_id: string; enabled: boolean; generation: number }[]
    publications: GithubPublicationRow[]
    candidates: { link_id: number; entry_id: number }[]
  }>
  preview(authority: GithubPublicationAuthority, linkId: number): Promise<GithubPublicationPreview>
  policy(
    authority: GithubPublicationAuthority,
    input: {
      connection_id: string
      expected_generation: number
      enabled: boolean
      confirm_permission: boolean
      command_id: string
    },
  ): Promise<void>
  consent(
    authority: GithubPublicationAuthority,
    input: { link_id: number; source_version: string; command_id: string },
  ): Promise<void>
  act(
    authority: GithubPublicationAuthority,
    input: {
      id: number
      expected_version: number
      action: 'retry' | 'adopt' | 'restore' | 'unlink'
      confirm: boolean
      command_id: string
    },
  ): Promise<void>
}
