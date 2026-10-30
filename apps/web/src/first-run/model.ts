/** Setup state comes from the same native resources used by the setup screens. */
export interface FirstRunStatus {
  readonly hasTimeEntry: boolean
  readonly hasClient: boolean
  readonly hasProject: boolean
  readonly hasTask: boolean
  readonly hasProjectTask: boolean
  readonly hasOwnAssignment: boolean
  readonly projectId: number | null
}

export interface FirstRunApi {
  /** Null means the signed-in person is not the organization owner. */
  getFirstRunStatus(
    userId: number,
    signal?: AbortSignal,
    includeCompletedSetup?: boolean,
  ): Promise<FirstRunStatus | null>
}
