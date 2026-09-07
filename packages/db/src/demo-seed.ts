/**
 * A synthetic organisation for the public demo.
 *
 * ezacto.io is the demo anyone can click through, so it cannot hold CONFLICT's
 * own books: real client names, postal addresses and the statement keys that
 * open a client's statement are not things to publish. Everything here is
 * invented. Addresses use example.com, which RFC 2606 reserves precisely so it
 * can never belong to a real person, so a demo that sends mail cannot reach one.
 *
 * Ids sit in the 9000s. A bootstrapped instance owns user 1 (instance-bootstrap
 * creates the owner and nothing else), so the seed adds a team around that owner
 * rather than competing with it for low ids.
 */

export interface DemoSeedOptions {
  /** ISO instant used for every created_at/updated_at, and the anchor the time entries count back from. */
  readonly now: string
  /** Weeks of timesheet history to generate. */
  readonly weeks?: number
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
}

// Invented people. No resemblance to anyone at CONFLICT is intended, and the
// spread of profiles exists so the demo can show what each one is allowed to see.
const people: readonly Person[] = [
  { id: 9001, first: 'Rowan', last: 'Adeyemi', profile: 'administrator', contractor: 0, costCents: 7200, rateCents: 18500 },
  { id: 9002, first: 'Mira', last: 'Halvorsen', profile: 'executive_manager', contractor: 0, costCents: 8100, rateCents: 21000 },
  { id: 9003, first: 'Tomas', last: 'Lindqvist', profile: 'project_manager', contractor: 0, costCents: 6400, rateCents: 16500 },
  { id: 9004, first: 'Priya', last: 'Raghunathan', profile: 'project_manager', contractor: 0, costCents: 6600, rateCents: 17000 },
  { id: 9005, first: 'Dario', last: 'Esposito', profile: 'member', contractor: 1, costCents: 5500, rateCents: 14500 },
  { id: 9006, first: 'Aiko', last: 'Tanabe', profile: 'member', contractor: 0, costCents: 5200, rateCents: 14000 },
  { id: 9007, first: 'Selim', last: 'Karadag', profile: 'member', contractor: 1, costCents: 5800, rateCents: 15000 },
  { id: 9008, first: 'Nora', last: 'Beaulieu', profile: 'accounting', contractor: 0, costCents: 5900, rateCents: 13500 },
]

const clients = [
  { id: 9001, name: 'Northwind Freight', currency: 'USD', terms: 'net_30' },
  { id: 9002, name: 'Halcyon Biolabs', currency: 'USD', terms: 'net_45' },
  { id: 9003, name: 'Tidewater Municipal', currency: 'USD', terms: 'net_30' },
  // One client billed in euros, so the demo exercises the per-client currency
  // rather than letting every screen assume the organisation's own.
  { id: 9004, name: 'Corvid Studios', currency: 'EUR', terms: 'upon_receipt' },
] as const

const projects = [
  { id: 9001, client: 9001, name: 'Freight Portal Rebuild', code: 'NWF-1', method: 'time_materials', rate: 17500 },
  { id: 9002, client: 9001, name: 'Route Optimisation', code: 'NWF-2', method: 'fixed_fee', rate: null },
  { id: 9003, client: 9002, name: 'LIMS Integration', code: 'HAL-1', method: 'time_materials', rate: 19000 },
  { id: 9004, client: 9003, name: 'Permit Portal', code: 'TWM-1', method: 'time_materials', rate: 15500 },
  { id: 9005, client: 9004, name: 'Brand System', code: 'COR-1', method: 'fixed_fee', rate: null },
  { id: 9006, client: 9002, name: 'Assay Data Migration', code: 'HAL-2', method: 'time_materials', rate: 18000 },
] as const

const tasks = [
  { id: 9001, name: 'Engineering', billable: 1, isDefault: 1 },
  { id: 9002, name: 'Design', billable: 1, isDefault: 0 },
  { id: 9003, name: 'Project management', billable: 1, isDefault: 0 },
  { id: 9004, name: 'Quality assurance', billable: 1, isDefault: 0 },
  { id: 9005, name: 'Internal', billable: 0, isDefault: 0 },
] as const

const notes = [
  'Paired on the ingest retry path',
  'Reviewed the migration plan with the client',
  'Wrote acceptance tests for the permit form',
  'Fixed the pagination cursor on the assay list',
  'Sprint planning and estimate revision',
  'Accessibility pass on the request flow',
  'Traced a timeout in the nightly export',
  'Drafted the rollout runbook',
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

export const demoSeedStatements = (
  options: DemoSeedOptions,
): readonly DemoSeedStatement[] => {
  const now = options.now
  const weeks = options.weeks ?? 3
  const statements: DemoSeedStatement[] = []

  for (const person of people) {
    statements.push({
      text: `INSERT INTO users
        (id, first_name, last_name, timezone, is_contractor, is_active,
         weekly_capacity, profile, manager_grants, created_at, updated_at)
        VALUES (?, ?, ?, 'UTC', ?, 1, 126000, ?, '[]', ?, ?)`,
      bindings: [person.id, person.first, person.last, person.contractor, person.profile, now, now],
    })
    statements.push({
      text: `INSERT INTO user_emails
        (id, user_id, address, verified_at, is_primary, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)`,
      bindings: [
        person.id,
        person.id,
        `${person.first.toLowerCase()}.${person.last.toLowerCase()}@example.com`,
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
         hourly_rate_cents, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, 'project', ?, ?, ?)`,
      bindings: [project.id, project.client, project.name, project.code, project.method, project.rate, now, now],
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
  const days = weeks * 7
  for (let back = days - 1; back >= 0; back -= 1) {
    const spentDate = addDays(now, -back)
    const weekday = new Date(`${spentDate}T00:00:00Z`).getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    for (const person of people) {
      const perDay = 1 + Math.floor(next() * 3)
      for (let slot = 0; slot < perDay; slot += 1) {
        const project = projects[Math.floor(next() * projects.length)]!
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
            now,
            now,
          ],
        })
        entryId += 1
      }
    }
  }

  return statements
}
