import type { WebhookSubscription, WebhookDelivery, Whoami } from '@conflict-hq/ezacto-client'
import { renderDataTable } from '../components/data-table.js'
import { apiErrorMessage, type WebhookApi } from './model.js'
interface Active {
  identity: Whoami
  signal: AbortSignal
  presentFailure(error: unknown, paint: () => void): void
}
export const createWebhookController = (api: WebhookApi | undefined) => {
  const root = document.querySelector<HTMLElement>('[data-settings-section="webhooks"]')
  if (!root) return { clear() {}, async load() {} }
  const find = <T extends Element>(name: string) =>
    root.querySelector<T>(`[data-webhooks-${name}]`)!
  const status = find<HTMLElement>('status'),
    content = find<HTMLElement>('content')
  const create = find<HTMLFormElement>('create'),
    filter = find<HTMLFormElement>('filter')
  const secret = find<HTMLDialogElement>('secret'),
    value = find<HTMLInputElement>('secret-value')
  const action = find<HTMLDialogElement>('action'),
    actionForm = find<HTMLFormElement>('action-form')
  let active: Active | null = null,
    subscriptions: WebhookSubscription[] = [],
    logs: WebhookDelivery[] = []
  let next: string | null = null,
    ready = false,
    pending = false
  let selected: { row: WebhookSubscription; kind: 'rotate' | 'delete' } | null = null
  const current = (a: Active) => active === a && !a.signal.aborted
  const busy = (enabled: boolean) => {
    pending = enabled
    for (const control of root.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLSelectElement
    >('button,input,select'))
      if (!secret.contains(control)) control.disabled = enabled
    create.hidden = !ready
  }
  const clear = () => {
    active = null
    ready = false
    subscriptions = []
    logs = []
    next = null
    selected = null
    value.value = ''
    secret.close()
    action.close()
    content.hidden = true
    find<HTMLElement>('subscriptions').replaceChildren()
    find<HTMLElement>('log').replaceChildren()
    find<HTMLElement>('events').replaceChildren()
    create.reset()
    filter.reset()
    busy(false)
  }
  const displaySecret = (key: string) => {
    value.value = key
    find<HTMLElement>('secret-status').textContent = ''
    secret.showModal()
    value.focus()
    value.select()
  }
  const run = async (operation: (a: Active) => Promise<void>) => {
    const a = active
    if (!a || pending || !api) return
    busy(true)
    status.textContent = ''
    try {
      await operation(a)
    } catch (error) {
      if (current(a))
        a.presentFailure(error, () => {
          status.textContent = apiErrorMessage(
            error,
            'The webhook operation failed. Refresh and try again.',
          )
        })
    } finally {
      if (current(a)) busy(false)
    }
  }
  const renderSubscriptions = () => {
    find<HTMLElement>('subscriptions').replaceChildren(
      renderDataTable<WebhookSubscription>({
        caption: 'Webhook endpoints',
        table: 'webhook-subscriptions',
        rows: subscriptions,
        rowKey: (s) => s.id,
        empty: 'No webhook endpoints yet.',
        columns: [
          { key: 'url', label: 'Endpoint', render: (s) => s.url },
          { key: 'events', label: 'Events', render: (s) => s.events.join(', ') },
          { key: 'state', label: 'State', render: (s) => (s.is_active ? 'Active' : 'Paused') },
        ],
        actions: (row) => [
          {
            label: row.is_active ? 'Pause' : 'Resume',
            disabled: !row.is_active && !ready,
            onSelect: () => {
              void run(async (a) => {
                await api!.setWebhookSubscriptionActive({
                  id: row.id,
                  body: { version: row.version, is_active: !row.is_active },
                  signal: a.signal,
                })
                await refresh(a)
              })
            },
          },
          ...(['rotate', 'delete'] as const).map((kind) => ({
            label: kind === 'rotate' ? 'Rotate secret' : 'Delete',
            disabled: kind === 'rotate' && !ready,
            onSelect: () => {
              selected = { row, kind }
              find<HTMLElement>('action-title').textContent =
                kind === 'rotate' ? 'Rotate signing secret' : 'Delete endpoint'
              find<HTMLElement>('action-description').textContent =
                `${row.url}. ${kind === 'delete' ? 'Pending deliveries stop and signing keys are erased.' : 'Copy the new secret once and update your receiver.'}`
              find<HTMLElement>('overlap').hidden = kind !== 'rotate'
              find<HTMLElement>('overlap-note').hidden = kind !== 'rotate'
              ;(actionForm.elements.namedItem('overlap_seconds') as HTMLInputElement).disabled =
                kind !== 'rotate'
              action.showModal()
            },
          })),
        ],
      }),
    )
    const select = filter.elements.namedItem('subscription_id') as HTMLSelectElement,
      previous = select.value
    select.replaceChildren(
      new Option('All endpoints', ''),
      ...subscriptions.map((s) => new Option(s.url, s.id)),
    )
    select.value = previous
  }
  const renderLogs = () => {
    find<HTMLElement>('log').replaceChildren(
      renderDataTable<WebhookDelivery>({
        caption: 'Webhook deliveries',
        table: 'webhook-deliveries',
        rows: logs,
        rowKey: (d) => d.id,
        empty: 'No matching deliveries. New matching events appear after an endpoint is created.',
        columns: [
          { key: 'event', label: 'Event', render: (d) => `${d.event_type} · ${d.event_id}` },
          {
            key: 'status',
            label: 'Result',
            render: (d) =>
              `${d.status}${d.last_status ? ` · HTTP ${d.last_status}` : ''}${d.last_error_code ? ` · ${d.last_error_code}` : ''}`,
          },
          { key: 'attempts', label: 'Attempts', render: (d) => String(d.attempt_count) },
          { key: 'created', label: 'Created (UTC)', render: (d) => d.created_at },
        ],
        actions: (d) =>
          ready &&
          ['delivered', 'failed'].includes(d.status) &&
          Date.parse(d.created_at) >= Date.now() - 7 * 86400000
            ? [
                {
                  label: 'Replay',
                  onSelect: () => {
                    void run(async (a) => {
                      await api!.replayWebhookDelivery({ id: d.id, body: {}, signal: a.signal })
                      await loadLogs(a, false)
                    })
                  },
                },
              ]
            : [],
      }),
    )
    find<HTMLButtonElement>('more').hidden = next === null
  }
  const loadLogs = async (a: Active, append: boolean) => {
    const sub = (filter.elements.namedItem('subscription_id') as HTMLSelectElement).value,
      state = (filter.elements.namedItem('status') as HTMLSelectElement).value
    const response = await api!.listWebhookDeliveries({
      signal: a.signal,
      query: {
        per_page: 50,
        ...(append && next ? { cursor: next } : {}),
        ...(sub ? { subscription_id: sub } : {}),
        ...(state ? { status: state as WebhookDelivery['status'] } : {}),
      },
    })
    if (!current(a)) return
    logs = append ? [...logs, ...response.data] : response.data
    next = response.page.next_cursor
    renderLogs()
  }
  const refresh = async (a: Active) => {
    const response = await api!.listWebhookSubscriptions({ signal: a.signal })
    if (!current(a)) return
    subscriptions = response.data
    ready = response.configuration.ready
    renderSubscriptions()
    create.hidden = !ready
    content.hidden = false
    const events = find<HTMLElement>('events')
    events.replaceChildren()
    for (const name of response.configuration.event_types) {
      const label = document.createElement('label'),
        input = document.createElement('input')
      label.className = 'settings-toggle'
      input.type = 'checkbox'
      input.name = 'event'
      input.value = name
      label.append(input, document.createTextNode(name))
      events.append(label)
    }
    status.textContent = ready
      ? 'New matching events are queued for signed delivery.'
      : 'Delivery is unavailable. A deployment operator must configure the dedicated webhook encryption key. Public demo delivery is disabled.'
    await loadLogs(a, false)
  }
  create.addEventListener('submit', (e) => {
    e.preventDefault()
    if (!create.reportValidity()) return
    const data = new FormData(create),
      events = data.getAll('event') as WebhookSubscription['events']
    if (!events.length) {
      status.textContent = 'Select at least one event.'
      return
    }
    void run(async (a) => {
      const result = await api!.createWebhookSubscription({
        body: { url: String(data.get('url')), events },
        signal: a.signal,
      })
      if (!current(a)) return
      displaySecret(result.signing_secret)
      create.reset()
      await refresh(a)
    })
  })
  actionForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const command = selected
    if (!command || !actionForm.reportValidity()) return
    action.close()
    selected = null
    void run(async (a) => {
      if (command.kind === 'delete')
        await api!.deleteWebhookSubscription({
          id: command.row.id,
          body: { version: command.row.version },
          signal: a.signal,
        })
      else {
        const response = await api!.rotateWebhookSecret({
          id: command.row.id,
          body: {
            version: command.row.version,
            overlap_seconds: Number(
              (actionForm.elements.namedItem('overlap_seconds') as HTMLInputElement).value,
            ),
          },
          signal: a.signal,
        })
        if (!current(a)) return
        displaySecret(response.signing_secret)
      }
      await refresh(a)
    })
  })
  find<HTMLButtonElement>('cancel').addEventListener('click', () => {
    selected = null
    action.close()
  })
  secret.addEventListener('close', () => {
    value.value = ''
  })
  find<HTMLButtonElement>('secret-close').addEventListener('click', () => secret.close())
  find<HTMLButtonElement>('copy').addEventListener('click', () => {
    void navigator.clipboard.writeText(value.value).then(
      () => {
        find<HTMLElement>('secret-status').textContent = 'Copied.'
      },
      () => {
        value.focus()
        value.select()
        find<HTMLElement>('secret-status').textContent =
          'Copy was unavailable. Select and copy the secret manually.'
      },
    )
  })
  filter.addEventListener('submit', (e) => {
    e.preventDefault()
    void run((a) => loadLogs(a, false))
  })
  find<HTMLButtonElement>('refresh').addEventListener('click', () => {
    void run(refresh)
  })
  find<HTMLButtonElement>('more').addEventListener('click', () => {
    void run((a) => loadLogs(a, true))
  })
  return {
    clear,
    async load(a: Active) {
      clear()
      active = a
      a.signal.addEventListener(
        'abort',
        () => {
          if (active === a) clear()
        },
        { once: true },
      )
      if (a.identity.profile !== 'administrator') {
        status.textContent = 'Only administrators can manage webhooks.'
        return
      }
      if (!api) {
        status.textContent = 'Webhook management is unavailable.'
        return
      }
      await run(refresh)
    },
  }
}
