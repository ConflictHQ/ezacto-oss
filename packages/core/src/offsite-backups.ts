export class OffsiteBackupError extends Error {
  readonly code = 'E14'
  constructor(message: string) {
    super(message)
    this.name = 'OffsiteBackupError'
  }
}
export interface OffsiteBackupRun {
  id: string
  backup_run_id: number
  status: 'pending' | 'running' | 'completed' | 'failed'
  started_at: string
  completed_at: string | null
  uploaded_objects: number
  total_objects: number
  error_message: string | null
}
export interface OffsiteBackupStatus {
  configured: boolean
  state: 'disabled' | 'misconfigured' | 'waiting' | 'running' | 'completed' | 'failed'
  destination: string | null
  last_completed: OffsiteBackupRun | null
  latest: OffsiteBackupRun | null
  error: { code: 'E14'; message: string } | null
}
