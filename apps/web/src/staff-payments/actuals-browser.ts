import {
  paymentActualsTotal,
  type ConfirmPaymentActuals,
  type PaymentActuals,
  type StaffPaymentReport,
} from '@ezacto/core'
import { moneyText } from '../money-display.js'
import { staffPaymentMoney } from './model.js'
export interface PaymentActualsApi {
  getPaymentActuals?(month: string, signal?: AbortSignal): Promise<PaymentActuals>
  confirmPaymentActuals?(command: ConfirmPaymentActuals, signal?: AbortSignal): Promise<void>
}
const node = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  label = '',
): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag)
  element.textContent = label
  return element
}
export const createActualsController = (
  page: HTMLElement,
  api: PaymentActualsApi,
  reload: () => Promise<void>,
  pay: (userId: number) => void,
  errorText: (error: unknown) => string,
) => {
  const panel = page.querySelector<HTMLElement>('[data-payment-actuals]')!
  const status = panel.querySelector<HTMLElement>('[data-actuals-status]')!
  const list = panel.querySelector<HTMLElement>('[data-actuals-review]')!
  const refresh = panel.querySelector<HTMLButtonElement>('[data-actuals-load]')!
  let ledger: StaffPaymentReport | null = null,
    signal: AbortSignal | null = null,
    generation = 0,
    saving = false
  const reset = () => {
    generation++
    ledger = null
    list.replaceChildren()
    status.textContent = ''
    refresh.disabled = true
  }
  refresh.addEventListener('click', () => {
    void load()
  })
  const load = async () => {
    const current = ledger,
      active = signal,
      own = ++generation
    if (!current || !active || active.aborted || !api.getPaymentActuals) return
    list.replaceChildren()
    status.textContent = 'Loading captured hours and rates…'
    refresh.disabled = true
    try {
      const actuals = await api.getPaymentActuals(current.month, active)
      if (active.aborted || own !== generation) return
      status.textContent = actuals.completed
        ? 'Select a person to review their earnings. Confirming earnings does not send money.'
        : 'This work month is still in progress. You can review hours now and confirm earnings after the month ends.'
      const label = node('label', 'Person '),
        select = node('select')
      select.setAttribute('aria-label', 'Review actuals for person')
      for (const person of actuals.people) {
        const option = node('option', person.name)
        option.value = String(person.user_id)
        select.appendChild(option)
      }
      label.appendChild(select)
      list.appendChild(label)
      const detail = node('section')
      list.appendChild(detail)
      const paint = () => {
        detail.replaceChildren()
        const person = actuals.people.find((p) => String(p.user_id) === select.value)
        const balance = current.rows.find((r) => r.user_id === person?.user_id)
        if (!person || !balance) {
          detail.appendChild(node('p', 'No contractor actuals for this work month.'))
          return
        }
        const entries = person.entries.map((entry) => ({ ...entry }))
        detail.appendChild(node('h3', `${person.name} · ${actuals.month}`))
        const existing = node('p', 'Currently owed: ')
        existing.appendChild(
          moneyText(staffPaymentMoney(balance.amount_cents, balance.currency)),
        )
        existing.appendChild(document.createTextNode(' · Paid: '))
        existing.appendChild(
          moneyText(staffPaymentMoney(balance.paid_cents, balance.currency)),
        )
        existing.appendChild(document.createTextNode(' · Reserved: '))
        existing.appendChild(
          moneyText(staffPaymentMoney(balance.reserved_cents ?? 0, balance.currency)),
        )
        detail.appendChild(existing)
        if (balance.status === 'settled')
          detail.appendChild(
            node(
              'p',
              'This month is historically settled. No new earnings can be confirmed until it is reopened.',
            ),
          )
        const form = node('form')
        form.dataset.actualsForm = ''
        const projects = node('fieldset')
        projects.appendChild(node('legend', 'Include projects'))
        form.appendChild(projects)
        const hourInputs = new Map<number, HTMLInputElement>()
        const projectInputs = new Map<number, HTMLInputElement>()
        const wrapper = node('div')
        wrapper.className = 'data-table-scroll'
        const table = node('table')
        table.className = 'data-table'
        table.appendChild(
          node('caption', 'Captured time entries — amounts use saved cost rates'),
        )
        const header = node('tr')
        for (const title of ['Project / date', 'Actual hours', 'Rate', 'Include hours'])
          header.appendChild(node('th', title))
        const head = node('thead')
        head.appendChild(header)
        table.appendChild(head)
        const body = node('tbody')
        table.appendChild(body)
        wrapper.appendChild(table)
        form.appendChild(wrapper)
        const total = node('p')
        total.dataset.actualsTotal = ''
        const explanation = node('label', 'Review note '),
          note = node('textarea')
        note.required = true
        note.maxLength = 2000
        note.value = `Reviewed contractor actuals for ${actuals.month}`
        explanation.appendChild(note)
        const confirm = node('button', 'Confirm earnings')
        confirm.type = 'submit'
        confirm.className = 'primary-action'
        let command: ConfirmPaymentActuals | null = null
        note.addEventListener('input', () => {
          command = null
        })
        const update = () => {
          for (const [projectId, check] of projectInputs) {
            const selected = entries.filter((e) => e.project_id === projectId)
            check.checked = selected.every((e) => e.selected_seconds === e.rounded_seconds)
            check.indeterminate =
              !check.checked && selected.some((e) => e.selected_seconds !== 0)
          }
          command = null
          try {
            const cents = paymentActualsTotal(entries)
            total.replaceChildren(
              document.createTextNode('New total owed for this work month: '),
              moneyText(staffPaymentMoney(cents, actuals.currency)),
            )
            total.appendChild(
              document.createTextNode(
                ` · ${(entries.reduce((sum, e) => sum + e.selected_seconds, 0) / 3600).toFixed(2)} hours included.`,
              ),
            )
            confirm.disabled =
              saving ||
              !actuals.completed ||
              balance.status === 'settled' ||
              cents < balance.paid_cents + (balance.reserved_cents ?? 0)
            if (cents < balance.paid_cents + (balance.reserved_cents ?? 0))
              total.appendChild(
                document.createTextNode(' Cannot reduce below paid or reserved funds.'),
              )
          } catch (error) {
            total.textContent = errorText(error)
            confirm.disabled = true
          }
        }
        for (const entry of entries) {
          const row = node('tr')
          row.appendChild(node('td', `${entry.project_name} · ${entry.spent_date}`))
          row.appendChild(node('td', (entry.rounded_seconds / 3600).toFixed(4)))
          const rate = node('td')
          rate.appendChild(
            entry.cost_rate_cents === null
              ? node('span', 'Missing rate')
              : moneyText(staffPaymentMoney(entry.cost_rate_cents, actuals.currency)),
          )
          row.appendChild(rate)
          const cell = node('td'),
            hours = node('input')
          hours.type = 'number'
          hours.step = 'any'
          hours.min = String(Math.min(0, entry.rounded_seconds) / 3600)
          hours.max = String(Math.max(0, entry.rounded_seconds) / 3600)
          hours.required = true
          hours.value = String(entry.selected_seconds / 3600)
          hours.setAttribute(
            'aria-label',
            `Included hours for ${entry.project_name} ${entry.spent_date} entry ${entry.entry_id}`,
          )
          hours.addEventListener('input', () => {
            entry.selected_seconds =
              hours.value === '' ? NaN : Math.round(Number(hours.value) * 3600)
            update()
          })
          hourInputs.set(entry.entry_id, hours)
          cell.appendChild(hours)
          row.appendChild(cell)
          body.appendChild(row)
        }
        for (const projectId of new Set(entries.map((e) => e.project_id))) {
          const projectEntries = entries.filter((e) => e.project_id === projectId)
          const label = node('label'),
            check = node('input')
          check.type = 'checkbox'
          projectInputs.set(projectId, check)
          check.checked = projectEntries.every((e) => e.selected_seconds === e.rounded_seconds)
          check.indeterminate =
            !check.checked && projectEntries.some((e) => e.selected_seconds !== 0)
          check.addEventListener('change', () => {
            for (const entry of projectEntries) {
              entry.selected_seconds = check.checked ? entry.rounded_seconds : 0
              hourInputs.get(entry.entry_id)!.value = String(entry.selected_seconds / 3600)
            }
            update()
          })
          label.appendChild(check)
          label.appendChild(document.createTextNode(projectEntries[0]!.project_name))
          projects.appendChild(label)
        }
        form.appendChild(total)
        form.appendChild(
          node(
            'p',
            'This replaces the month’s total owed; it does not add it again. Excluded hours are not added to the balance. Return here to include them later. To pay part of the full earnings, confirm all hours and adjust the amount at payment review.',
          ),
        )
        form.appendChild(explanation)
        form.appendChild(confirm)
        detail.appendChild(form)
        update()
        form.addEventListener('submit', (event) => {
          event.preventDefault()
          if (saving || confirm.disabled || !api.confirmPaymentActuals) return
          const approved = command ?? {
            id: crypto.randomUUID(),
            user_id: person.user_id,
            month: actuals.month,
            expected_version: balance.version,
            currency: actuals.currency,
            entries,
            note: note.value.trim(),
          }
          command = approved
          saving = true
          confirm.disabled = true
          select.disabled = true
          refresh.disabled = true
          for (const input of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            'input,textarea',
          ))
            input.disabled = true
          void api
            .confirmPaymentActuals(approved, active)
            .then(async () => {
              if (active.aborted || own !== generation) return
              await reload()
              if (active.aborted || own !== generation) return
              detail.replaceChildren(
                node(
                  'p',
                  `Earnings confirmed for ${person.name}. Review the payment amount before sending.`,
                ),
              )
              const updated = ledger?.rows.find((r) => r.user_id === person.user_id)
              if (
                updated?.wise_ready &&
                updated.payout_provider === 'wise' &&
                (updated.available_cents ?? updated.balance_cents ?? 0) > 0
              ) {
                const button = node('button', 'Pay now')
                button.type = 'button'
                button.addEventListener('click', () => pay(person.user_id))
                detail.appendChild(button)
              } else if (updated && !updated.wise_ready) {
                const link = node('a', 'Set up payment destination')
                link.href = `/team/${person.user_id}`
                detail.appendChild(link)
              }
              status.textContent = 'Earnings saved. No money has been sent.'
            })
            .catch((error: unknown) => {
              if (!active.aborted && own === generation) status.textContent = errorText(error)
            })
            .finally(() => {
              saving = false
              if (!active.aborted) {
                select.disabled = false
                refresh.disabled = false
                confirm.disabled = false
                for (const input of form.querySelectorAll<
                  HTMLInputElement | HTMLTextAreaElement
                >('input,textarea'))
                  input.disabled = false
              }
            })
        })
      }
      select.addEventListener('change', paint)
      paint()
    } catch (error) {
      if (!active.aborted && own === generation) status.textContent = errorText(error)
    } finally {
      if (!active.aborted && own === generation) refresh.disabled = false
    }
  }
  return {
    reset,
    ledger: (report: StaffPaymentReport, active: AbortSignal) => {
      if (ledger?.month !== report.month) reset()
      ledger = report
      signal = active
      refresh.disabled = !api.getPaymentActuals
    },
    activate: (active: AbortSignal) => {
      signal = active
      reset()
      active.addEventListener('abort', reset, { once: true })
    },
  }
}
