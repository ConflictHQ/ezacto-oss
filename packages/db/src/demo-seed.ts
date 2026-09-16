/**
 * A synthetic organisation for the public demo.
 *
 * ezacto.io is the demo anyone can click through, so it cannot hold CONFLICT's
 * own books: real client names, postal addresses and the statement keys that
 * open a client's statement are not things to publish. Everything here is
 * invented.
 *
 * Addresses are on ezacto.io, a domain this project owns. They were example.com,
 * which RFC 2606 reserves so it can never belong to anyone -- unreachable by
 * construction, and therefore also unobservable. A domain we control is the
 * better containment for a demo that can now actually send: mail the demo emits
 * lands somewhere we can read rather than being swallowed, so what it sends is
 * checkable, and it still cannot reach a stranger.
 *
 * Ids sit in the 9000s. A bootstrapped instance owns user 1 (instance-bootstrap
 * creates the owner and nothing else), so the seed adds a team around that owner
 * rather than competing with it for low ids.
 *
 * Everything is anchored to `now` rather than to a fixed calendar, because the
 * demo is rebuilt daily: a fixed anchor would show a book of work that stopped
 * on the day the fixture was written. Three years back from today, up to today.
 */

export interface DemoSeedOptions {
  /** ISO instant used for every created_at/updated_at, and the anchor the history counts back from. */
  readonly now: string
  /** Years of history to generate, counting back from `now`. */
  readonly years?: number
}

export interface DemoSeedStatement {
  readonly text: string
  readonly bindings: readonly (string | number | null)[]
}

interface Person {
  readonly id: number
  readonly first: string
  readonly last: string
  readonly profile: string
  readonly contractor: 0 | 1
  readonly costCents: number
  readonly rateCents: number
  /**
   * How far into the window this person joined, 0 at the opening and 1 at
   * today. A fraction rather than a day count so the demo has the same shape
   * whatever `years` it is built for -- a short one for a test still gets the
   * whole cast, compressed.
   *
   * A team of twenty that all started on the same morning three years ago is
   * not a team that grew, and headcount is one of the things the demo is for.
   */
  readonly joinsAt: number
  /** How far in this person left, or null for still here. */
  readonly leavesAt: number | null
}

// Invented people. No resemblance to anyone at CONFLICT is intended, and the
// spread of profiles exists so the demo can show what each one is allowed to see.
const people: readonly Person[] = [
  { id: 9001, first: 'Rowan', last: 'Adeyemi', profile: 'administrator', contractor: 0, costCents: 7200, rateCents: 18500, joinsAt: 0, leavesAt: null },
  { id: 9002, first: 'Mira', last: 'Halvorsen', profile: 'executive_manager', contractor: 0, costCents: 8100, rateCents: 21000, joinsAt: 0, leavesAt: null },
  { id: 9003, first: 'Tomas', last: 'Lindqvist', profile: 'project_manager', contractor: 0, costCents: 6400, rateCents: 16500, joinsAt: 0, leavesAt: null },
  { id: 9004, first: 'Priya', last: 'Raghunathan', profile: 'project_manager', contractor: 0, costCents: 6600, rateCents: 17000, joinsAt: 0, leavesAt: null },
  { id: 9005, first: 'Dario', last: 'Esposito', profile: 'member', contractor: 1, costCents: 5500, rateCents: 14500, joinsAt: 0, leavesAt: null },
  { id: 9006, first: 'Aiko', last: 'Tanabe', profile: 'member', contractor: 0, costCents: 5200, rateCents: 14000, joinsAt: 0, leavesAt: null },
  { id: 9007, first: 'Selim', last: 'Karadag', profile: 'member', contractor: 1, costCents: 5800, rateCents: 15000, joinsAt: 0, leavesAt: null },
  { id: 9008, first: 'Nora', last: 'Beaulieu', profile: 'accounting', contractor: 0, costCents: 5900, rateCents: 13500, joinsAt: 0, leavesAt: null },
  { id: 9009, first: 'Idris', last: 'Achebe', profile: 'member', contractor: 0, costCents: 5400, rateCents: 14500, joinsAt: 0.088, leavesAt: null },
  { id: 9010, first: 'Wren', last: 'Kowalczyk', profile: 'member', contractor: 0, costCents: 5100, rateCents: 13500, joinsAt: 0.139, leavesAt: null },
  { id: 9011, first: 'Hana', last: 'Petrova', profile: 'people_admin', contractor: 0, costCents: 6000, rateCents: 15500, joinsAt: 0.192, leavesAt: null },
  // Left partway through. A three-year history in which nobody ever left is a
  // history nobody will recognise, and the archived-teammate path is real.
  { id: 9012, first: 'Callum', last: 'Ferreira', profile: 'member', contractor: 1, costCents: 5600, rateCents: 14500, joinsAt: 0.219, leavesAt: 0.644 },
  { id: 9013, first: 'Ines', last: 'Moreau', profile: 'member', contractor: 0, costCents: 5300, rateCents: 14000, joinsAt: 0.288, leavesAt: null },
  { id: 9014, first: 'Bodhi', last: 'Ramaswamy', profile: 'member', contractor: 0, costCents: 5000, rateCents: 13000, joinsAt: 0.367, leavesAt: null },
  { id: 9015, first: 'Freya', last: 'Osei', profile: 'project_manager', contractor: 0, costCents: 6500, rateCents: 16500, joinsAt: 0.429, leavesAt: null },
  { id: 9016, first: 'Milo', last: 'Vargas', profile: 'member', contractor: 1, costCents: 5700, rateCents: 15000, joinsAt: 0.498, leavesAt: null },
  { id: 9017, first: 'Saoirse', last: 'Ni Bhraonain', profile: 'member', contractor: 0, costCents: 5250, rateCents: 14000, joinsAt: 0.566, leavesAt: null },
  { id: 9018, first: 'Ansel', last: 'Bergstrom', profile: 'member', contractor: 0, costCents: 5150, rateCents: 13500, joinsAt: 0.65, leavesAt: null },
  { id: 9019, first: 'Zaina', last: 'Al-Mansouri', profile: 'member', contractor: 0, costCents: 5450, rateCents: 14500, joinsAt: 0.758, leavesAt: null },
  { id: 9020, first: 'Otto', last: 'Lindgren', profile: 'member', contractor: 1, costCents: 5900, rateCents: 15500, joinsAt: 0.858, leavesAt: null },
]

/**
 * The two accounts the demo publishes on its own sign-in page. They are ordinary
 * users with ordinary passwords -- nothing here relaxes the password policy, so
 * the credentials are long enough to pass it. The addresses are on ezacto.io for
 * the same reason everyone else's are.
 *
 * `admin` is the instance owner, which bootstrap already created as user 1;
 * `user` is a member of the seeded team, so the two accounts differ in what they
 * are allowed to see, which is the point of publishing both.
 */
export interface DemoAccount {
  readonly label: string
  readonly userId: number
  readonly email: string
  readonly password: string
  readonly describes: string
}

/** Bootstrap always takes id 1, and the published administrator is that user. */
export const DEMO_OWNER_USER_ID = 1

export const demoAccounts: readonly DemoAccount[] = [
  {
    label: 'Administrator',
    userId: DEMO_OWNER_USER_ID,
    email: 'admin@ezacto.io',
    password: 'folding-forks-admin',
    describes: 'Everything: team, projects, invoices, reports, settings.',
  },
  {
    label: 'Teammate',
    userId: 9006,
    email: 'user@ezacto.io',
    password: 'folding-forks-user',
    describes: 'One person’s own week, and the projects they are assigned to.',
  },
]

const clients = [
  { id: 9001, name: 'Northwind Freight', currency: 'USD', terms: 'net_30' },
  { id: 9002, name: 'Halcyon Biolabs', currency: 'USD', terms: 'net_45' },
  { id: 9003, name: 'Tidewater Municipal', currency: 'USD', terms: 'net_30' },
  // One client billed in euros, so the demo exercises the per-client currency
  // rather than letting every screen assume the organisation's own.
  { id: 9004, name: 'Corvid Studios', currency: 'EUR', terms: 'upon_receipt' },
  { id: 9005, name: 'Kestrel Orthopedics', currency: 'USD', terms: 'net_30' },
  { id: 9006, name: 'Pinehurst Cooperative', currency: 'USD', terms: 'net_15' },
  { id: 9007, name: 'Vantage Rail', currency: 'USD', terms: 'net_45' },
  { id: 9008, name: 'Alder & Finch', currency: 'USD', terms: 'net_30' },
] as const

/**
 * Projects run for a while and then end. `from` and `to` are fractions of the
 * history -- 0 at the opening, 1 at today -- for the same reason the people
 * are: the demo keeps its shape at any length. Time is only logged to a project
 * while it is live, so the oldest month is not staffed on work that had not
 * been sold yet.
 */
const projects = [
  { id: 9001, client: 9001, name: 'Freight Portal Rebuild', code: 'NWF-1', method: 'time_materials', rate: 17500, from: 0, to: 0.393 },
  { id: 9002, client: 9001, name: 'Route Optimisation', code: 'NWF-2', method: 'fixed_fee', rate: null, from: 0.274, to: null },
  { id: 9003, client: 9002, name: 'LIMS Integration', code: 'HAL-1', method: 'time_materials', rate: 19000, from: 0, to: 0.566 },
  { id: 9004, client: 9003, name: 'Permit Portal', code: 'TWM-1', method: 'time_materials', rate: 15500, from: 0.055, to: null },
  { id: 9005, client: 9004, name: 'Brand System', code: 'COR-1', method: 'fixed_fee', rate: null, from: 0.11, to: 0.493 },
  { id: 9006, client: 9002, name: 'Assay Data Migration', code: 'HAL-2', method: 'time_materials', rate: 18000, from: 0.438, to: null },
  { id: 9007, client: 9005, name: 'Implant Registry', code: 'KOR-1', method: 'time_materials', rate: 19500, from: 0.137, to: null },
  { id: 9008, client: 9005, name: 'Surgeon Scheduling', code: 'KOR-2', method: 'time_materials', rate: 18500, from: 0.584, to: null },
  { id: 9009, client: 9006, name: 'Member Ledger', code: 'PHC-1', method: 'time_materials', rate: 14500, from: 0.192, to: 0.804 },
  { id: 9010, client: 9006, name: 'Harvest Forecasting', code: 'PHC-2', method: 'fixed_fee', rate: null, from: 0.694, to: null },
  { id: 9011, client: 9007, name: 'Signalling Dashboard', code: 'VRL-1', method: 'time_materials', rate: 20000, from: 0.082, to: 0.639 },
  { id: 9012, client: 9007, name: 'Yard Telemetry', code: 'VRL-2', method: 'time_materials', rate: 20500, from: 0.566, to: null },
  { id: 9013, client: 9008, name: 'Storefront Replatform', code: 'ALF-1', method: 'time_materials', rate: 16500, from: 0.301, to: null },
  { id: 9014, client: 9008, name: 'Fulfilment Integration', code: 'ALF-2', method: 'time_materials', rate: 16500, from: 0.749, to: null },
  { id: 9015, client: 9003, name: 'Inspections Mobile', code: 'TWM-2', method: 'time_materials', rate: 16000, from: 0.511, to: null },
  { id: 9016, client: 9004, name: 'Motion Library', code: 'COR-2', method: 'time_materials', rate: 17000, from: 0.639, to: null },
] as const

/**
 * Which projects belong to which client. Invoice generation takes an explicit,
 * non-empty project list rather than "everything for this client", so the demo
 * builder needs the mapping the seed already encodes.
 */
export const demoClientProjects: readonly {
  readonly clientId: number
  readonly projectIds: readonly number[]
}[] = clients.map((client) => ({
  clientId: client.id,
  projectIds: projects
    .filter((project) => project.client === client.id)
    .map((project) => project.id),
}))

const tasks = [
  { id: 9001, name: 'Engineering', billable: 1, isDefault: 1 },
  { id: 9002, name: 'Design', billable: 1, isDefault: 0 },
  { id: 9003, name: 'Project management', billable: 1, isDefault: 0 },
  { id: 9004, name: 'Quality assurance', billable: 1, isDefault: 0 },
  { id: 9005, name: 'Internal', billable: 0, isDefault: 0 },
  { id: 9006, name: 'Discovery', billable: 1, isDefault: 0 },
] as const

const expenseCategories = [
  { id: 9001, name: 'Travel', unit: null, unitPrice: null },
  { id: 9002, name: 'Mileage', unit: 'mile', unitPrice: 67 },
  { id: 9003, name: 'Meals', unit: null, unitPrice: null },
  { id: 9004, name: 'Lodging', unit: null, unitPrice: null },
  { id: 9005, name: 'Software', unit: null, unitPrice: null },
  { id: 9006, name: 'Hardware', unit: null, unitPrice: null },
] as const

/**
 * Two retainers, one denominated in money and one in hours, because the two
 * behave differently everywhere they are shown and a demo with only the first
 * hides half the feature.
 *
 * They open at their full balance and stay there. A deposit or a drawdown has
 * to name an invoice whose `retainer_id` is this retainer, and nothing in the
 * product sets that column -- `InvoiceEdit` has no case for it and generation
 * never writes it. So a seeded ledger would be a book of account the product
 * itself could not have produced, which is the one thing this file will not do.
 * The retainers are real and their screens are populated; the movements wait on
 * the feature (#449).
 */
export interface DemoRetainer {
  readonly id: number
  readonly clientId: number
  readonly projectId: number
  readonly denomination: 'money' | 'hours'
  /** Cents for a money retainer, seconds for an hours one. */
  readonly opening: number
  readonly period: string
  readonly rollover: 'carry' | 'expire' | 'cap'
  readonly onExhaustion: 'block' | 'warn' | 'overflow'
}

export const demoRetainers: readonly DemoRetainer[] = [
  {
    id: 9001,
    clientId: 9005,
    projectId: 9007,
    denomination: 'money',
    opening: 5_000_000,
    period: 'quarterly',
    rollover: 'carry',
    onExhaustion: 'warn',
  },
  {
    id: 9002,
    clientId: 9006,
    projectId: 9009,
    denomination: 'hours',
    // 100 hours, drawn twenty at a time.
    opening: 360_000,
    period: 'monthly',
    rollover: 'expire',
    onExhaustion: 'block',
  },
]

const notes = [
  'Paired on the ingest retry path',
  'Reviewed the migration plan with the client',
  'Wrote acceptance tests for the permit form',
  'Fixed the pagination cursor on the assay list',
  'Sprint planning and estimate revision',
  'Accessibility pass on the request flow',
  'Traced a timeout in the nightly export',
  'Drafted the rollout runbook',
  'Refactored the scheduling constraint solver',
  'Walked the client through the staging build',
  'Instrumented the slow report query',
  'Cut the release and watched the dashboards',
  'Reconciled the ledger export with finance',
  'Interviewed two operators about the intake form',
  'Backfilled the missing telemetry partitions',
  'Reworked the empty states after the review',
] as const

const expenseNotes = [
  'Client workshop travel',
  'On-site week, hotel',
  'Team lunch after the launch review',
  'Design tooling seat',
  'Replacement laptop charger',
  'Mileage to the depot',
  'Conference ticket',
  'Test device',
] as const

/**
 * Deterministic, so two runs of the seed produce the same demo and a
 * screenshot taken today still matches the data tomorrow. Math.random would
 * make the fixture unreviewable.
 */
const sequence = (seed: number) => {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

const addDays = (iso: string, days: number): string => {
  const base = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

/**
 * Days the office is shut. Kept as month/day so they land every year of the
 * window without a table of dates that ages out of it.
 */
const holidays = new Set([
  '01-01', '05-25', '07-04', '09-01', '11-26', '11-27', '12-24', '12-25', '12-26', '12-31',
])

export const demoSeedStatements = (
  options: DemoSeedOptions,
): readonly DemoSeedStatement[] => {
  const now = options.now
  const years = options.years ?? 3
  const days = Math.round(years * 365)
  const opensOn = addDays(now, -days)
  const statements: DemoSeedStatement[] = []
  /** How far through the window a date falls, which is how every window above is expressed. */
  const progressOf = (isoDate: string): number =>
    (Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${opensOn}T00:00:00Z`)) /
    86_400_000 /
    days

  statements.push({
    text: `UPDATE organizations SET currency = 'USD', week_start_day = 'monday',
      fiscal_year_start_month = 1, updated_at = ? WHERE id = 1`,
    bindings: [now],
  })

  for (const person of people) {
    const joined = addDays(opensOn, Math.round(person.joinsAt * days))
    statements.push({
      text: `INSERT INTO users
        (id, first_name, last_name, timezone, is_contractor, is_active,
         weekly_capacity, profile, manager_grants, created_at, updated_at)
        VALUES (?, ?, ?, 'UTC', ?, ?, 126000, ?, '[]', ?, ?)`,
      bindings: [
        person.id,
        person.first,
        person.last,
        person.contractor,
        person.leavesAt === null ? 1 : 0,
        person.profile,
        `${joined}T09:00:00.000Z`,
        now,
      ],
    })
    // A verified address is immutable, so the published teammate account takes
    // its address here rather than being renamed into place afterwards.
    const published = demoAccounts.find((account) => account.userId === person.id)
    statements.push({
      text: `INSERT INTO user_emails
        (id, user_id, address, verified_at, is_primary, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)`,
      bindings: [
        person.id,
        person.id,
        published?.email ??
          `${person.first.toLowerCase()}.${person.last.toLowerCase().replace(/[^a-z]/g, '')}@ezacto.io`,
        now,
        now,
        now,
      ],
    })
  }

  for (const client of clients) {
    statements.push({
      text: `INSERT INTO clients (id, name, currency, is_active, payment_terms, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?)`,
      bindings: [client.id, client.name, client.currency, client.terms, now, now],
    })
  }

  for (const project of projects) {
    statements.push({
      text: `INSERT INTO projects
        (id, client_id, name, code, is_active, billing_method, bill_by,
         hourly_rate_cents, starts_on, ends_on, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'project', ?, ?, ?, ?, ?)`,
      bindings: [
        project.id,
        project.client,
        project.name,
        project.code,
        // Active even where `ends_on` has passed. Uninvoiced work is only
        // billable on an active project, and the whole three years is billed in
        // one pass at `now` -- archiving the finished ones here would leave the
        // history unbillable and every early month empty.
        1,
        project.method,
        project.rate,
        addDays(opensOn, Math.round(project.from * days)),
        project.to === null ? null : addDays(opensOn, Math.round(project.to * days)),
        now,
        now,
      ],
    })
  }

  for (const task of tasks) {
    statements.push({
      text: `INSERT INTO tasks
        (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)`,
      bindings: [task.id, task.name, task.billable, task.isDefault, now, now],
    })
  }

  for (const category of expenseCategories) {
    statements.push({
      text: `INSERT INTO expense_categories
        (id, name, unit_name, unit_price_cents, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)`,
      bindings: [category.id, category.name, category.unit, category.unitPrice, now, now],
    })
  }

  for (const retainer of demoRetainers) {
    statements.push({
      text: `INSERT INTO retainers
        (id, client_id, project_id, state, denomination, amount_cents, seconds,
         period, rollover, on_exhaustion, created_at, updated_at)
        VALUES (?, ?, ?, 'ongoing', ?, ?, ?, ?, ?, ?, ?, ?)`,
      bindings: [
        retainer.id,
        retainer.clientId,
        retainer.projectId,
        retainer.denomination,
        retainer.denomination === 'money' ? retainer.opening : null,
        retainer.denomination === 'hours' ? retainer.opening : null,
        retainer.period,
        retainer.rollover,
        retainer.onExhaustion,
        now,
        now,
      ],
    })
  }

  // Everyone is assigned to every project. A demo where half the clicks land on
  // "you are not assigned to this project" teaches the reader nothing.
  const userAssignment = new Map<string, number>()
  let assignmentId = 9001
  for (const project of projects) {
    for (const person of people) {
      userAssignment.set(`${project.id}:${person.id}`, assignmentId)
      statements.push({
        text: `INSERT INTO user_assignments
          (id, project_id, user_id, is_active, is_project_manager, use_default_rates,
           hourly_rate_cents, created_at, updated_at)
          VALUES (?, ?, ?, 1, ?, 0, ?, ?, ?)`,
        bindings: [
          assignmentId,
          project.id,
          person.id,
          person.profile === 'project_manager' ? 1 : 0,
          person.rateCents,
          now,
          now,
        ],
      })
      assignmentId += 1
    }
  }

  // The published owner account is user 1, created by bootstrap rather than by
  // the cast above, so the loop that assigns everyone to everything misses it.
  // Left out, the account the sign-in page hands a visitor -- and the one the
  // store reviewers are told to use -- cannot file a single entry: the API
  // answers `project_assignment_required` and a time tracker looks broken.
  for (const project of projects) {
    statements.push({
      text: `INSERT INTO user_assignments
        (id, project_id, user_id, is_active, is_project_manager, use_default_rates,
         hourly_rate_cents, created_at, updated_at)
        VALUES (?, ?, ?, 1, 1, 0, ?, ?, ?)`,
      bindings: [assignmentId, project.id, DEMO_OWNER_USER_ID, project.rate, now, now],
    })
    assignmentId += 1
  }

  const taskAssignment = new Map<string, number>()
  let taskAssignmentId = 9001
  for (const project of projects) {
    for (const task of tasks) {
      taskAssignment.set(`${project.id}:${task.id}`, taskAssignmentId)
      statements.push({
        text: `INSERT INTO task_assignments
          (id, project_id, task_id, is_active, billable, hourly_rate_cents, created_at, updated_at)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
        bindings: [taskAssignmentId, project.id, task.id, task.billable, project.rate, now, now],
      })
      taskAssignmentId += 1
    }
  }

  const next = sequence(20260907)
  let entryId = 9001
  let expenseId = 9001
  for (let back = days; back >= 0; back -= 1) {
    const spentDate = addDays(now, -back)
    const weekday = new Date(`${spentDate}T00:00:00Z`).getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    if (holidays.has(spentDate.slice(5))) continue
    const progress = progressOf(spentDate)
    const live = projects.filter(
      (project) =>
        progress >= project.from && (project.to === null || progress <= project.to),
    )
    if (live.length === 0) continue
    for (const person of people) {
      if (progress < person.joinsAt) continue
      if (person.leavesAt !== null && progress > person.leavesAt) continue
      // Holidays are already gone; this is the rest of a real year -- leave,
      // sickness, and the days the timesheet simply never got filled in.
      if (next() < 0.09) continue
      const perDay = 1 + Math.floor(next() * 3)
      for (let slot = 0; slot < perDay; slot += 1) {
        const project = live[Math.floor(next() * live.length)]!
        const task = tasks[Math.floor(next() * tasks.length)]!
        // Quarter-hour increments, 30 minutes to 4 hours — a plausible entry,
        // not a uniform random number of seconds.
        const seconds = (2 + Math.floor(next() * 15)) * 900
        statements.push({
          text: `INSERT INTO time_entries
            (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
             spent_date, seconds, seconds_without_timer, rounded_seconds, notes,
             billable, budgeted, billable_rate_cents, cost_rate_cents, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
          bindings: [
            entryId,
            person.id,
            project.id,
            task.id,
            userAssignment.get(`${project.id}:${person.id}`)!,
            taskAssignment.get(`${project.id}:${task.id}`)!,
            spentDate,
            seconds,
            seconds,
            seconds,
            notes[Math.floor(next() * notes.length)]!,
            task.billable,
            task.billable === 1 ? person.rateCents : null,
            person.costCents,
            `${spentDate}T17:30:00.000Z`,
            `${spentDate}T17:30:00.000Z`,
          ],
        })
        entryId += 1
      }
      // Roughly one expense per person per month. Reimbursable ones are what
      // make the expense screens worth opening.
      if (next() < 0.045) {
        const project = live[Math.floor(next() * live.length)]!
        const category = expenseCategories[Math.floor(next() * expenseCategories.length)]!
        const unitPrice = category.unitPrice
        const units = unitPrice === null ? null : 8 + Math.floor(next() * 90)
        const totalCents =
          units === null || unitPrice === null
            ? 1_500 + Math.floor(next() * 120_000)
            : units * unitPrice
        statements.push({
          text: `INSERT INTO expenses
            (id, user_id, project_id, expense_category_id, spent_date, notes, units,
             total_cost_cents, billable, reimbursable, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          bindings: [
            expenseId,
            person.id,
            project.id,
            category.id,
            spentDate,
            expenseNotes[Math.floor(next() * expenseNotes.length)]!,
            units,
            totalCents,
            next() < 0.75 ? 1 : 0,
            person.contractor === 1 ? 0 : 1,
            `${spentDate}T18:00:00.000Z`,
            `${spentDate}T18:00:00.000Z`,
          ],
        })
        expenseId += 1
      }
    }
  }

  return statements
}
