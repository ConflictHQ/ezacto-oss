import { scrubWorkerEvent } from '../src/error-reporting.js';
import { beforeEach, expect, it, vi } from "vitest";
import { worker } from "../src/index.js";
import { createRuntimeServices } from "../src/runtime.js";
import { runDemoMaintenance, seedDemoSender } from "../src/demo.js";
import { runNightlyExport } from "../src/nightly-export.js";
import * as Sentry from "@sentry/cloudflare";

vi.mock("../src/runtime.js", async (original) => ({
  ...(await original<object>()),
  createRuntimeServices: vi.fn(),
}));
vi.mock("../src/demo.js", async (original) => ({
  ...(await original<object>()),
  runDemoMaintenance: vi.fn(),
  seedDemoSender: vi.fn(),
}));
vi.mock("../src/nightly-export.js", () => ({ runNightlyExport: vi.fn() }));
vi.mock("@sentry/cloudflare", async (original) => ({
  ...(await original<object>()),
  captureException: vi.fn(),
  withSentry: (_options: unknown, handler: unknown) => handler,
}));

beforeEach(() => {
  vi.clearAllMocks();
});
const minute = [
  "webhook",
  "purge",
  "payment",
  "budget",
  "time",
  "approval",
  "backup",
  "proposal",
  "notice",
  "dispatch",
  "expiry",
  "deelPayment",
  "maintenance",
  "outbox",
];
const daily = ["export", "recurring", "reminder", "maintenance", "outbox"];
const expectedOperation: Record<string, string> = {
  webhook: 'webhook sweep', purge: 'webhook purge', payment: 'payment run sweep',
  budget: 'budget alert evaluation', time: 'time reminders', approval: 'automatic approval sweep',
  backup: 'off-site backup checkpoint', proposal: 'scheduled job proposal sweep',
  notice: 'scheduled manifest notice', dispatch: 'scheduled run dispatch', expiry: 'scheduled run expiry',
  maintenance: 'demo maintenance', outbox: 'outbox drain', export: 'nightly export',
  recurring: 'recurring invoice generation', reminder: 'payment reminders', bill: 'BILL reconciliation',
  quickbooks: 'QuickBooks catch-up', deelStatus: 'Deel time sync', deel: 'Deel time sync',
  deelPayment: 'Deel payment status',
};
const hourly = [
  "bill",
  "quickbooks",
  "deelStatus",
  "deel",
  "maintenance",
  "outbox",
];

it.each([
  ...minute.map((failure) => ({ cron: "* * * * *", order: minute, failure })),
  ...daily.map((failure) => ({ cron: "0 3 * * *", order: daily, failure })),
  ...hourly.map((failure) => ({ cron: "0 * * * *", order: hourly, failure })),
])(
  "isolates $failure on $cron and continues independent jobs exactly once",
  async ({ cron, order, failure }) => {
    const calls: string[] = [],
      error = new Error("injected job failure");
    const job =
      <T>(name: string, result: T) =>
      async () => {
        calls.push(name);
        if (name === failure) throw error;
        return result;
      };
    vi.mocked(runDemoMaintenance).mockImplementation(
      job("maintenance", { ran: "nothing" }) as never,
    );
    vi.mocked(runNightlyExport).mockImplementation(
      job("export", undefined) as never,
    );
    vi.mocked(createRuntimeServices).mockResolvedValue({
      webhooks: {
        processDue: job("webhook", undefined),
        purge: job("purge", undefined),
      },
      paymentRuns: { processDue: job("payment", undefined) },
      budgetAlerts: { evaluate: job("budget", undefined) },
      timeReminders: { processDue: job("time", undefined) },
      timesheetAutoApprovalSweep: {
        processDue: job("approval", { failed: [] }),
      },
      offsiteBackupSync: { processDue: job("backup", undefined) },
      scheduledJobProposals: { processDue: job("proposal", { failed: [] }) },
      scheduledRunNotices: { processDue: job("notice", undefined) },
      scheduledRunDispatch: { processDue: job("dispatch", { failed: [] }) },
      scheduledActionExpiry: { expireDue: job("expiry", undefined) },
      recurringInvoices: { generateDue: job("recurring", undefined) },
      reminders: { processDue: job("reminder", undefined) },
      bill: { reconcilePayments: job("bill", undefined) },
      quickBooks: { catchUp: job("quickbooks", undefined) },
      deelPaymentStatus: { refresh: job("deelPayment", { configured: true, checked: 0, failed: 0, remaining: 0 }) },
      deelSync: {
        status() {
          calls.push("deelStatus");
          if (failure === "deelStatus") throw error;
          return { configured: true };
        },
        runAutomaticIfDue: job("deel", { status: "ok" }),
      },
      outbox: { drain: job("outbox", {}) },
    } as never);
    await worker.scheduled!(
      { cron, scheduledTime: Date.now() } as never,
      { ATTACHMENTS: {} } as never,
      {} as never,
    );
    expect(calls).toEqual(
      order.filter((name) => !(failure === "deelStatus" && name === "deel")),
    );
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const captured = vi.mocked(Sentry.captureException).mock.calls[0]![0] as Error;
    expect(captured).not.toBe(error);
    expect(captured.message).toBe('eZacto runtime failure');
    expect(scrubWorkerEvent({ exception: { values: [{ value: error.message }] } }, { originalException: captured })).toMatchObject({ tags: { phase: 'scheduled', operation: expectedOperation[failure] }, exception: { values: [{ value: 'eZacto runtime failure' }] } });
    expect(createRuntimeServices).toHaveBeenCalledExactlyOnceWith(
      { ATTACHMENTS: {} },
      { retryReadiness: true, reportError: expect.any(Function) },
    );
  },
);

it("keeps the outbox independent from a failed demo sender after a successful rebuild", async () => {
  const error = new Error("sender unavailable"),
    drain = vi.fn(async () => ({}));
  vi.mocked(createRuntimeServices).mockResolvedValue({
    outbox: { drain },
  } as never);
  vi.mocked(runDemoMaintenance).mockResolvedValue({ ran: "rebuild" } as never);
  vi.mocked(seedDemoSender).mockRejectedValue(error);
  await worker.scheduled!(
    { cron: "* * * * *" } as never,
    {} as never,
    {} as never,
  );
  expect(drain).toHaveBeenCalledOnce();
  expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const captured = vi.mocked(Sentry.captureException).mock.calls[0]![0] as Error;
    expect(captured).not.toBe(error);
    expect(captured.message).toBe('eZacto runtime failure');
    expect(scrubWorkerEvent({ exception: { values: [{ value: error.message }] } }, { originalException: captured })).toMatchObject({ tags: { phase: 'scheduled' }, exception: { values: [{ value: 'eZacto runtime failure' }] } });
});

it('identifies an outbox interruption returned without throwing and reports it once', async () => {
  const interrupted = new Error('owned database interruption')
  vi.mocked(runDemoMaintenance).mockResolvedValue({ ran: 'nothing' } as never)
  vi.mocked(createRuntimeServices).mockResolvedValue({ outbox: { drain: vi.fn(async () => ({ delivered: 0, interrupted })) } } as never)
  await worker.scheduled!({ cron: '* * * * *' } as never, {} as never, {} as never)
  expect(Sentry.captureException).toHaveBeenCalledTimes(1)
  const captured = vi.mocked(Sentry.captureException).mock.calls[0]![0] as Error
  expect(scrubWorkerEvent({}, { originalException: captured })?.tags).toMatchObject({ phase: 'scheduled', operation: 'outbox drain' })
})
