import {
  parseEstimateContent,
  estimateContentTotals,
  type EstimateContent,
  type EstimateTemplate,
} from '@ezacto/core'
import { estimateIdentityCanWrite, type EstimateWorkspaceApi } from './model.js'
import type { Whoami } from '@conflict-hq/ezacto-client'
export interface EstimateComposerApi {
  listEstimateTemplates(
    signal?: AbortSignal,
  ): Promise<{ data: readonly EstimateTemplate[]; truncated: boolean }>
  createEstimateTemplate(
    input: { name: string; content: EstimateContent },
    signal?: AbortSignal,
  ): Promise<EstimateTemplate>
  updateEstimateTemplate(
    id: string,
    input: { name: string; content: EstimateContent; expected_version: number; archived?: boolean },
    signal?: AbortSignal,
  ): Promise<EstimateTemplate>
  createEstimateDraft(
    input: {
      client_id: number
      number: string
      issue_date: string
      content: EstimateContent
      template_id: string | null
      template_version: number | null
    },
    key: string,
    signal?: AbortSignal,
  ): Promise<{ id: number }>
}
export const renderEstimateComposer = (): string => `
<details data-estimate-composer hidden>
 <summary class="primary-action">New estimate / templates</summary>
 <p>Create a draft from reusable content. Choose the client and document identity for each new quote.</p>
 <form data-quote-form class="estimate-convert-form">
  <label>Template<select data-quote-template><option value="">Start without a template</option></select></label>
  <button type="button" data-quote-reload>Reload templates</button>
  <label>Template name<input data-quote-name maxlength="120" autocomplete="off"></label>
  <label>Subject<input data-quote-subject maxlength="500"></label>
  <label>Currency<input data-quote-currency value="USD" pattern="[A-Z]{3}" maxlength="3" required></label>
  <label>Discount (%)<input data-quote-discount type="number" min="0" max="100" step="0.0001"></label>
  <label>Tax (%)<input data-quote-tax type="number" min="0" max="100" step="0.0001"></label>
  <label>Second tax (%)<input data-quote-tax2 type="number" min="0" max="100" step="0.0001"></label>
  <label>Notes<textarea data-quote-notes maxlength="20000"></textarea></label>
  <fieldset><legend>Quote lines</legend><div data-quote-lines></div><button type="button" data-quote-add>Add line</button></fieldset>
  <output data-quote-total aria-live="polite"></output>
  <div class="recurring-actions">
   <button type="button" data-quote-save>Save as new template</button>
   <button type="button" data-quote-update hidden>Update selected template</button>
   <button type="button" data-quote-archive hidden>Archive selected template</button>
  </div>
  <fieldset><legend>New draft</legend>
   <label>Client<select data-quote-client required><option value="">Choose a client</option></select></label>
   <label>Estimate number<input data-quote-number maxlength="100" autocomplete="off" required></label>
   <label>Issue date<input data-quote-date type="date" required></label>
   <button type="submit" class="primary-action" data-quote-create>Create draft</button>
  </fieldset>
 </form>
 <p data-quote-status role="status" aria-live="polite"></p>
 <a data-quote-created hidden>Open created draft</a>
</details>`
const blank = (): EstimateContent => ({
  subject: null,
  notes: null,
  currency: 'USD',
  tax_rate_ppm: null,
  tax2_rate_ppm: null,
  discount_rate_ppm: null,
  lines: [
    {
      kind: 'Service',
      description: null,
      quantity: 1,
      unit_price_cents: 0,
      taxed: false,
      taxed2: false,
    },
  ],
})
const option = (label: string, value: string): HTMLOptionElement => {
  const item = document.createElement('option')
  item.textContent = label
  item.value = value
  return item
}
export const createEstimateComposer = (
  api: Partial<EstimateComposerApi & EstimateWorkspaceApi>,
) => {
  const root = document.querySelector<HTMLDetailsElement>('[data-estimate-composer]')
  if (!root) return { activate: async () => {} }
  const find = <T>(key: string): T => {
    const value = root.querySelector(`[data-quote-${key}]`)
    if (!value) throw new Error(`quote control missing: ${key}`)
    return value as unknown as T
  }
  const form = find<HTMLFormElement>('form'),
    picker = find<HTMLSelectElement>('template'),
    client = find<HTMLSelectElement>('client'),
    lines = find<HTMLDivElement>('lines'),
    status = find<HTMLParagraphElement>('status'),
    link = find<HTMLAnchorElement>('created')
  const input = (key: string) => find<HTMLInputElement>(key)
  let listenerOwner: AbortController | undefined
  let session: { signal: AbortSignal } | undefined,
    templates: readonly EstimateTemplate[] = [],
    selected: EstimateTemplate | undefined,
    busy = false,
    draftKey = crypto.randomUUID(),
    submitted = ''
  const current = (active: { signal: AbortSignal }) => session === active && !active.signal.aborted
  const clear = () => {
    form.reset()
    lines.replaceChildren()
    picker.replaceChildren(option('Start without a template', ''))
    client.replaceChildren(option('Choose a client', ''))
    templates = []
    selected = undefined
    status.textContent = ''
    link.hidden = true
    link.removeAttribute('href')
    root.hidden = true
    root.open = false
    busy = false
  }
  const editable = () => {
    find<HTMLButtonElement>('update').hidden = !selected || selected.archived
    find<HTMLButtonElement>('archive').hidden = !selected || selected.archived
  }
  const addLine = (value: EstimateContent['lines'][number]) => {
    const row = document.createElement('fieldset')
    row.dataset.quoteLine = ''
    const legend = document.createElement('legend')
    legend.textContent = 'Line'
    row.appendChild(legend)
    for (const [key, label, type, initial] of [
      ['kind', 'Kind', 'text', value.kind],
      ['description', 'Description', 'text', value.description ?? ''],
      ['quantity', 'Quantity', 'number', value.quantity],
      ['unit_price_cents', 'Unit price (integer cents)', 'number', value.unit_price_cents],
      ['taxed', 'Tax applies', 'checkbox', value.taxed],
      ['taxed2', 'Second tax applies', 'checkbox', value.taxed2],
    ] as const) {
      const wrapper = document.createElement('label'),
        control = document.createElement('input')
      wrapper.textContent = label
      control.type = type
      control.dataset.quoteField = key
      if (type === 'checkbox') {
        wrapper.className = 'quote-tax-flag'
        control.checked = initial as boolean
      } else control.value = String(initial)
      if (type === 'number') {
        control.step = key === 'quantity' ? 'any' : '1'
        control.required = true
      }
      if (key === 'kind') {
        control.required = true
        control.maxLength = 100
      }
      if (key === 'description') control.maxLength = 10000
      wrapper.appendChild(control)
      row.appendChild(wrapper)
    }
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = 'Remove line'
    remove.addEventListener('click', () => {
      row.remove()
      total()
    })
    row.appendChild(remove)
    lines.appendChild(row)
  }
  const content = (): EstimateContent => {
    const rate = (key: string) => {
      const raw = input(key).value
      if (raw === '') return null
      const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(raw)
      if (!match) throw new Error('Percentages allow up to four decimal places.')
      return Number(match[1]) * 10000 + Number((match[2] ?? '').padEnd(4, '0'))
    }
    return parseEstimateContent({
      subject: input('subject').value || null,
      notes: find<HTMLTextAreaElement>('notes').value || null,
      currency: input('currency').value,
      tax_rate_ppm: rate('tax'),
      tax2_rate_ppm: rate('tax2'),
      discount_rate_ppm: rate('discount'),
      lines: [...lines.querySelectorAll<HTMLElement>('[data-quote-line]')].map((row) => {
        const get = (key: string) =>
          row.querySelector<HTMLInputElement>(`[data-quote-field="${key}"]`)!
        if (get('quantity').value === '' || get('unit_price_cents').value === '')
          throw new Error('Each line needs a quantity and unit price.')
        return {
          kind: get('kind').value,
          description: get('description').value || null,
          quantity: Number(get('quantity').value),
          unit_price_cents: Number(get('unit_price_cents').value),
          taxed: get('taxed').checked,
          taxed2: get('taxed2').checked,
        }
      }),
    })
  }
  const total = () => {
    try {
      const quote = content()
      find<HTMLOutputElement>('total').textContent =
        `Total: ${quote.currency} ${(estimateContentTotals(quote).amount_cents / 100).toFixed(2)}`
    } catch {
      find<HTMLOutputElement>('total').textContent = 'Complete valid quote lines to see the total.'
    }
  }
  const paint = (quote: EstimateContent) => {
    input('subject').value = quote.subject ?? ''
    find<HTMLTextAreaElement>('notes').value = quote.notes ?? ''
    input('currency').value = quote.currency
    for (const [key, value] of [
      ['tax', quote.tax_rate_ppm],
      ['tax2', quote.tax2_rate_ppm],
      ['discount', quote.discount_rate_ppm],
    ] as const)
      input(key).value = value === null ? '' : String(value / 10000)
    lines.replaceChildren()
    quote.lines.forEach(addLine)
    total()
  }
  const errorText = (error: unknown) => {
    if (typeof error === 'object' && error !== null && 'body' in error) {
      const body = error.body as { error?: { message?: string } }
      if (body?.error?.message) return body.error.message
    }
    return error instanceof Error ? error.message : 'The command failed.'
  }
  return {
    async activate(
      identity: Whoami,
      signal: AbortSignal,
      onSessionFailure: (error: unknown) => boolean,
    ) {
      listenerOwner?.abort()
      const active = { signal }
      session = active
      clear()
      listenerOwner = new AbortController()
      const listenerSignal = listenerOwner.signal
      if (
        !estimateIdentityCanWrite(identity) ||
        !api.createEstimateDraft ||
        !api.listEstimateTemplates
      )
        return
      root.hidden = false
      paint(blank())
      editable()
      input('date').value = new Date().toISOString().slice(0, 10)
      signal.addEventListener(
        'abort',
        () => {
          if (session === active) {
            listenerOwner?.abort()
            clear()
          }
        },
        { once: true },
      )
      const run = async (action: () => Promise<void>) => {
        if (!current(active) || busy) return
        busy = true
        form
          .querySelectorAll<HTMLButtonElement>('button')
          .forEach((button) => (button.disabled = true))
        try {
          await action()
        } catch (error) {
          if (current(active) && !onSessionFailure(error)) status.textContent = errorText(error)
        } finally {
          if (current(active)) {
            busy = false
            form
              .querySelectorAll<HTMLButtonElement>('button')
              .forEach((button) => (button.disabled = false))
          }
        }
      }
      const reload = async () => {
        const page = await api.listEstimateTemplates!(signal)
        if (!current(active)) return
        templates = page.data
        picker.replaceChildren(option('Start without a template', ''))
        for (const template of templates)
          picker.add(
            option(`${template.name}${template.archived ? ' (archived)' : ''}`, template.id),
          )
        selected = undefined
        editable()
        status.textContent = page.truncated
          ? 'Only the first 1000 templates are shown. Contact an operator to review the full catalog.'
          : ''
      }
      form.addEventListener('input', total, { signal: listenerSignal })
      find<HTMLButtonElement>('add').addEventListener(
        'click',
        () => {
          if (lines.children.length >= 100) {
            status.textContent = 'At most 100 lines per quote.'
            return
          }
          addLine(blank().lines[0]!)
          total()
        },
        { signal: listenerSignal },
      )
      picker.addEventListener(
        'change',
        () => {
          selected = templates.find((row) => row.id === picker.value)
          paint(selected?.content ?? blank())
          input('name').value = selected?.name ?? ''
          client.value = ''
          input('number').value = ''
          link.hidden = true
          editable()
          status.textContent = selected?.archived
            ? 'Archived template: read only. Start without a template to create a new quote.'
            : ''
        },
        { signal: listenerSignal },
      )
      find<HTMLButtonElement>('reload').addEventListener('click', () => void run(reload), {
        signal,
      })
      const save = (update: boolean) =>
        run(async () => {
          const previous = selected,
            quote = content(),
            name = input('name').value
          const saved = update
            ? await api.updateEstimateTemplate!(
                previous!.id,
                { name, content: quote, expected_version: previous!.version },
                signal,
              )
            : await api.createEstimateTemplate!({ name, content: quote }, signal)
          if (!current(active)) return
          await reload()
          if (!current(active)) return
          selected = saved
          picker.value = saved.id
          input('name').value = saved.name
          editable()
          status.textContent = 'Template saved. Existing estimates are unchanged.'
        })
      find<HTMLButtonElement>('save').addEventListener('click', () => void save(false), { signal })
      find<HTMLButtonElement>('update').addEventListener(
        'click',
        () => {
          if (selected && !selected.archived) void save(true)
        },
        { signal: listenerSignal },
      )
      find<HTMLButtonElement>('archive').addEventListener(
        'click',
        () => {
          const previous = selected
          if (
            !previous ||
            previous.archived ||
            !window.confirm('Archive this template? Existing estimates keep their content.')
          )
            return
          void run(async () => {
            await api.updateEstimateTemplate!(
              previous.id,
              {
                name: previous.name,
                content: previous.content,
                expected_version: previous.version,
                archived: true,
              },
              signal,
            )
            if (!current(active)) return
            await reload()
            if (current(active)) {
              paint(blank())
              input('name').value = ''
              status.textContent = 'Template archived.'
            }
          })
        },
        { signal: listenerSignal },
      )
      form.addEventListener(
        'submit',
        (event) => {
          event.preventDefault()
          if (selected?.archived) {
            status.textContent = 'Choose an active template or start without a template.'
            return
          }
          void run(async () => {
            const body = {
              client_id: Number(client.value),
              number: input('number').value,
              issue_date: input('date').value,
              content: content(),
              template_id: selected?.id ?? null,
              template_version: selected?.version ?? null,
            }
            const fingerprint = JSON.stringify(body)
            if (fingerprint !== submitted) {
              draftKey = crypto.randomUUID()
              submitted = fingerprint
            }
            const draft = await api.createEstimateDraft!(body, draftKey, signal)
            if (!current(active)) return
            link.href = `/invoices/estimates?estimate=${draft.id}`
            link.hidden = false
            status.textContent = 'Draft created. Review it before sending.'
          })
        },
        { signal: listenerSignal },
      )
      await run(async () => {
        await reload()
        let cursor: string | undefined
        do {
          const page = await api.listEstimateClients!(cursor, signal)
          if (!current(active)) return
          for (const row of page.data)
            if (row.is_active !== false)
              client.add(
                option(
                  typeof row.name === 'string' ? row.name : `Client #${row.id}`,
                  String(row.id),
                ),
              )
          cursor = page.page.next_cursor ?? undefined
        } while (cursor)
      })
    },
  }
}
