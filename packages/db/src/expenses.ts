import { eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import { expenseCategories, expenses } from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

const moneyUpperBound = 9_000_000_000_000

export type Expense = typeof expenses.$inferSelect
export type ExpenseApprovalStatus = 'unsubmitted' | 'submitted' | 'approved'
export type ReimbursementStatus = 'none' | 'pending' | 'approved' | 'paid'

interface ExpenseBaseInput {
  userId: number
  projectId: number
  expenseCategoryId: number
  spentDate: string
  notes?: string | null
  billable?: boolean
  /** Marks reimbursement eligibility; workflow state still starts at none. */
  reimbursable?: boolean
  createdAt: string
  updatedAt: string
}

export type CreateExpenseInput = ExpenseBaseInput & {
  /** Native unit-priced input. The category price determines the stored total. */
  units?: number
  /** Native direct-cost input. Rejected when the category has a unit price. */
  totalCostCents?: number
}

const assertBoundedNonnegativeInteger = (
  value: number,
  field: string,
  upperBound: number,
): void => {
  if (!Number.isSafeInteger(value) || value < 0 || value > upperBound) {
    throw new RangeError(`${field} must be a non-negative safe integer at most ${upperBound}`)
  }
}

export const computeExpenseTotalCents = (
  unitPriceCents: number | null,
  input: Pick<CreateExpenseInput, 'units' | 'totalCostCents'>,
): { units: number | null; totalCostCents: number } => {
  if (unitPriceCents === null) {
    if (input.units !== undefined) {
      throw new Error('direct-cost expense categories do not accept units')
    }
    if (input.totalCostCents === undefined) {
      throw new Error('direct-cost expense categories require totalCostCents')
    }
    assertBoundedNonnegativeInteger(input.totalCostCents, 'totalCostCents', moneyUpperBound)
    return { units: null, totalCostCents: input.totalCostCents }
  }

  assertBoundedNonnegativeInteger(unitPriceCents, 'category unitPriceCents', moneyUpperBound)
  if (input.totalCostCents !== undefined) {
    throw new Error('unit-priced expense categories compute totalCostCents from units')
  }
  if (input.units === undefined) {
    throw new Error('unit-priced expense categories require units')
  }
  assertBoundedNonnegativeInteger(input.units, 'units', Number.MAX_SAFE_INTEGER)
  const totalCostCents = input.units * unitPriceCents
  assertBoundedNonnegativeInteger(totalCostCents, 'computed totalCostCents', moneyUpperBound)
  return { units: input.units, totalCostCents }
}

export const createExpense = async (
  database: Database,
  input: CreateExpenseInput,
): Promise<Expense> => {
  const usesUnits = input.units !== undefined
  const reimbursable = input.reimbursable ?? false
  if (usesUnits && input.totalCostCents !== undefined) {
    throw new Error('unit-priced expense categories compute totalCostCents from units')
  }
  if (!usesUnits && input.totalCostCents === undefined) {
    throw new Error('expense input requires units or totalCostCents')
  }
  if (usesUnits) {
    assertBoundedNonnegativeInteger(input.units!, 'units', Number.MAX_SAFE_INTEGER)
  } else {
    assertBoundedNonnegativeInteger(input.totalCostCents!, 'totalCostCents', moneyUpperBound)
  }

  // One INSERT ... SELECT observes the category mode and price exactly once. A
  // concurrent category edit therefore cannot leave an expense priced from a
  // stale read on either SQLite runtime.
  const inserted = await database.all<{ id: number }>(sql`
    INSERT INTO expenses (
      harvest_id, user_id, project_id, expense_category_id, spent_date, notes,
      units, total_cost_cents, billable, approval_status, invoice_id,
      reimbursable, reimbursement_status, payout_ref, created_at, updated_at
    )
    SELECT
      NULL, ${input.userId}, ${input.projectId}, category.id,
      ${input.spentDate}, ${input.notes ?? null},
      ${usesUnits ? input.units! : null},
      ${usesUnits ? sql`${input.units!} * category.unit_price_cents` : input.totalCostCents!},
      ${(input.billable ?? true) ? 1 : 0}, 'unsubmitted',
      NULL, ${reimbursable ? 1 : 0},
      'none', NULL,
      ${input.createdAt}, ${input.updatedAt}
    FROM expense_categories category
    WHERE category.id = ${input.expenseCategoryId}
      AND category.is_active = 1
      AND ${usesUnits ? sql`category.unit_price_cents IS NOT NULL` : sql`category.unit_price_cents IS NULL`}
      AND ${usesUnits ? sql`${input.units!} * category.unit_price_cents BETWEEN 0 AND ${moneyUpperBound}` : sql`1`}
    RETURNING id
  `)
  const insertedId = inserted[0]?.id
  if (insertedId === undefined) {
    const [category] = await database
      .select()
      .from(expenseCategories)
      .where(eq(expenseCategories.id, input.expenseCategoryId))
      .limit(1)
    if (!category) throw new Error(`expense category ${input.expenseCategoryId} does not exist`)
    if (!category.isActive)
      throw new Error(`expense category ${input.expenseCategoryId} is inactive`)
    computeExpenseTotalCents(category.unitPriceCents, input)
    throw new RangeError('computed totalCostCents exceeds the supported money range')
  }
  const [created] = await database
    .select()
    .from(expenses)
    .where(eq(expenses.id, insertedId))
    .limit(1)
  if (!created) throw new Error('expense creation did not return a row')
  return created
}
