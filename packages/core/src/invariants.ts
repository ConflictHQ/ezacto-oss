/** Stable, citable name shape for the domain invariants in docs/domain-model.md §8. */
export type InvariantName = `inv-${number}`;
export type InvariantRuntime = "sqlite" | "d1";

export interface InvariantFixtureContract {
  /** Stable fixture seam that downstream API and migration suites may cite and reuse. */
  id: string;
  given: string;
  when: string;
  then: string;
}

export interface InvariantOwner {
  /** Plan node that owns the executable assertion, even when that story is downstream. */
  story: string;
  issue: number;
  acceptance: string;
}

export interface ExecutableInvariantEvidence {
  state: "executable";
  testFile: string;
  testName: string;
  runtimes: readonly InvariantRuntime[];
}

export interface DownstreamInvariantEvidence {
  state: "downstream";
  /** The concrete assertion the owning downstream story must make executable. */
  testContract: string;
}

export interface InvariantDefinition {
  id: InvariantName;
  ordinal: number;
  title: string;
  source: "docs/domain-model.md#8-invariants-the-testable-list";
  owner: InvariantOwner;
  fixture: InvariantFixtureContract;
  evidence: ExecutableInvariantEvidence | DownstreamInvariantEvidence;
}

const coreStory = "v0-prove-the-model/schema-core-domain/invariant-suite";
const generationStory = "v0-5-working-system/invoicing/generation";
const reconciliationStory = "v0-prove-the-model/load-reconcile/reconcile";
const bothRuntimes = ["sqlite", "d1"] as const;

/**
 * The sole invariant-number registry. Domain code keeps enforcing the rules in
 * its existing owners; this registry owns their stable names, fixture seams,
 * story ownership, and one citable executable test each.
 */
export const invariantRegistry = [
  {
    id: "inv-01",
    ordinal: 1,
    title: "At most one running time entry per user",
    source: "docs/domain-model.md#8-invariants-the-testable-list",
    owner: {
      story: coreStory,
      issue: 87,
      acceptance:
        "A replacement start stops the prior timer atomically and leaves one runner.",
    },
    fixture: {
      id: "running-entry-replacement",
      given:
        "One user has an active duration timer with a persisted checkpoint.",
      when: "The same user starts a second timer, including a failing replacement attempt.",
      then: "Exactly one row remains running and a failed replacement changes neither row.",
    },
    evidence: {
      state: "executable",
      testFile: "packages/db/test/projects-time.test.ts",
      testName:
        "[unit] [inv-01] rolls duration timers, preserves checkpoints, and rolls back a failed replacement",
      runtimes: bothRuntimes,
    },
  },
  {
    id: "inv-02",
    ordinal: 2,
    title: "A running entry has exactly one mode-specific open terminator",
    source: "docs/domain-model.md#8-invariants-the-testable-list",
    owner: {
      story: coreStory,
      issue: 87,
      acceptance:
        "Duration and start/end timers persist only their mode-specific open shape.",
    },
    fixture: {
      id: "timer-mode-shapes",
      given:
        "The singleton organization selects duration or start/end tracking mode.",
      when: "Timers are started, replaced, stopped, and restarted in the selected mode.",
      then: "A runner has timer_started_at XOR an open started_time and never both terminators.",
    },
    evidence: {
      state: "executable",
      testFile: "packages/db/test/projects-time.test.ts",
      testName:
        "[unit] [inv-02] stores canonical start/end timers without timer_started_at and accumulates checkpoints",
      runtimes: bothRuntimes,
    },
  },
  {
    id: "inv-03",
    ordinal: 3,
    title: "Locked tracked resources reject native mutation atomically",
    source: "docs/domain-model.md#8-invariants-the-testable-list",
    owner: {
      story: coreStory,
      issue: 87,
      acceptance:
        "Every lock reason rejects time and expense writes before any partial mutation.",
    },
    fixture: {
      id: "tracked-lock-matrix",
      given:
        "Time and expense rows cover invoiced, approved, policy, and archived lock reasons.",
      when: "Single-row and composed timer mutations attempt to update the locked resources.",
      then: "The native mutation reports the exact lock reason and every persisted row is unchanged.",
    },
    evidence: {
      state: "executable",
      testFile: "packages/db/test/tracked-state.test.ts",
      testName:
        "[unit] [inv-03] atomically rejects every locked stop and restart without changing data",
      runtimes: bothRuntimes,
    },
  },
  {
    id: "inv-04",
    ordinal: 4,
    title: "Invoice totals use exact D21 fixed-point arithmetic",
    source: "docs/domain-model.md#8-invariants-the-testable-list",
    owner: {
      story: coreStory,
      issue: 87,
      acceptance:
        "Every financial mutation transactionally recomputes exact stored totals.",
    },
    fixture: {
      id: "invoice-fixed-point-totals",
      given:
        "An invoice has mixed taxable lines, discount, two taxes, payments, and write-off.",
      when: "Each line, rate, payment, and write-off component is independently mutated.",
      then: "Stored amount and due equal the signed integer D21 formula after every mutation.",
    },
    evidence: {
      state: "executable",
      testFile: "packages/db/test/invoice-payments-totals.test.ts",
      testName:
        "[unit] [inv-04] applies exact discount-first parallel taxes and recomputes every mutation",
      runtimes: bothRuntimes,
    },
  },
  {
    id: "inv-05",
    ordinal: 5,
    title:
      "An active invoice is paid exactly when due is non-positive after a payment",
    source: "docs/domain-model.md#8-invariants-the-testable-list",
    owner: {
      story: coreStory,
      issue: 87,
      acceptance:
        "Payment changes reconcile paid/open state and their outcome events atomically.",
    },
    fixture: {
      id: "invoice-payment-state-cycle",
      given: "An open invoice has a positive due amount and no payments.",
      when: "A covering payment is recorded, reduced below coverage, and then deleted.",
      then: "State cycles paid, open, open with payment count and due satisfying the equivalence.",
    },
    evidence: {
      state: "executable",
      testFile: "packages/db/test/invoice-state.test.ts",
      testName:
        "[unit] [inv-05] orders payment events before paid, partial, and unpaid outcomes",
      runtimes: bothRuntimes,
    },
  },
  {
    id: "inv-06",
    ordinal: 6,
    title:
      "Invoice generation consumes tracked rows in the invoice transaction",
    source: "docs/domain-model.md#8-invariants-the-testable-list",
    owner: {
      story: generationStory,
      issue: 50,
      acceptance:
        "Concurrent double-generate produces one invoice and no double-billed entries.",
    },
    fixture: {
      id: "concurrent-invoice-generation",
      given:
        "The same eligible unbilled time and expenses are visible to two generation commands.",
      when: "Both commands concurrently generate from the identical filter and command identity.",
      then: "One complete invoice wins and every consumed source row links in that transaction.",
    },
    evidence: {
      state: "executable",
      testFile: "entries/worker/test/runtime-d1.test.ts",
      testName:
        "[api] [inv-06] concurrently generates one invoice through the deployed Worker binding",
      runtimes: ["d1"],
    },
  },
  {
    id: "inv-07",
    ordinal: 7,
    title: "A project client is immutable while an invoice links the project",
    source: "docs/domain-model.md#8-invariants-the-testable-list",
    owner: {
      story: coreStory,
      issue: 87,
      acceptance:
        "Every direct and indirect invoice link blocks project client reassignment.",
    },
    fixture: {
      id: "linked-project-client",
      given:
        "Projects are linked by invoice header, line, tracked row, and milestone paths.",
      when: "A project or linked invoice attempts to cross the client boundary.",
      then: "The whole statement fails until all invoice links are removed.",
    },
    evidence: {
      state: "executable",
      testFile: "packages/db/test/invoice-foundation.test.ts",
      testName:
        "[unit] [inv-07] enforces real invoice links and linked-project client immutability",
      runtimes: bothRuntimes,
    },
  },
  {
    id: "inv-08",
    ordinal: 8,
    title: "Rate histories are append-only with derived end dates",
    source: "docs/domain-model.md#8-invariants-the-testable-list",
    owner: {
      story: coreStory,
      issue: 87,
      acceptance:
        "Chronological rate appends close only the prior row and history cannot be rewritten.",
    },
    fixture: {
      id: "effective-dated-rate-chain",
      given:
        "A user has billable and cost rate history beginning on canonical dates.",
      when: "A later rate is appended or an existing row is updated, deleted, or backdated.",
      then: "The predecessor ends one day before the next start and hostile history writes fail.",
    },
    evidence: {
      state: "executable",
      testFile: "packages/db/test/schema.test.ts",
      testName:
        "[unit] [inv-08] rate insert closes the previous row and history is append-only",
      runtimes: bothRuntimes,
    },
  },
  {
    id: "inv-09",
    ordinal: 9,
    title: "Entry rate snapshots change only through an audited reprice",
    source: "docs/domain-model.md#8-invariants-the-testable-list",
    owner: {
      story: coreStory,
      issue: 87,
      acceptance:
        "Rate source changes leave snapshots stable until an atomic reprice audit applies.",
    },
    fixture: {
      id: "entry-snapshot-reprice",
      given:
        "Native and imported entries retain independent billable and cost snapshots.",
      when: "Live rate sources change and one native entry is explicitly repriced with a reason.",
      then: "Only that entry changes and an immutable before/after audit is committed with it.",
    },
    evidence: {
      state: "executable",
      testFile: "packages/db/test/rate-resolver.test.ts",
      testName:
        "[unit] [inv-09] leaves native and imported snapshots stable until explicit audited reprice",
      runtimes: bothRuntimes,
    },
  },
  {
    id: "inv-10",
    ordinal: 10,
    title:
      "Retainer balance is the bounded sum of one-denomination ledger entries",
    source: "docs/domain-model.md#8-invariants-the-testable-list",
    owner: {
      story: coreStory,
      issue: 87,
      acceptance:
        "Concurrent movements preserve the derived balance and policy-controlled floor.",
    },
    fixture: {
      id: "retainer-ledger-balance",
      given:
        "Block, warn, and overflow retainers each have a deposit in their one denomination.",
      when: "Competing drawdowns race and each exhaustion policy attempts an overdraw.",
      then: "Balance equals ledger sum; only overflow permits a negative result.",
    },
    evidence: {
      state: "executable",
      testFile: "packages/db/test/retainers.test.ts",
      testName:
        "[unit] [inv-10] derives balance and atomically blocks all non-overflow overdrafts",
      runtimes: bothRuntimes,
    },
  },
  {
    id: "inv-11",
    ordinal: 11,
    title:
      "Uninvoiced report totals equal generation output for the same filter",
    source: "docs/domain-model.md#8-invariants-the-testable-list",
    owner: {
      story: generationStory,
      issue: 50,
      acceptance: "Generation output equals the uninvoiced report to the cent.",
    },
    fixture: {
      id: "uninvoiced-generation-parity",
      given:
        "The shared cast has eligible time and expenses spanning pricing and summary groups.",
      when: "The uninvoiced report and generation engine evaluate the exact same filter snapshot.",
      then: "Their grouped lines and total cents are identical.",
    },
    evidence: {
      state: "executable",
      testFile: "packages/db/test/invoice-generation.test.ts",
      testName:
        "[unit] [inv-11] reconciles every client report currency to generated invoices",
      runtimes: bothRuntimes,
    },
  },
  {
    id: "inv-12",
    ordinal: 12,
    title: "Exactly one user is the organization owner",
    source: "docs/domain-model.md#8-invariants-the-testable-list",
    owner: {
      story: coreStory,
      issue: 87,
      acceptance:
        "Initial ownership and transfers preserve one immutable administrator owner.",
    },
    fixture: {
      id: "organization-owner-transfer",
      given:
        "The first user owns the singleton organization and a second member exists.",
      when: "Direct owner writes, deletion, and a repeated transfer are attempted.",
      then: "Exactly one derived owner remains and that user is an administrator.",
    },
    evidence: {
      state: "executable",
      testFile: "packages/db/test/schema.test.ts",
      testName: "[unit] [inv-12] exactly one owner remains enforced",
      runtimes: bothRuntimes,
    },
  },
  {
    id: "inv-13",
    ordinal: 13,
    title:
      "Organization isolation is structural: one database is one organization",
    source: "docs/domain-model.md#8-invariants-the-testable-list",
    owner: {
      story: coreStory,
      issue: 87,
      acceptance:
        "Identical keys in separate handles stay isolated and no organization-id seam exists.",
    },
    fixture: {
      id: "separate-organization-databases",
      given:
        "Two databases contain different singleton organizations and identical resource ids.",
      when: "The same database-bound operation writes and reads each resource.",
      then: "Each handle sees only its organization and neither schema nor input accepts a foreign id.",
    },
    evidence: {
      state: "executable",
      testFile: "packages/db/test/invariant-boundary.test.ts",
      testName:
        "[unit] [inv-13] isolates identical keys by database and exposes no organization-id seam",
      runtimes: bothRuntimes,
    },
  },
  {
    id: "inv-14",
    ordinal: 14,
    title: "Imported monthly time aggregates equal the Harvest checksum",
    source: "docs/domain-model.md#8-invariants-the-testable-list",
    owner: {
      story: reconciliationStory,
      issue: 77,
      acceptance:
        "Loaded seconds reconcile per user, project, and month to the source checksum.",
    },
    fixture: {
      id: "harvest-monthly-time-checksum",
      given:
        "A verified Harvest snapshot supplies time rows and source aggregates at the same grain.",
      when: "The transform/load pipeline writes the snapshot and reconciliation aggregates the result.",
      then: "Every user-project-month seconds total exactly matches the Harvest checksum.",
    },
    evidence: {
      state: "executable",
      testFile: "packages/migrate/test/reconcile.test.ts",
      testName:
        "[integration] [inv-14] reports zero unexplained deltas and proves monthly seconds at source grain",
      runtimes: ["sqlite"],
    },
  },
] as const satisfies readonly InvariantDefinition[];

export type InvariantId = (typeof invariantRegistry)[number]["id"];

/** Derived from the sole registry so callers never maintain a second name list. */
export const invariantIds: readonly InvariantId[] = Object.freeze(
  invariantRegistry.map(({ id }) => id),
);

export const getInvariant = (id: InvariantId): InvariantDefinition => {
  const definition = invariantRegistry.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new Error(`unknown invariant: ${id}`);
  return definition;
};
