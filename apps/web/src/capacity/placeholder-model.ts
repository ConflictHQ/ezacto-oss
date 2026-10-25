import type { AllocationRow, PlanningRange } from "./model.js";

export interface PlanningPlaceholder {
  readonly id: number;
  readonly name: string;
  readonly is_active: boolean;
  readonly version: number;
}

export interface PlaceholderPlan {
  readonly id: number;
  readonly placeholder_id: number;
  readonly name: string;
  readonly project_id: number;
  readonly project_name: string;
  readonly start_date: string;
  readonly end_date: string;
  readonly planned_seconds_per_week: number;
  readonly state: "open" | "assigned" | "archived";
  readonly version: number;
  readonly assigned_allocation_id: number | null;
}

export type PlaceholderPlanInput = Pick<
  PlaceholderPlan,
  | "placeholder_id"
  | "project_id"
  | "start_date"
  | "end_date"
  | "planned_seconds_per_week"
>;

export interface PlaceholderAssignment {
  readonly allocation: AllocationRow;
  readonly placeholder: PlaceholderPlan;
  readonly warnings: readonly {
    readonly code: "over_allocated";
    readonly week_start: string;
    readonly planned_seconds: number;
    readonly capacity_seconds: number;
  }[];
  readonly prerequisites: readonly {
    readonly code: "project_access_missing";
  }[];
}

export interface PlaceholderPlanningApi {
  list(
    range: PlanningRange,
    signal?: AbortSignal,
  ): Promise<readonly PlaceholderPlan[]>;
  listDefinitions(
    signal?: AbortSignal,
  ): Promise<readonly PlanningPlaceholder[]>;
  createDefinition(
    input: { name: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
  updateDefinition(
    id: number,
    input: { name: string; version: number },
    signal?: AbortSignal,
  ): Promise<unknown>;
  archiveDefinition(
    id: number,
    version: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
  create(input: PlaceholderPlanInput, signal?: AbortSignal): Promise<unknown>;
  update(
    id: number,
    input: Pick<
      PlaceholderPlanInput,
      "start_date" | "end_date" | "planned_seconds_per_week"
    > & { version: number },
    signal?: AbortSignal,
  ): Promise<unknown>;
  archive(id: number, version: number, signal?: AbortSignal): Promise<unknown>;
  assign(
    id: number,
    input: { version: number; user_id: number; idempotency_key: string },
    signal?: AbortSignal,
  ): Promise<PlaceholderAssignment>;
}

/** Full weekly demand applies to every touched week, just like person allocations. */
export const unassignedWeeklySeconds = (
  rows: readonly PlaceholderPlan[],
  weekStart: string,
): number => {
  const end = new Date(`${weekStart}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  const weekEnd = end.toISOString().slice(0, 10);
  return rows
    .filter(
      (row) =>
        row.state === "open" &&
        row.start_date <= weekEnd &&
        row.end_date >= weekStart,
    )
    .reduce((total, row) => total + row.planned_seconds_per_week, 0);
};
