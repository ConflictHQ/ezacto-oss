export const clientBudgetsMigration = [
  `ALTER TABLE clients ADD COLUMN budget_cents INTEGER
    CHECK (budget_cents IS NULL OR budget_cents BETWEEN 0 AND 9000000000000)`,
] as const
