/**
 * Whether an invoice's billed hours agree with the time entries it claims
 * (issue 924).
 *
 * Editing a line's quantity does not touch the entries linked to the invoice
 * (`time_entries.invoice_id`), so the two can drift: the hours report then
 * lists more or fewer hours than the invoice charged for. This is the
 * comparison, as a pure function so the same answer can be read by the API, the
 * editor and the send flow.
 *
 * Lines carry no link to entries, only a `project_id`, so the finest honest
 * comparison is per project plus the invoice as a whole. A line with no project
 * cannot be attributed to any entry and is listed as not compared rather than
 * guessed at.
 *
 * Compared in whole seconds, never floating hours: a quantity of 7.25 hours
 * against 26 100 seconds of entries must not read as a phantom difference.
 */

export interface ReconciliationEntry {
  readonly projectId: number;
  readonly projectName: string | null;
  /** The billed figure: `rounded_seconds`, the same one the journal totals. */
  readonly seconds: number;
}

export interface ReconciliationLine {
  readonly id: number;
  readonly position: number;
  readonly description: string | null;
  readonly projectId: number | null;
  readonly projectName: string | null;
  /** Hours, as the invoice line states them. */
  readonly quantity: number;
}

/** 0.01 hour: the precision a quantity is typed at. */
export const defaultReconciliationToleranceSeconds = 36;

export type ReconciliationStatus = "matched" | "billed_below_linked" | "billed_above_linked";

export interface ReconciliationFigures {
  readonly linkedSeconds: number;
  readonly billedSeconds: number;
  /** Billed minus linked; negative when the invoice charged for less than it links. */
  readonly differenceSeconds: number;
  readonly status: ReconciliationStatus;
}

export interface ProjectReconciliation extends ReconciliationFigures {
  readonly projectId: number;
  readonly projectName: string | null;
}

export interface InvoiceHoursReconciliation extends ReconciliationFigures {
  readonly toleranceSeconds: number;
  readonly projects: readonly ProjectReconciliation[];
  /** Lines that could not be attributed to a project, left out of every figure. */
  readonly notCompared: readonly ReconciliationLine[];
}

const figuresFor = (
  linkedSeconds: number,
  billedSeconds: number,
  toleranceSeconds: number,
): ReconciliationFigures => {
  const differenceSeconds = billedSeconds - linkedSeconds;
  return {
    linkedSeconds,
    billedSeconds,
    differenceSeconds,
    status:
      Math.abs(differenceSeconds) <= toleranceSeconds
        ? "matched"
        : differenceSeconds < 0
          ? "billed_below_linked"
          : "billed_above_linked",
  };
};

export const reconcileInvoiceHours = (input: {
  readonly entries: readonly ReconciliationEntry[];
  readonly lines: readonly ReconciliationLine[];
  readonly toleranceSeconds?: number;
}): InvoiceHoursReconciliation => {
  const toleranceSeconds = input.toleranceSeconds ?? defaultReconciliationToleranceSeconds;
  const byProject = new Map<number, { name: string | null; linked: number; billed: number }>();
  const slot = (projectId: number, name: string | null) => {
    let found = byProject.get(projectId);
    if (found === undefined) {
      found = { name, linked: 0, billed: 0 };
      byProject.set(projectId, found);
    } else if (found.name === null) found.name = name;
    return found;
  };
  for (const entry of input.entries) {
    slot(entry.projectId, entry.projectName).linked += entry.seconds;
  }
  const notCompared: ReconciliationLine[] = [];
  for (const line of input.lines) {
    if (line.projectId === null) {
      notCompared.push(line);
      continue;
    }
    slot(line.projectId, line.projectName).billed += Math.round(line.quantity * 3600);
  }
  const projects = [...byProject.entries()]
    .sort(([left], [right]) => left - right)
    .map(([projectId, { name, linked, billed }]) => ({
      projectId,
      projectName: name,
      ...figuresFor(linked, billed, toleranceSeconds),
    }));
  const linkedTotal = projects.reduce((sum, project) => sum + project.linkedSeconds, 0);
  const billedTotal = projects.reduce((sum, project) => sum + project.billedSeconds, 0);
  return {
    ...figuresFor(linkedTotal, billedTotal, toleranceSeconds),
    toleranceSeconds,
    projects,
    notCompared,
  };
};
