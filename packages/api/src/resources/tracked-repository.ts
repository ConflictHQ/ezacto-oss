import type { ApprovalStatus, TrackedState } from '@ezacto/core'
import type { CursorSource } from '../pagination.js'

export interface ResourceTimeBoundary {
  instant: string
  date: string
  time: string
}

export interface TrackedResourceClock {
  now(): ResourceTimeBoundary
}

interface TrackedRecord {
  id: number
  harvestId: string | number | null
  userId: number
  projectId: number
  spentDate: string
  notes: string | null
  billable: boolean
  approvalStatus: ApprovalStatus
  /**
   * The approval state the row carried in the system it came from. Held apart
   * from `approvalStatus` because an instance with the approval module off
   * resets that column to `unsubmitted` for every row, imported or not, and
   * the imported answer would otherwise be lost. Null on native rows.
   */
  sourceApprovalStatus: ApprovalStatus | null
  invoiceId: number | null
  createdAt: string
  updatedAt: string
  state: TrackedState
}

export interface TimeEntryRecord extends TrackedRecord {
  harvestId: string | null
  taskId: number
  userAssignmentId: number
  taskAssignmentId: number
  seconds: number
  secondsWithoutTimer: number
  roundedSeconds: number
  timerStartedAt: string | null
  startedTime: string | null
  endedTime: string | null
  budgeted: boolean
  billableRateCents: number | null
  costRateCents: number | null
  externalRef: Record<string, unknown> | null
  calendarEventRef: Record<string, unknown> | null
  noteMinimumLength: number
}

export interface TimeEntryOption {
  projectId: number
  taskId: number
  noteMinimumLength: number
}

export interface OrganizationTimeEntryNoteSettings {
  required: boolean
  minimumLength: number
}

export interface OrganizationTimeEntrySettings {
  mode: 'duration' | 'start_end'
  timeFormat: 'decimal' | 'hours_minutes'
  clock: '12h' | '24h'
  weekStartDay: 'saturday' | 'sunday' | 'monday'
}

export interface UpdateOrganizationTimeEntryNoteSettings {
  required?: boolean
  minimumLength?: number
}

export type ReimbursementStatus = 'none' | 'pending' | 'approved' | 'paid'

export interface ExpenseRecord extends TrackedRecord {
  harvestId: number | null
  expenseCategoryId: number
  units: number | null
  totalCostCents: number
  reimbursable: boolean
  reimbursementStatus: ReimbursementStatus
  payoutRef: string | null
}

export interface TimeEntryFilters {
  clientId?: number
  projectId?: number
  taskId?: number
  spentDate?: string
  from?: string
  to?: string
  approvalStatus?: ApprovalStatus
  invoiceId?: number
  isBilled?: boolean
  isRunning?: boolean
  billable?: boolean
  budgeted?: boolean
  externalReferenceId?: string
  updatedSince?: string
}

export interface ExpenseFilters {
  clientId?: number
  projectId?: number
  expenseCategoryId?: number
  spentDate?: string
  from?: string
  to?: string
  approvalStatus?: ApprovalStatus
  invoiceId?: number
  isBilled?: boolean
  billable?: boolean
  reimbursable?: boolean
  reimbursementStatus?: ReimbursementStatus
  updatedSince?: string
}

export interface CreateTimeEntryRequest {
  projectId: number
  taskId: number
  spentDate?: string
  seconds?: number
  startedTime?: string
  endedTime?: string
  notes?: string | null
  budgeted?: boolean
  externalRef?: Record<string, unknown> | null
  calendarEventRef?: Record<string, unknown> | null
}

export interface UpdateTimeEntryRequest {
  projectId?: number
  taskId?: number
  spentDate?: string
  seconds?: number
  startedTime?: string
  endedTime?: string
  notes?: string | null
  budgeted?: boolean
  externalRef?: Record<string, unknown> | null
  calendarEventRef?: Record<string, unknown> | null
}

export interface CreateExpenseRequest {
  projectId: number
  expenseCategoryId: number
  spentDate: string
  notes?: string | null
  units?: number
  totalCostCents?: number
  billable?: boolean
  reimbursable?: boolean
}

export interface UpdateExpenseRequest {
  projectId?: number
  expenseCategoryId?: number
  spentDate?: string
  notes?: string | null
  units?: number
  totalCostCents?: number
  billable?: boolean
  reimbursable?: boolean
}

export interface TrackedResourceRepository {
  timeEntrySettings(): Promise<OrganizationTimeEntrySettings>
  timeEntryNoteSettings(): Promise<OrganizationTimeEntryNoteSettings>
  updateTimeEntryNoteSettings(
    input: Readonly<UpdateOrganizationTimeEntryNoteSettings>,
    updatedAt: string,
  ): Promise<OrganizationTimeEntryNoteSettings>
  timeEntryOptions(userId: number): Promise<readonly TimeEntryOption[]>
  timeEntries(
    userId: number,
    filters: Readonly<TimeEntryFilters>,
  ): CursorSource<TimeEntryRecord>
  expenses(
    userId: number,
    filters: Readonly<ExpenseFilters>,
  ): CursorSource<ExpenseRecord>
  getTimeEntry(userId: number, id: number): Promise<TimeEntryRecord>
  getExpense(userId: number, id: number): Promise<ExpenseRecord>
  createTimeEntry(
    userId: number,
    input: Readonly<CreateTimeEntryRequest>,
    boundary: ResourceTimeBoundary,
  ): Promise<TimeEntryRecord>
  updateTimeEntry(
    userId: number,
    id: number,
    input: Readonly<UpdateTimeEntryRequest>,
    boundary: ResourceTimeBoundary,
  ): Promise<TimeEntryRecord>
  deleteTimeEntry(userId: number, id: number): Promise<TimeEntryRecord>
  stopTimeEntry(
    userId: number,
    id: number,
    boundary: ResourceTimeBoundary,
  ): Promise<TimeEntryRecord>
  restartTimeEntry(
    userId: number,
    id: number,
    boundary: ResourceTimeBoundary,
  ): Promise<TimeEntryRecord>
  createExpense(
    userId: number,
    input: Readonly<CreateExpenseRequest>,
    boundary: ResourceTimeBoundary,
  ): Promise<ExpenseRecord>
  updateExpense(
    userId: number,
    id: number,
    input: Readonly<UpdateExpenseRequest>,
    boundary: ResourceTimeBoundary,
  ): Promise<ExpenseRecord>
  deleteExpense(userId: number, id: number): Promise<ExpenseRecord>
}
