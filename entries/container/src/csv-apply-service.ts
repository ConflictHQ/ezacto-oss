import type BetterSqlite3 from "better-sqlite3";
import {
  CsvApplyRefusal,
  canonicalCsvApplyCommand,
  type CsvApplyCommand,
  type CsvApplyContext,
  type CsvStagingAuthority,
} from "@ezacto/core";
import { createCsvApplyRunStore, csvStagingSessionFence } from "@ezacto/db";
import type {
  CsvImportApplyPort,
  CsvApplyRunData,
} from "../../../packages/api/src/csv-import-apply-port.js";
import type { CsvImportStagingPort } from "../../../packages/api/src/csv-import-staging-port.js";
import { CsvStagingError } from "../../../packages/api/src/csv-import-staging-contract.js";
import type { CsvStagingApplyPort } from "../../../packages/migrate/src/csv-staging-private.js";
import { createSqliteCsvBrowserService } from "../../../packages/migrate/src/csv-browser-sqlite.js";
import { createSqliteCsvApplyDriver } from "../../../packages/migrate/src/csv-apply-driver.js";

/** Native command orchestration, separate from streamed/private admission.
 * No generic request idempotency transaction surrounds awaited staging work. */
export const createCsvImportApply = (options: {
  database: BetterSqlite3.Database;
  staging: CsvImportStagingPort;
  privateStaging: CsvStagingApplyPort;
  reportError?: (cause: unknown) => void;
}) => {
  const { database, staging, privateStaging } = options;
  const runs = createCsvApplyRunStore(database);
  const report = (_cause: unknown) => {
    try {
      const delivery: unknown = options.reportError?.(new Error("Private CSV apply failed; inspect the safe run status and correlation ID."));
      void Promise.resolve(delivery).catch(() => undefined);
    } catch {
      /* Reporting cannot change durable custody. */
    }
  };

  const stageBinding = (run: CsvApplyContext) => ({
    stageId: run.stageId,
    stageVersion: run.stageVersion,
    targetNonce: run.targetNonce,
    previewId: run.previewId,
    nativeRunId: Number(run.runId),
    leaseGeneration: run.leaseGeneration,
    commandId: run.confirmationCommandId,
  });
  const bound = async (run: CsvApplyContext) => {
    const result = await privateStaging.bindConfirmedRun(
      run.authority,
      stageBinding(run),
    );
    const current = runs.recordStageVersion(run, result.stageVersion);
    if (!current) throw new CsvApplyRefusal("stale_lease");
    return current.nativeState === "partial" && !current.ready
      ? runs.activate(current)
      : current;
  };
  const status: CsvImportApplyPort["status"] = async (
    authority,
    stageId,
    commandId,
  ) => {
    await staging.authorizeRun(authority, stageId);
    const stage = await staging.read(authority, stageId);
    const confirmation = await privateStaging.readOwnedConfirmation(
      authority,
      stageId,
    );
    const association = await privateStaging.readOwnedApplyBinding(
      authority,
      stageId,
    );
    let run = association
      ? runs.read(String(association.nativeRunId))
      : runs.findByStage(stageId);
    if (
      confirmation?.cancellationCommandId &&
      run?.stageId === stageId &&
      run.targetNonce === confirmation.targetNonce &&
      run.nativeState === "partial"
    ) {
      run = runs.cancel(authority, {
        runId: run.runId,
        stageId,
        targetNonce: confirmation.targetNonce,
        previewId: confirmation.previewId,
        executionCommandId: run.commandId,
        commandId: confirmation.cancellationCommandId,
      });
    }
    const current =
      run?.stageId === stageId && run.targetNonce === confirmation?.targetNonce
        ? run
        : null;
    const receipt =
      run && commandId ? runs.readReceipt(run.runId, commandId) : null;
    const known = !!(
      (receipt &&
        receipt.stageId === stageId &&
        receipt.actorUserId === authority.userId &&
        receipt.targetNonce === confirmation?.targetNonce) ||
      (commandId && confirmation?.cancellationCommandId === commandId)
    );
    const pending = current
      ? canonicalCsvApplyCommand(JSON.parse(current.requestJson)).command
      : confirmation?.requestJson
        ? canonicalCsvApplyCommand(JSON.parse(confirmation.requestJson)).command
        : null;
    const summary = current ? runs.summary(current.runId) : null;
    const proof = current ? runs.inspect(current) : null;
    const state: CsvApplyRunData["state"] = !run
      ? confirmation?.cancellationCommandId
        ? "cancelled"
        : "not_confirmed"
      : !current
        ? "superseded"
        : current.state === "complete"
          ? "completed"
          : current.state === "cancelled"
            ? "cancelled"
            : proof && proof !== "ok" && proof !== "stale_lease"
              ? "paused"
              : known && commandId !== current.commandId
                ? "superseded"
                : current.state;
    const code: CsvApplyRunData["code"] =
      current &&
      proof &&
      proof !== "ok" &&
      proof !== "stale_lease" &&
      state !== "completed" &&
      state !== "cancelled"
        ? proof
        : current
          ? current.code
          : null;
    const terminal =
      state === "completed" ||
      state === "cancelled" ||
      state === "failed" ||
      state === "superseded";
    const rawAvailable =
      Date.parse(stage.staging_expires_at) > Date.now() &&
      stage.status !== "purged" &&
      proof !== "input_expired";
    const actions: CsvApplyRunData["allowed_actions"] = terminal
      ? ["inspect", ...(stage.purge_allowed ? ["purge" as const] : [])]
      : state === "not_confirmed"
        ? ["inspect", "apply", ...(confirmation ? ["cancel" as const] : [])]
        : state === "paused" || state === "partial"
          ? ["inspect", "cancel", ...(rawAvailable ? ["resume" as const] : [])]
          : ["inspect", "cancel", "reconcile"];
    return {
      stage_id: stageId,
      preview_id: confirmation?.previewId ?? stage.preview_id,
      state,
      code,
      command_id:
        commandId ??
        confirmation?.cancellationCommandId ??
        (current ? current.commandId : (confirmation?.commandId ?? null)),
      command_known: commandId ? known : !!current,
      pending_command: terminal ? null : pending,
      file_rows: current ? current.fileRows : (stage.tallies?.file_rows ?? 0),
      selected_rows: current
        ? current.selectedRows
        : (stage.tallies?.selected_rows ?? 0),
      excluded_rows: current
        ? current.fileRows - current.selectedRows
        : stage.tallies
          ? stage.tallies.file_rows - stage.tallies.selected_rows
          : 0,
      committed_rows: current ? current.committedRows : 0,
      inserted_rows: summary?.insertedRows ?? 0,
      already_imported_rows: summary?.alreadyImportedRows ?? 0,
      created_setup: summary?.createdSetup ?? 0,
      source_seconds_total: current
        ? current.sourceSecondsTotal
        : (stage.tallies?.source_seconds ?? null),
      source_seconds_committed: summary?.sourceSecondsCommitted ?? 0,
      destination_seconds: summary?.destinationSeconds ?? 0,
      destination_delta_seconds: summary?.destinationDeltaSeconds ?? 0,
      deleted_imported_rows: summary?.deletedImportedRows ?? 0,
      retention_deadline: stage.retention_deadline,
      retryable:
        !terminal &&
        rawAvailable &&
        (state === "paused" || state === "partial"),
      allowed_actions: actions,
    };
  };
  const execute = async (
    authority: CsvStagingAuthority,
    stageId: string,
    packet: CsvApplyCommand,
    resume: boolean,
  ) => {
    await staging.authorizeRun(authority, stageId);
    const intent = canonicalCsvApplyCommand(packet);
    const stage = await staging.read(authority, stageId);
    let confirmation = await privateStaging.readOwnedConfirmation(
      authority,
      stageId,
    );
    if (confirmation?.cancellationCommandId)
      throw new CsvApplyRefusal("cancelled");
    const existing = runs.findByStage(stageId);
    if (existing) {
      const receipt = runs.readReceipt(
        existing.runId,
        intent.command.command_id,
      );
      if (receipt) {
        if (
          receipt.stageId !== stageId ||
          receipt.actorUserId !== authority.userId ||
          receipt.requestJson !== intent.json ||
          receipt.targetNonce !== confirmation?.targetNonce
        )
          throw new CsvApplyRefusal("command_conflict");
        // An exact accepted command never resets retry counters or creates new work.
        if (
          !existing.ready &&
          existing.state === "queued" &&
          existing.commandId === packet.command_id &&
          runs.inspect(existing) === "ok"
        )
          await bound(existing);
        return status(authority, stageId, packet.command_id);
      }
    }
    if (confirmation) {
      if (
        !resume &&
        (confirmation.commandId !== packet.command_id ||
          confirmation.requestJson !== intent.json)
      )
        throw new CsvApplyRefusal("command_conflict");
      if (
        resume &&
        (packet.version !== stage.version ||
          packet.preview_id !== confirmation.previewId)
      )
        throw new CsvApplyRefusal("binding_mismatch");
    } else {
      if (resume) throw new CsvApplyRefusal("binding_mismatch");
      await privateStaging.claimConfirmation(authority, {
        stageId,
        previewId: packet.preview_id,
        expectedVersion: packet.version,
        commandId: packet.command_id,
        requestJson: intent.json,
      });
      confirmation = await privateStaging.readOwnedConfirmation(
        authority,
        stageId,
      );
    }
    if (!confirmation || confirmation.cancellationCommandId)
      throw new CsvApplyRefusal("cancelled");
    const input = await privateStaging.loadOwnedPreview(
      authority,
      stageId,
      packet.preview_id,
    );
    const plan = input.plan;
    if (input.stale || plan.rejectedRows || plan.plan.report.fileErrors.length)
      throw new CsvApplyRefusal("binding_mismatch");
    if (
      packet.expected_selected_rows !== plan.selectedRows ||
      packet.expected_source_seconds !== plan.sourceSeconds ||
      packet.expected_destination_seconds !== plan.destinationSeconds ||
      (plan.excludedLines.length > 0 && !packet.acknowledge_exclusions) ||
      (plan.destinationDeltaSeconds !== 0 &&
        !packet.acknowledge_destination_difference) ||
      (plan.plan.report.people.new > 0 && !packet.acknowledge_new_people)
    )
      throw new CsvApplyRefusal("binding_mismatch");
    const native = createSqliteCsvBrowserService(database, {
      authorityFence: (actor) =>
        csvStagingSessionFence(
          authority,
          input.targetNonce,
          Number(actor.userId),
        ),
    });
    const seal = await native.confirm(
      { kind: "administrator", userId: String(authority.userId) },
      plan,
    );
    if (seal.outcome === "blocked")
      throw new CsvApplyRefusal("binding_mismatch");
    const accepted = runs.authorize({
      runId: seal.run.runId,
      stageId,
      stageVersion: input.stageVersion,
      previewId: packet.preview_id,
      targetNonce: input.targetNonce,
      authority,
      inputExpiresAt: input.inputExpiresAt,
      commandId: packet.command_id,
      confirmationCommandId: confirmation.commandId,
      requestJson: intent.json,
      planId: seal.run.planId,
      sourceSecondsTotal: plan.sourceSeconds,
      acknowledgedDestinationDelta: plan.destinationDeltaSeconds,
    });
    if (
      accepted.outcome !== "replayed" ||
      accepted.run.commandId === packet.command_id
    )
      await bound(accepted.run);
    return status(authority, stageId, packet.command_id);
  };
  const port: CsvImportApplyPort = {
    apply: (authority, stageId, command) =>
      execute(authority, stageId, command, false),
    resume: (authority, stageId, command) =>
      execute(authority, stageId, command, true),
    status,
    async cancel(authority, stageId, command) {
      await staging.authorizeRun(authority, stageId);
      const stage = await staging.read(authority, stageId);
      const confirmation = await privateStaging.readOwnedConfirmation(
        authority,
        stageId,
      );
      if (!confirmation) throw new CsvApplyRefusal("run_not_found");
      const cancellation = await privateStaging.requestOwnedCancellation(
        authority,
        {
          stageId,
          previewId: confirmation.previewId,
          confirmationCommandId: confirmation.commandId,
          cancellationCommandId: command.command_id,
          expectedVersion: stage.version,
        },
      );
      // A racing new association must be reread, never cancelled using oldstage metadata.
      for (let attempt = 0; attempt < 3; attempt++) {
        const run = runs.findByStage(stageId);
        if (
          !run ||
          run.nativeState === "complete" ||
          run.nativeState === "cancelled"
        )
          return status(authority, stageId);
        try {
          let cancelled = runs.cancel(authority, {
            runId: run.runId,
            stageId,
            targetNonce: confirmation.targetNonce,
            previewId: confirmation.previewId,
            executionCommandId: run.commandId,
            commandId: command.command_id,
          });
          cancelled =
            runs.recordStageVersion(cancelled, cancellation.stageVersion) ??
            cancelled;
          const updated = await privateStaging.markSystemProgress(
            stageBinding(cancelled),
            "cancelled",
            "cancelled_by_administrator",
            cancelled.finishedAt ?? undefined,
          );
          if (updated) runs.recordStageVersion(cancelled, updated.stageVersion);
          return status(authority, stageId);
        } catch (cause) {
          if (
            !(cause instanceof CsvApplyRefusal) ||
            cause.code !== "run_not_found"
          )
            throw cause;
        }
      }
      throw new CsvApplyRefusal("apply_busy");
    },
  };
  const shutdown = new AbortController();
  const driver = createSqliteCsvApplyDriver(database, privateStaging, {
    holder: () => crypto.randomUUID(),
    signal: shutdown.signal,
    ...(options.reportError ? { reportError: report } : {}),
    classifyError: (cause) =>
      cause instanceof CsvStagingError
        ? cause.code === "preview_stale"
          ? "policy_changed"
          : cause.code === "run_not_found"
            ? "input_unavailable"
            : null
        : null,
  });
  let active = false;
  let pending: Promise<unknown> | null = null;
  let closed = false;
  return {
    port,
    runs,
    async close() {
      closed = true;
      shutdown.abort();
      await pending?.catch(() => undefined);
    },
    tick() {
      if (active || closed) return Promise.resolve(null);
      const work = (async () => {
        if (active || closed) return null;
        active = true;
        try {
          const waiting = runs.listUnbound(1)[0];
          if (waiting) {
            const proof = runs.inspect(waiting);
            if (proof === "ok") {
              try {
                const confirmation = await privateStaging.readOwnedConfirmation(
                  waiting.authority,
                  waiting.stageId,
                );
                if (confirmation?.cancellationCommandId) {
                  runs.cancel(waiting.authority, {
                    runId: waiting.runId,
                    stageId: waiting.stageId,
                    targetNonce: waiting.targetNonce,
                    previewId: waiting.previewId,
                    executionCommandId: waiting.commandId,
                    commandId: confirmation.cancellationCommandId,
                  });
                } else if (
                  confirmation?.commandId === waiting.confirmationCommandId &&
                  confirmation.targetNonce === waiting.targetNonce
                ) {
                  await bound(waiting);
                } else
                  runs.settle(waiting, null, "paused", "input_unavailable");
              } catch (cause) {
                if (
                  !(cause instanceof CsvStagingError) &&
                  !(cause instanceof CsvApplyRefusal)
                ) {
                  report(cause);
                }
                // No input is read by recovery and no uncertain association is activated.
                runs.settle(
                  waiting,
                  null,
                  "paused",
                  runs.inspect(waiting) === "ok"
                    ? "input_unavailable"
                    : "authority_revoked",
                );
              }
            } else if (proof !== "stale_lease")
              runs.settle(waiting, null, "paused", proof);
          }
          if (closed) return null;
          return await driver.tick();
        } finally {
          active = false;
        }
      })();
      pending = work;
      return work;
    },
  };
};
