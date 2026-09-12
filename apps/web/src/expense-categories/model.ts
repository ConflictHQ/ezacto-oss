import type {
  ExpenseCategory,
  ExpenseCategoryInput,
  ExpenseCategoryPatch,
  Whoami,
} from '@conflict-hq/ezacto-client'

export type ExpenseCategoryFilter = 'active' | 'all'
export type ExpenseCategoryMode = 'direct' | 'unit'

export interface ExpenseCategoryPage {
  readonly data: readonly ExpenseCategory[]
  readonly page: { readonly next_cursor: string | null }
}

export interface ExpenseCategoryDirectoryApi {
  listDirectoryExpenseCategories(
    activeOnly: boolean,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ExpenseCategoryPage>
  createDirectoryExpenseCategory(
    input: ExpenseCategoryInput,
    signal?: AbortSignal,
  ): Promise<ExpenseCategory>
  updateDirectoryExpenseCategory(
    id: number,
    patch: ExpenseCategoryPatch,
    signal?: AbortSignal,
  ): Promise<ExpenseCategory>
  archiveDirectoryExpenseCategory(
    id: number,
    signal?: AbortSignal,
  ): Promise<ExpenseCategory>
}

export interface ExpenseCategoryFormValues {
  readonly name: string
  readonly mode: ExpenseCategoryMode
  readonly unitName: string
  readonly unitPriceCents: string
}

const centsLimit = 9_000_000_000_000n

export const expenseCategoryCanWrite = (
  identity: Pick<Whoami, 'authentication' | 'profile'>,
): boolean =>
  identity.profile === 'administrator' && identity.authentication.kind === 'session'

export const expenseCategoryFilterFromUrl = (url: URL): ExpenseCategoryFilter =>
  url.searchParams.get('status') === 'all' ? 'all' : 'active'

export const expenseCategoryFilterUrl = (filter: ExpenseCategoryFilter): string =>
  filter === 'all' ? '/expense-categories?status=all' : '/expense-categories'

export const expenseCategoryUnitPriceCents = (raw: string): number => {
  const value = raw.trim()
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error('Unit price must be a whole number of cents that is zero or greater.')
  }
  const cents = BigInt(value)
  if (cents > centsLimit) throw new Error('Unit price is too large.')
  return Number(cents)
}

export const expenseCategoryInput = (
  values: Readonly<ExpenseCategoryFormValues>,
): ExpenseCategoryInput => {
  const name = values.name.trim()
  if (name === '') throw new Error('Enter a category name.')
  if (name.length > 255) throw new Error('Category name must be 255 characters or fewer.')
  if (values.mode === 'direct') {
    return { name, unit_name: null, unit_price_cents: null }
  }
  const unitName = values.unitName.trim()
  if (unitName === '') throw new Error('Enter a unit name for a unit-priced category.')
  if (unitName.length > 255) throw new Error('Unit name must be 255 characters or fewer.')
  if (values.unitPriceCents.trim() === '') {
    throw new Error('Enter a unit price in exact cents for a unit-priced category.')
  }
  return {
    name,
    unit_name: unitName,
    unit_price_cents: expenseCategoryUnitPriceCents(values.unitPriceCents),
  }
}

export const expenseCategoryMode = (
  category: Readonly<ExpenseCategory>,
): ExpenseCategoryMode =>
  category.unit_name === null && category.unit_price_cents === null ? 'direct' : 'unit'

export const expenseCategoryPricingLabel = (
  category: Readonly<ExpenseCategory>,
): string => {
  if (category.unit_name === null && category.unit_price_cents === null) {
    return 'Amount entered on each expense'
  }
  if (category.unit_name === null || category.unit_price_cents === null) {
    return 'Incomplete unit pricing'
  }
  return `${new Intl.NumberFormat('en-US').format(category.unit_price_cents)} cents per ${category.unit_name}`
}

export const expenseCategoryPatch = (
  values: Readonly<ExpenseCategoryFormValues>,
): ExpenseCategoryPatch => expenseCategoryInput(values)
