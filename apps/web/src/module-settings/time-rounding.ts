import { describeTimeRounding, type TimeRoundingMinutes, type TimeRoundingMode } from '@ezacto/core'
import { EzactoApiError, type TimeRoundingRecalculationPreview } from '@conflict-hq/ezacto-client'
import type { SessionPresenter } from '../session.js'
import { apiErrorMessage, type TimeRoundingApi } from './model.js'

/**
 * Settings > Time: how time is rounded before it is billed, and re-rounding
 * time that was saved under an earlier rule (issue 949).
 *
 * Saving a rule rewrites nothing. Recalculating is a separate act with a
 * preview in front of it, and the apply names the preview it was shown, so what
 * is written is what was read on screen.
 */

const failureMessage = (error: unknown, forbidden: string, fallback: string): string =>
  error instanceof EzactoApiError && error.status === 403 ? forbidden : apiErrorMessage(error, fallback)

export const roundedHours = (seconds: number): string => (seconds / 3600).toFixed(2)

const entries = (count: number): string => `${count} ${count === 1 ? 'entry' : 'entries'}`

const signedHours = (seconds: number): string => {
  const hours = roundedHours(Math.abs(seconds))
  return seconds === 0 ? '0.00 h' : `${seconds > 0 ? '+' : '-'}${hours} h`
}

/** What the preview says, one sentence a line, in the order a person decides in. */
export const recalculationSummary = (
  preview: Readonly<TimeRoundingRecalculationPreview>,
): readonly string[] => {
  const lines: string[] = []
  if (preview.changed_entries === 0) {
    lines.push(
      preview.open_entries === 0
        ? 'There are no open entries in this range.'
        : "Nothing to recalculate: the open entries already hold the hours today's rules give.",
    )
  } else {
    lines.push(
      `${entries(preview.changed_entries)} of ${preview.open_entries} open would change, ` +
        `from ${roundedHours(preview.rounded_seconds_before)} h to ${roundedHours(preview.rounded_seconds_after)} h ` +
        `(${signedHours(preview.rounded_seconds_after - preview.rounded_seconds_before)}).`,
    )
    if (preview.earliest_spent_date !== null && preview.latest_spent_date !== null) {
      lines.push(
        preview.earliest_spent_date === preview.latest_spent_date
          ? `Dated ${preview.earliest_spent_date}.`
          : `Dated ${preview.earliest_spent_date} to ${preview.latest_spent_date}.`,
      )
    }
    for (const project of preview.projects) {
      const rule = project.time_rounding
      lines.push(
        `${project.project_name}: ${entries(project.changed_entries)}, ` +
          `${roundedHours(project.rounded_seconds_before)} h to ${roundedHours(project.rounded_seconds_after)} h, ` +
          `${describeTimeRounding(rule)} (${rule.source === 'project' ? 'project setting' : 'organization setting'}).`,
      )
    }
  }
  const { invoiced, approved, locked, other } = preview.kept
  const kept: string[] = []
  if (invoiced > 0) kept.push(`${invoiced} invoiced`)
  if (approved > 0) kept.push(`${approved} approved`)
  if (locked > 0) kept.push(`${locked} in locked periods`)
  if (other > 0) kept.push(`${other} running, archived or imported corrections`)
  if (kept.length > 0) lines.push(`Left exactly as they are: ${kept.join(', ')}.`)
  return lines
}

interface Active extends SessionPresenter {
  readonly signal: AbortSignal
}

export interface TimeRoundingController {
  /** Shows the controls with the organization's current rule. */
  show(active: Active, rule: Readonly<{ mode: TimeRoundingMode; minutes: TimeRoundingMinutes }>): void
  clear(): void
}

export const createTimeRoundingController = (
  root: HTMLElement,
  api: Partial<TimeRoundingApi>,
  currentSession: () => Active | null,
): TimeRoundingController => {
  const query = <ElementType extends Element>(selector: string): ElementType => {
    const element = root.querySelector<ElementType>(selector)
    if (element === null) throw new Error(`time rounding element missing: ${selector}`)
    return element
  }
  const form = query<HTMLFormElement>('[data-rounding-form]')
  const mode = query<HTMLSelectElement>('[data-rounding-mode]')
  const minutes = query<HTMLSelectElement>('[data-rounding-minutes]')
  const submit = query<HTMLButtonElement>('[data-rounding-submit]')
  const result = query<HTMLElement>('[data-rounding-result]')
  const recalculate = query<HTMLElement>('[data-rounding-recalculate]')
  const from = query<HTMLInputElement>('[data-rounding-from]')
  const to = query<HTMLInputElement>('[data-rounding-to]')
  const previewButton = query<HTMLButtonElement>('[data-rounding-preview]')
  const previewOutput = query<HTMLElement>('[data-rounding-preview-output]')
  const applyButton = query<HTMLButtonElement>('[data-rounding-apply]')
  const recalculateResult = query<HTMLElement>('[data-rounding-recalculate-result]')

  /** The preview on screen: what the apply button will name. Null when there is none. */
  let shown: { readonly preview: TimeRoundingRecalculationPreview; readonly from: string; readonly to: string } | null =
    null

  const forget = (): void => {
    shown = null
    previewOutput.replaceChildren()
    applyButton.hidden = true
    applyButton.disabled = false
  }

  // A range edited after a preview is a different question than the one that
  // was answered, so the answer goes.
  from.addEventListener('input', forget)
  to.addEventListener('input', forget)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const active = currentSession()
    if (active === null || api.updateTimeEntryRoundingSettings === undefined) return
    result.textContent = 'Saving…'
    submit.disabled = true
    try {
      const saved = await api.updateTimeEntryRoundingSettings(
        { mode: mode.value as TimeRoundingMode, minutes: Number(minutes.value) as TimeRoundingMinutes },
        active.signal,
      )
      active.present(() => {
        mode.value = saved.mode
        minutes.value = String(saved.minutes)
        // The rule moved under any preview on screen.
        forget()
        recalculateResult.textContent = ''
        result.textContent = `Saved. New time is ${describeTimeRounding(saved)}. Time already saved keeps its hours.`
      })
    } catch (error) {
      active.presentFailure(error, () => {
        result.textContent = failureMessage(
          error,
          'Only executive managers and administrators can change time rounding.',
          'Time rounding could not be saved.',
        )
      })
    } finally {
      active.present(() => {
        submit.disabled = false
      })
    }
  })

  previewButton.addEventListener('click', async () => {
    const active = currentSession()
    if (active === null || api.previewTimeRoundingRecalculation === undefined) return
    forget()
    recalculateResult.textContent = 'Reading open entries…'
    previewButton.disabled = true
    try {
      const preview = await api.previewTimeRoundingRecalculation(
        {
          ...(from.value === '' ? {} : { from: from.value }),
          ...(to.value === '' ? {} : { to: to.value }),
        },
        active.signal,
      )
      active.present(() => {
        shown = { preview, from: from.value, to: to.value }
        const list = document.createElement('ul')
        for (const line of recalculationSummary(preview)) {
          const item = document.createElement('li')
          item.textContent = line
          list.append(item)
        }
        previewOutput.replaceChildren(list)
        applyButton.hidden = preview.changed_entries === 0
        applyButton.textContent = `Apply to ${entries(preview.changed_entries)}`
        recalculateResult.textContent = ''
      })
    } catch (error) {
      active.presentFailure(error, () => {
        recalculateResult.textContent = failureMessage(
          error,
          'Only executive managers and administrators can recalculate time rounding.',
          'The preview could not be read.',
        )
      })
    } finally {
      active.present(() => {
        previewButton.disabled = false
      })
    }
  })

  applyButton.addEventListener('click', async () => {
    const active = currentSession()
    const previewed = shown
    if (active === null || previewed === null || api.applyTimeRoundingRecalculation === undefined) return
    recalculateResult.textContent = 'Recalculating…'
    applyButton.disabled = true
    previewButton.disabled = true
    try {
      const applied = await api.applyTimeRoundingRecalculation(
        {
          fingerprint: previewed.preview.fingerprint,
          ...(previewed.from === '' ? {} : { from: previewed.from }),
          ...(previewed.to === '' ? {} : { to: previewed.to }),
        },
        active.signal,
      )
      active.present(() => {
        forget()
        recalculateResult.textContent = `Recalculated ${entries(applied.recalculated_entries)}.`
      })
    } catch (error) {
      active.presentFailure(error, () => {
        // The preview is out of date, or the apply was refused: either way the
        // preview on screen no longer describes what would happen.
        forget()
        recalculateResult.textContent =
          error instanceof EzactoApiError && error.status === 409
            ? 'The open entries changed since that preview, so nothing was recalculated. Preview again.'
            : failureMessage(
                error,
                'Only executive managers and administrators can recalculate time rounding.',
                'Time could not be recalculated.',
              )
      })
    } finally {
      active.present(() => {
        previewButton.disabled = false
      })
    }
  })

  return {
    show(active, rule) {
      active.present(() => {
        mode.value = rule.mode
        minutes.value = String(rule.minutes)
        form.hidden = api.updateTimeEntryRoundingSettings === undefined
        recalculate.hidden =
          api.previewTimeRoundingRecalculation === undefined ||
          api.applyTimeRoundingRecalculation === undefined
      })
    },
    clear() {
      form.hidden = true
      recalculate.hidden = true
      result.textContent = ''
      recalculateResult.textContent = ''
      from.value = ''
      to.value = ''
      submit.disabled = false
      previewButton.disabled = false
      forget()
    },
  }
}
