import type { InvoiceLineTimeReleaseInput } from '@conflict-hq/ezacto-client'
import type { InvoiceHoursReview, InvoiceTimeReleaseApi } from './model.js'
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
  const element = document.createElement(tag)
  element.textContent = text
  return element
}
export const createInvoiceTimeRelease = (
  api: InvoiceTimeReleaseApi,
  options: {
    context: () => { signal: AbortSignal; pending: boolean } | null
    busy: (value: boolean) => void
    reload: () => Promise<void>
    saveForReview: () => Promise<void>
    error: (error: unknown) => string
  },
) => {
  const states = new WeakMap<HTMLElement, string>()
  return {
    sync: (
      row: HTMLElement,
      review: InvoiceHoursReview | null,
      source: InvoiceHoursReview['lines'][number] | undefined,
      dirty: boolean,
      localBilled: number | null,
    ) => {
      if (!api.releaseInvoiceLineTime) return
      const key = JSON.stringify([
        review?.hours_version,
        source?.line_id,
        dirty,
        localBilled,
        row.hasAttribute('data-removed'),
      ])
      if (states.get(row) === key) return
      states.set(row, key)
      row.querySelector('[data-invoice-time-release]')?.remove()
      if (
        !review ||
        !source ||
        review.invoice_state !== 'draft' ||
        !review.hours_version ||
        review.invoice_version === null ||
        !(
          source.status === 'billed_below_linked' ||
          (dirty &&
            localBilled !== null &&
            source.linked_seconds - localBilled > review.tolerance_seconds)
        ) ||
        row.hasAttribute('data-removed')
      )
        return
      const box = node('fieldset')
      box.dataset.invoiceTimeRelease = ''
      box.className = 'invoice-time-release'
      box.appendChild(node('legend', 'Release time to match'))
      // Inner controls must not become invoice-line edits or submit the invoice.
      box.addEventListener('input', (event) => event.stopPropagation())
      box.addEventListener('change', (event) => event.stopPropagation())
      row.querySelector('.invoice-line-meta')!.appendChild(box)
      if (dirty) {
        box.appendChild(
          node('p', 'Save the quantity change before choosing which linked entries to release.'),
        )
        const save = node('button', 'Save changes and review linked time')
        save.type = 'button'
        box.appendChild(save)
        save.addEventListener('click', () => {
          if (!options.context()?.pending) void options.saveForReview()
        })
        return
      }
      const needed = source.linked_seconds - source.billed_seconds
      box.appendChild(
        node(
          'p',
          `Choose whole entries totalling ${(needed / 3600).toFixed(2)} h. Released time becomes eligible for a future invoice. The tracked hours stay unchanged.`,
        ),
      )
      const label = node('label', 'Person '),
        people = node('select')
      people.setAttribute('aria-label', 'Person for time release')
      label.appendChild(people)
      box.appendChild(label)
      const entries = review.entries.filter(
        (entry) => entry.entry_id !== null && source.entry_ids.includes(entry.entry_id),
      )
      const personChoices: readonly (readonly [string, string])[] = [
        ['', 'Everyone on this line'],
        ...[
          ...new Map(
            entries.map((entry) => [String(entry.user_id), entry.user_name ?? 'Unknown person']),
          ),
        ],
      ]
      for (const [value, text] of personChoices) {
        const option = node('option', text)
        option.value = value
        people.appendChild(option)
      }
      const choices = node('div'),
        summary = node('p'),
        status = node('p'),
        confirm = node('button', 'Confirm release of selected time'),
        reload = node('button', 'Reload linked hours')
      status.setAttribute('role', 'status')
      status.setAttribute('aria-live', 'polite')
      confirm.type = reload.type = 'button'
      confirm.disabled = true
      for (const item of [choices, summary, confirm, reload, status]) box.appendChild(item)
      let pending: InvoiceLineTimeReleaseInput | null = null
      const selected = () =>
        [...choices.querySelectorAll<HTMLInputElement>('input:checked')].map((input) =>
          Number(input.value),
        )
      const tally = () => {
        const ids = new Set(selected()),
          seconds = entries
            .filter((entry) => ids.has(entry.entry_id!))
            .reduce((sum, entry) => sum + entry.seconds, 0)
        summary.textContent = `Selected: ${(seconds / 3600).toFixed(2)} h · needed: ${(needed / 3600).toFixed(2)} h.`
        confirm.disabled =
          !ids.size ||
          ids.size > 1000 ||
          seconds <= 0 ||
          Math.abs(seconds - needed) > review.tolerance_seconds
      }
      const paint = () => {
        choices.replaceChildren()
        for (const entry of entries.filter(
          (entry) => !people.value || String(entry.user_id) === people.value,
        )) {
          const choice = node('label'),
            input = node('input')
          input.type = 'checkbox'
          input.value = String(entry.entry_id)
          input.disabled = !entry.eligible_for_release
          choice.appendChild(input)
          choice.appendChild(
            document.createTextNode(
              `${entry.spent_date ?? 'Date unavailable'} · ${entry.user_name ?? 'Unknown person'} · ${(entry.seconds / 3600).toFixed(2)} h`,
            ),
          )
          choices.appendChild(choice)
          input.addEventListener('change', tally)
        }
        tally()
      }
      people.addEventListener('change', paint)
      paint()
      reload.addEventListener('click', () => {
        if (!options.context()?.pending) void options.reload()
      })
      confirm.addEventListener('click', () => {
        const context = options.context()
        if (!context || context.signal.aborted || context.pending || confirm.disabled) return
        pending ??= {
          command_id: crypto.randomUUID(),
          line_id: source.line_id,
          expected_version: review.invoice_version!,
          hours_version: review.hours_version!,
          entry_ids: selected(),
          confirmed: true,
        }
        for (const control of box.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
          'input,select',
        ))
          control.disabled = true
        confirm.disabled = true
        options.busy(true)
        status.textContent = 'Releasing selected time…'
        void api.releaseInvoiceLineTime!(review.invoice_id, pending, context.signal)
          .then(async () => {
            if (!context.signal.aborted) await options.reload()
          })
          .catch((error) => {
            if (context.signal.aborted || !box.isConnected) return
            status.textContent = `${options.error(error)} Retry this same release or reload linked hours before changing the selection.`
            confirm.textContent = 'Retry same release'
          })
          .finally(() => {
            if (context.signal.aborted) return
            options.busy(false)
            if (box.isConnected) confirm.disabled = false
          })
      })
    },
  }
}
