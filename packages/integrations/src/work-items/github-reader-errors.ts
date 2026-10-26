export type GithubReaderFailure =
  'forbidden' | 'conflict' | 'command_reused' | 'unavailable' | 'invalid'

/** Closed vocabulary shared by the native service and HTTP boundary. */
export class GithubReaderCommandError extends Error {
  constructor(readonly kind: GithubReaderFailure) {
    super('GitHub reader command could not be completed.')
    this.name = 'GithubReaderCommandError'
  }
}
