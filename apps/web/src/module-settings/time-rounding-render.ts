import {
  timeRoundingIncrementLabel,
  timeRoundingIncrements,
  timeRoundingModeLabels,
  timeRoundingModes,
} from '@ezacto/core'

/**
 * Kept apart from the controller so the page's markup can be rendered where
 * there is no DOM: the shell's renderer is also compiled for the Worker.
 */
const options = (values: readonly (readonly [string, string])[]): string =>
  values.map(([value, text]) => `<option value="${value}">${text}</option>`).join('')

export const renderTimeRoundingSection = (): string => `
      <form class="settings-form" data-rounding-form hidden>
        <h3>Time rounding</h3>
        <p>How a time entry is rounded before it is billed, unless its project sets its own rule. The rounded hours are fixed when an entry is saved, so changing the rule affects time saved from now on and leaves everything already saved, invoiced time included, as it is.</p>
        <label>Direction
          <select name="mode" data-rounding-mode>${options(timeRoundingModes.map((mode) => [mode, timeRoundingModeLabels[mode]]))}</select>
        </label>
        <label>Increment
          <select name="minutes" data-rounding-minutes>${options(timeRoundingIncrements.map((minutes) => [String(minutes), timeRoundingIncrementLabel(minutes)]))}</select>
        </label>
        <button class="primary-action" type="submit" data-rounding-submit>Save rounding</button>
      </form>
      <p class="form-result" data-rounding-result role="status" aria-live="polite"></p>
      <section class="settings-form" data-rounding-recalculate aria-labelledby="rounding-recalculate-title" hidden>
        <h3 id="rounding-recalculate-title">Recalculate open entries</h3>
        <p>Applies today's rules to time saved earlier. Only entries that can still be edited are touched: not invoiced, not approved, not in a locked period, under an active client, project and task. Preview first; nothing changes until you apply.</p>
        <label>From <input type="date" data-rounding-from></label>
        <label>To <input type="date" data-rounding-to></label>
        <button type="button" data-rounding-preview>Preview</button>
        <div data-rounding-preview-output role="status" aria-live="polite"></div>
        <button class="primary-action" type="button" data-rounding-apply hidden>Apply this preview</button>
        <p class="form-result" data-rounding-recalculate-result role="status" aria-live="polite"></p>
      </section>`
