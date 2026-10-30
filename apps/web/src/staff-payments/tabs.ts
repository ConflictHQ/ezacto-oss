export type PaymentTab = 'balances' | 'reconcile' | 'actuals' | 'allocations' | 'advances' | 'invoices' | 'send' | 'history' | 'settings'

export const createPaymentTabs = (page: HTMLElement) => {
  const tabs = [
    ...page.querySelectorAll<HTMLButtonElement>('[data-payment-tab]'),
  ]
  const panels = [...page.querySelectorAll<HTMLElement>('[data-payment-panel]')]
  const select = (name: PaymentTab, focus = false): void => {
    const next = tabs.find(
      (tab) => tab.dataset.paymentTab === name && !tab.hidden,
    )
    if (!next) return
    for (const tab of tabs) {
      const selected = tab === next
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
    }
    for (const panel of panels)
      panel.hidden = panel.dataset.paymentPanel !== name
    const runs = page.querySelector<HTMLElement>('[data-payment-runs]')
    if (runs) runs.hidden = name !== 'send' && name !== 'history'
    if (focus) next.focus()
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () =>
      select(tab.dataset.paymentTab as PaymentTab),
    )
    tab.addEventListener('keydown', (event) => {
      const visible = tabs.filter(
        (candidate) => !candidate.hidden && !candidate.disabled,
      )
      const index = visible.indexOf(tab)
      const next =
        event.key === 'Home'
          ? visible[0]
          : event.key === 'End'
            ? visible.at(-1)
            : event.key === 'ArrowRight'
              ? visible[(index + 1) % visible.length]
              : event.key === 'ArrowLeft'
                ? visible[(index + visible.length - 1) % visible.length]
                : undefined
      if (!next) return
      event.preventDefault()
      select(next.dataset.paymentTab as PaymentTab, true)
    })
  }
  return {
    select,
    activate: (reportMode: boolean, canSend: boolean) => {
      for (const tab of tabs)
        tab.hidden =
          reportMode ||
          (!canSend &&
            ['send', 'history'].includes(tab.dataset.paymentTab ?? ''))
      if (reportMode)
        panels.forEach((panel) => {
          panel.hidden = true
        })
      else select('balances')
    },
  }
}
