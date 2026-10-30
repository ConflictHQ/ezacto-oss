/** @vitest-environment happy-dom */
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createReportsController } from '../src/reports/browser.js'
import type { ReportWorkspaceApi } from '../src/reports/model.js'
import { identity, writeDocument, emptyTimeReport, baseApi, detailedTimeRow, detailedTimeReport } from './support/report-harness.js'

// Separate Windows bound retained shell parses at the existing CI heap limit.
describe('module-dependent report capabilities (#1259)', () => {
  it('[browser #1259] withdraws a refused expense report without retrying or hiding independent time', async () => {
    writeDocument('/reports?report=detailed-expense&from=2026-08-01&to=2026-08-31')
    let enabled = false
    const getDetailedExpenseReport = vi.fn<NonNullable<ReportWorkspaceApi['getDetailedExpenseReport']>>(async (filter, signal) => {
      if (enabled) return baseApi().getDetailedExpenseReport!(filter, signal)
      throw new EzactoApiError(403, { error: { code: 'module_disabled' } }, 'expense-module-fixture')
    })
    const getTimeReport = vi.fn(async () => emptyTimeReport)
    const active = new AbortController()
    onTestFinished(() => active.abort())
    const controller = createReportsController(baseApi({ getDetailedExpenseReport, getTimeReport }))
    await controller.activate(identity('administrator'), active.signal, () => false)
    expect(document.querySelector('[data-report-status]')?.textContent).toBe('The Expenses module is switched off.')
    expect(document.querySelector('.tabstrip a[href*="report=detailed-expense"]')).toBeNull()
    expect(document.querySelector('[data-builder-template] option[value="detailed-expense"]')).toBeNull()
    expect(document.querySelector<HTMLFormElement>('[data-report-form]')!.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-report-retry]')!.hidden).toBe(true)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getDetailedExpenseReport).toHaveBeenCalledTimes(1)
    const time = document.querySelector<HTMLAnchorElement>('.tabstrip a[href*="report=time&"]')!
    time.click()
    await vi.waitFor(() => expect(getTimeReport).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(document.querySelector('[data-report-status]')?.textContent).toBe('Report loaded.'))
    expect(document.querySelector<HTMLFormElement>('[data-report-form]')!.hidden).toBe(false)
    window.history.replaceState(null, '', '/reports?report=detailed-expense&from=2026-08-01&to=2026-08-31')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await vi.waitFor(() => expect(document.querySelector<HTMLFormElement>('[data-report-form]')!.hidden).toBe(true))
    expect(getDetailedExpenseReport).toHaveBeenCalledTimes(1)
    active.abort()
    enabled = true
    const renewed = new AbortController()
    onTestFinished(() => renewed.abort())
    await controller.activate(identity('administrator'), renewed.signal, () => false)
    expect(getDetailedExpenseReport).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-report-status]')?.textContent).toBe('Report loaded.')
    expect(document.querySelector('.tabstrip a[href*="report=detailed-expense"]')).not.toBeNull()
    expect(document.querySelector('[data-builder-template] option[value="detailed-expense"]')).not.toBeNull()
    expect(document.querySelector<HTMLFormElement>('[data-report-form]')!.hidden).toBe(false)
  })

  it('[browser #1259] keeps historical invoice references and moving time while withdrawing invoice mutations', async () => {
    writeDocument('/reports?report=detailed-time&from=2026-08-01&to=2026-08-31&grain=entry')
    document.documentElement.setAttribute('data-invoices-unavailable', '')
    const executeDetailedTimeAction = vi.fn()
    const report = detailedTimeReport({ grain: 'entry', rows: [detailedTimeRow({ time_entry_id: 91, invoice_id: 301, invoice_number: '0301' })] })
    const active = new AbortController()
    await createReportsController(baseApi({ getDetailedTimeReport: async () => report, executeDetailedTimeAction })).activate(identity('administrator'), active.signal, () => false)
    expect(document.querySelector('[data-report-results]')?.textContent).toContain('0301')
    expect(document.querySelector('a[href="/invoices/0301"]')).toBeNull()
    expect(document.querySelector('[data-detailed-action="mark_invoiced"]')).toBeNull()
    expect(document.querySelector('[data-detailed-action="mark_uninvoiced"]')).toBeNull()
    expect(document.querySelector('[data-detailed-action="move"]')).not.toBeNull()
    expect(executeDetailedTimeAction).not.toHaveBeenCalled()
    active.abort()
  })



  it.each([true, false])('[browser #1259] renders issued invoices and preserves client and status filters (invoices=%s)', async (invoicesEnabled) => {
    writeDocument('/reports?report=invoiced&from=2026-08-01&to=2026-08-31&client_id=1&status=open')
    document.documentElement.toggleAttribute('data-invoices-unavailable', !invoicesEnabled)
    const getInvoicedReport = vi.fn(async () => ({
      from: '2026-08-01',
      to: '2026-08-31',
      client_id: 1,
      status: 'open' as const,
      totals: [{ currency: 'USD', invoice_count: 1, invoiced_cents: 100_000, paid_cents: 25_000, balance_cents: 75_000 }],
      rows: [{
        invoice_id: 301,
        number: '0301',
        state: 'open' as const,
        close_reason: null,
        issue_date: '2026-08-01',
        due_date: '2026-08-15',
        client_id: 1,
        client_name: 'Parent',
        subject: 'August delivery',
        currency: 'USD',
        invoiced_cents: 100_000,
        paid_cents: 25_000,
        balance_cents: 75_000,
      }],
    }))
    await createReportsController(baseApi({ getInvoicedReport })).activate(
      identity('administrator'),
      new AbortController().signal,
      () => false,
    )

    expect(getInvoicedReport).toHaveBeenCalledWith(
      { from: '2026-08-01', to: '2026-08-31', client_id: 1, status: 'open' },
      expect.anything(),
    )
    const results = document.querySelector('[data-report-results]')!
    expect(results.textContent).toContain('Sent')
    expect(results.textContent).toContain('$1,000.00')
    expect(results.textContent).toContain('$750.00')
    // Addressed by the number it shows, leading zero and all, not by its id.
    expect(results.textContent).toContain('0301')
    expect(results.querySelector('a[href="/invoices/0301"]')?.textContent ?? null).toBe(invoicesEnabled ? '0301' : null)
    expect(results.querySelector('a[href="/clients/1"]')?.textContent).toBe('Parent')
    expect(document.querySelector<HTMLSelectElement>('[data-report-invoice-status]')?.value).toBe('open')
  })


  it.each([true, false])('[browser #1259] renders payments received with invoice and client drill-throughs (invoices=%s)', async (invoicesEnabled) => {
    writeDocument('/reports?report=payments-received&from=2026-08-01&to=2026-08-31&client_id=1')
    document.documentElement.toggleAttribute('data-invoices-unavailable', !invoicesEnabled)
    const getPaymentsReceivedReport = vi.fn(async () => ({
      from: '2026-08-01', to: '2026-08-31', client_id: 1,
      totals: [{ currency: 'USD', payment_count: 1, payment_cents: 25_000 }],
      rows: [{
        payment_id: 901,
        payment_date: '2026-08-20',
        invoice_id: 301,
        invoice_number: '0301',
        client_id: 1,
        client_name: 'Parent',
        currency: 'USD',
        provider: 'manual',
        invoice_total_cents: 100_000,
        payment_cents: 25_000,
      }],
    }))
    await createReportsController(baseApi({ getPaymentsReceivedReport })).activate(
      identity('accounting'),
      new AbortController().signal,
      () => false,
    )

    expect(getPaymentsReceivedReport).toHaveBeenCalledWith(
      { from: '2026-08-01', to: '2026-08-31', client_id: 1 },
      expect.anything(),
    )
    const results = document.querySelector('[data-report-results]')!
    expect(results.textContent).toContain('2026-08-20')
    expect(results.textContent).toContain('$250.00')
    expect(results.textContent).toContain('0301')
    expect(results.querySelector('a[href="/invoices/0301"]')?.textContent ?? null).toBe(invoicesEnabled ? '0301' : null)
  })


  it.each([true, false])('[browser #1259 #713] preserves uninvoiced totals and gates generation (invoices=%s)', async (invoicesEnabled) => {
    writeDocument('/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31')
    document.documentElement.toggleAttribute('data-invoices-unavailable', !invoicesEnabled)
    const getUninvoicedReport = vi.fn(async () => ({
      from: '2026-08-01', to: '2026-08-31', client_id: null, project_id: null,
      totals: [{
        currency: 'USD', rounded_seconds: 7_200, time_entry_count: 2,
        unpriced_time_entry_count: 0, expense_count: 1,
        time_cents: 20_000, expense_cents: 5_000, total_cents: 25_000,
      }],
      projects: [
        {
          client_id: 1, client_name: 'Parent', project_id: 7,
          project_name: 'Launch', project_code: 'WEB',
          totals: [{
            currency: 'USD', rounded_seconds: 3_600, time_entry_count: 1,
            unpriced_time_entry_count: 0, expense_count: 1,
            time_cents: 10_000, expense_cents: 5_000, total_cents: 15_000,
          }],
        },
        {
          client_id: 2, client_name: 'Studio', project_id: 9,
          project_name: 'Identity', project_code: '',
          totals: [{
            currency: 'USD', rounded_seconds: 3_600, time_entry_count: 1,
            unpriced_time_entry_count: 0, expense_count: 0,
            time_cents: 10_000, expense_cents: 0, total_cents: 10_000,
          }],
        },
      ],
    }))
    const session = new AbortController()
    await createReportsController(baseApi({ getUninvoicedReport })).activate(
      identity('administrator'), session.signal, () => false,
    )

    const clients = [...document.querySelectorAll<HTMLElement>('.report-uninvoiced-client')]
    expect(clients.map((client) => client.querySelector('h3')?.textContent)).toEqual([
      'Parent', 'Studio',
    ])
    expect(clients[0]!.querySelector('tbody')?.textContent).toContain('Launch (WEB)')
    expect(clients[0]!.querySelector('tbody')?.textContent).toContain('$150.00')
    expect(clients[1]!.querySelector('tbody')?.textContent).toContain('Identity')
    expect(clients[1]!.querySelector('tbody')?.textContent).toContain('$100.00')
    expect(clients[0]!.querySelector<HTMLAnchorElement>('.report-row-action')?.getAttribute('href'))
      .toBe(invoicesEnabled ? '/invoices/new?client_id=1&project_id=7&from=2026-08-01&to=2026-08-31' : undefined)
    session.abort()
  })

})
