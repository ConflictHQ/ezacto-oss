import { shellJavascript, shellStylesheet } from '../generated/shell-assets.js'
import { themeManifest } from '../theme.js'
import { type DeploymentBrand, resolveDeploymentBrand } from '../brand.js'
import { renderClientDirectoryPages } from '../clients/render.js'
import { renderProjectDirectoryPages } from '../projects/render.js'
import { renderReportsPage } from '../reports/render.js'
import { renderExpenseWorkflowPages } from '../expenses/render.js'
import { renderTaskAdminPage } from '../tasks/render.js'
import { renderTeamPages } from '../team/render.js'
import { renderExpenseCategoriesPage } from '../expense-categories/render.js'
import { renderModuleSettingsPage } from '../module-settings/render.js'
import {
  renderInvoiceAttachmentSection,
  renderInvoiceComposerDialog,
  renderInvoiceDeliveryDialog,
  renderInvoicePaymentDialogs,
  renderInvoicePaymentSection,
  renderInvoiceLineDialogs,
  renderInvoiceLineEditor,
} from '../invoices/render.js'

export interface AppShellOptions {
  readonly environment: string
  readonly release: string
  readonly brand?: Partial<DeploymentBrand>
  readonly activeSection?:
    // 'Settings' matches no nav item on purpose. Without it the default lands
    // on 'Time', so the module settings page marked Time as the page you were
    // on; naming a section outside the primary nav marks nothing, which is the
    // truth.
    | 'Settings'
    | 'Time'
    | 'Approvals'
    | 'Expenses'
    | 'Team'
    | 'Projects'
    | 'Tasks'
    | 'Clients'
    | 'Invoices'
    | 'Reports'
  readonly view?:
    | 'time'
    | 'timesheet-approvals'
    | 'invoice-list'
    | 'invoice-detail'
    | 'invoice-generation'
    | 'client-list'
    | 'client-detail'
    | 'project-list'
    | 'project-detail'
    | 'task-list'
    | 'reports'
    | 'expense-list'
    | 'expense-detail'
    | 'expense-categories'
    | 'module-settings'
    | 'team-list'
    | 'team-person'
  readonly signInProviders?: readonly SignInProvider[]
  /** Presentation hint only. The browser still validates the session before enabling the app. */
  readonly sessionCookiePresent?: boolean
}

export type SignInProvider = 'google' | 'github'

export interface DataQualityBannerOptions {
  readonly message: string
  readonly fixHref: string
  readonly fixLabel: string
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )

const safePath = (value: string): string => {
  if (!value.startsWith('/') || value.startsWith('//')) {
    throw new Error('deep links must be same-origin absolute paths')
  }
  return value
}

export const renderDataQualityBanner = (options: DataQualityBannerOptions): string =>
  `<aside class="data-quality" role="status" data-data-quality-banner>` +
  `<span>${escapeHtml(options.message)}</span>` +
  `<a href="${escapeHtml(safePath(options.fixHref))}">${escapeHtml(options.fixLabel)}</a>` +
  `</aside>`

export const renderEmptyState = (title: string, detail: string): string =>
  `<section class="empty-state" data-empty-state>` +
  `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p></section>`

export const renderDocumentShell = (title: string, content: string, brand?: Partial<DeploymentBrand>): string => {
  const b = resolveDeploymentBrand(brand)
  return `<article class="document-shell" data-document-shell data-ez-theme="precision">` +
  `<header><a href="/">← Time</a><span>${escapeHtml(b.name)}</span></header>` +
  `<main><h1>${escapeHtml(title)}</h1><div class="document-content">${escapeHtml(content)}</div>` +
  `</main></article>`
}

const sections = [
  'Time',
  'Approvals',
  'Expenses',
  'Team',
  'Projects',
  'Tasks',
  'Clients',
  'Invoices',
  'Reports',
] as const

const hrefFor = (section: (typeof sections)[number]): string =>
  section === 'Time'
    ? '/'
    : section === 'Approvals'
      ? '/approvals'
      : section === 'Invoices'
        ? '/invoices'
        : `/${section.toLocaleLowerCase('en-US')}`

const providerSignIn = (providers: readonly SignInProvider[]): string => {
  const links: string[] = []
  if (providers.includes('google')) {
    links.push(
      `<a class="oidc-sign-in" data-oidc-provider="google" href="${safePath('/auth/oidc/google')}">Continue with Google</a>`,
    )
  }
  if (providers.includes('github')) {
    links.push(
      `<a class="oidc-sign-in" data-oidc-provider="github" href="${safePath('/auth/github')}">Continue with GitHub</a>`,
    )
  }
  if (links.length === 0) return ''
  return (
    `<div class="oidc-entry" data-oidc-entry>` +
    links.join('') +
    `<span class="auth-divider" aria-hidden="true">or use your password</span>` +
    `</div>`
  )
}

export const renderAppShell = (options: AppShellOptions): string => {
  const active = options.activeSection ?? 'Time'
  const view = options.view ?? 'time'
  const b = resolveDeploymentBrand(options.brand)
  const brand = b.name
  const resumeSession = options.sessionCookiePresent === true
  const shortRelease = options.release.slice(0, 7)
  const navigation = sections
    .map(
      (section) =>
        `<a href="${hrefFor(section)}"${section === 'Approvals' ? ' data-approvals-nav hidden' : ''}${section === 'Team' ? ' data-team-nav hidden' : ''}${section === active ? ' aria-current="page"' : ''}>${section}</a>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en" data-ez-theme="precision" data-app-view="${view}" data-auth-state="${resumeSession ? 'checking' : 'unknown'}" data-brand="${escapeHtml(brand)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="ezacto-environment" content="${escapeHtml(options.environment)}">
  <meta name="ezacto-release" content="${escapeHtml(options.release)}">
  <title>${escapeHtml(brand)} — Sign in</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="${escapeHtml(themeManifest.precision.fontStylesheet)}">
${b.favicon ? `  <link rel="icon" href="${escapeHtml(b.favicon)}">\n` : ''}  <link rel="stylesheet" href="/assets/ezacto.css">
  <script type="module" src="/assets/ezacto.js"></script>
</head>
<body>
  <section class="auth-gateway" data-auth-gateway data-state="checking" aria-label="${escapeHtml(brand)} sign in" aria-busy="true"${resumeSession ? ' hidden' : ''}>
    <div class="auth-splash">
      <a class="auth-wordmark" href="/" aria-label="${escapeHtml(brand)} home">${escapeHtml(brand)}</a>
      <div class="auth-splash-copy">
        <p class="eyebrow">${escapeHtml(b.tagline)}</p>
        <h1>Make every hour visible.</h1>
        <p>Track the work, understand the week, and turn time into a clear record.</p>
      </div>
      <p class="auth-splash-foot">${escapeHtml(b.description)}</p>
    </div>
    <div class="auth-entry">
      <div class="auth-card">
        <div class="auth-checking" data-auth-checking role="status" aria-live="polite">
          <span aria-hidden="true"></span>
          <p>Checking your session…</p>
        </div>
        <form class="sign-in-form" data-sign-in-form method="post" action="/auth/sign-in" hidden>
          <div class="auth-heading">
            <p class="eyebrow">Welcome back</p>
            <h2 id="sign-in-title">Sign in to ${escapeHtml(brand)}</h2>
            <p>Use your account to continue to your workspace.</p>
          </div>
          ${providerSignIn(options.signInProviders ?? [])}
          <label for="ez-sign-in-email">Email
            <input id="ez-sign-in-email" name="email" type="email" inputmode="email" autocomplete="username" required>
          </label>
          <label for="ez-sign-in-password">Password
            <input id="ez-sign-in-password" name="password" type="password" autocomplete="current-password" required>
          </label>
          <button class="primary-action" type="submit" data-sign-in-submit>Sign in</button>
          <p class="auth-result" data-sign-in-result role="status" aria-live="polite"></p>
        </form>
        <noscript>${renderEmptyState('JavaScript is required', `The ${escapeHtml(brand)} app uses JavaScript to establish and protect your session.`)}</noscript>
      </div>
      <p class="auth-build-stamp">${escapeHtml(options.environment)} · ${escapeHtml(shortRelease)}</p>
    </div>
  </section>
  <aside class="session-check-overlay" data-session-check-overlay role="status" aria-live="polite" aria-atomic="true"${resumeSession ? '' : ' hidden'}>
    <div class="session-check-card">
      <span class="session-check-spinner" aria-hidden="true"></span>
      <p>Checking your session…</p>
    </div>
  </aside>
  <div class="authenticated-shell" data-authenticated-shell${resumeSession ? '' : ' hidden'} inert aria-busy="true">
  <header class="topbar">
    <a class="brand" href="/" aria-label="${escapeHtml(brand)} home">${escapeHtml(brand)}</a>
    <nav class="primary-nav" aria-label="Primary">${navigation}</nav>
    <button class="timer-chip" type="button" data-timer-chip data-state="loading" data-auth-action disabled aria-haspopup="dialog">
      <span class="live-dot" aria-hidden="true"></span>
      <span data-timer-label>Timer</span>
      <span data-timer-elapsed>—</span>
    </button>
    <button class="command-trigger" type="button" data-command-trigger data-auth-action disabled aria-haspopup="dialog">⌘K</button>
    <button class="menu-trigger" type="button" data-menu-trigger aria-label="Open navigation" aria-haspopup="dialog">Menu</button>
    <div class="account" data-auth-shell data-state="loading">
      <div class="account-identity" data-current-identity hidden>
        <svg class="identity-avatar" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="8.5" r="3.25"/><path d="M5.75 19a6.25 6.25 0 0 1 12.5 0"/></svg>
        <span class="identity-text">
          <span class="visually-hidden">Signed in as </span><span class="identity-name" data-current-profile>—</span>
          <span class="identity-meta">User #<span data-current-user-id>—</span></span>
        </span>
        <button type="button" class="identity-signout" data-logout>Sign out</button>
        <p class="auth-result visually-hidden" data-logout-result role="status" aria-live="polite"></p>
      </div>
    </div>
  </header>
  <nav class="tabstrip" aria-label="Time views"${view === 'time' ? '' : ' hidden'}>
    <a href="/" aria-current="page">Week</a><a href="/?view=day">Day</a>
  </nav>
  <main class="app-content" data-app-content${view === 'time' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">This week</p><h1>Time</h1></div>
      <button class="primary-action" type="button" data-command-trigger data-auth-action disabled>Log time</button>
    </header>
    <aside class="session-status" data-session-status role="status">
      <span data-session-message>Connecting to your ${escapeHtml(brand)} session…</span>
      <button type="button" data-retry-week hidden>Retry week</button>
    </aside>
    <section class="week-surface" aria-labelledby="week-heading">
      <header class="week-toolbar">
        <div>
          <p class="eyebrow">Monday–Sunday</p>
          <h2 id="week-heading">Week of <span data-week-label>—</span></h2>
        </div>
        <div class="week-actions">
          <button type="button" data-week-previous data-auth-action disabled aria-label="Previous week">←</button>
          <button type="button" data-week-current data-auth-action disabled>This week</button>
          <button type="button" data-week-next data-auth-action disabled aria-label="Next week">→</button>
          <button type="button" data-copy-last-week data-auth-action disabled>Copy last week</button>
          <button type="button" data-add-row-trigger data-auth-action disabled>Add row</button>
          <strong data-week-total>—</strong>
        </div>
      </header>
      <aside class="timesheet-status" data-timesheet-status hidden aria-live="polite">
        <div>
          <p class="eyebrow">Timesheet approval</p>
          <strong data-timesheet-status-label>Not submitted</strong>
          <p data-timesheet-rejection-reason hidden></p>
          <p class="form-result" data-timesheet-result role="status"></p>
        </div>
        <div class="timesheet-status-actions">
          <button type="button" data-withdraw-timesheet data-auth-action hidden disabled>Reopen week</button>
          <button class="primary-action" type="button" data-submit-timesheet data-auth-action disabled>Submit week</button>
        </div>
      </aside>
      <ol class="day-totals" data-day-totals aria-label="Hours by day"></ol>
      <div class="week-grid-wrap" data-week-grid data-view="desktop">
        <table class="week-grid-table">
          <thead data-week-grid-head><tr><th>Project / task</th><th colspan="8">Loading week…</th></tr></thead>
          <tbody data-week-grid-rows><tr><td colspan="9">Loading time entries…</td></tr></tbody>
          <tfoot data-week-grid-totals></tfoot>
        </table>
      </div>
      <div class="day-list" data-day-list data-view="phone">
        <header class="day-switcher">
          <button type="button" data-day-previous data-auth-action disabled aria-label="Previous day">←</button>
          <strong data-day-label>—</strong>
          <button type="button" data-day-next data-auth-action disabled aria-label="Next day">→</button>
        </header>
        <div data-day-rows><p class="day-empty">Loading time entries…</p></div>
      </div>
    </section>
  </main>
  <main class="app-content timesheet-approvals" data-timesheet-approvals-page${view === 'timesheet-approvals' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Timesheets</p><h1>Approvals</h1></div>
      <a href="/">Back to time</a>
    </header>
    <section data-approval-review-panel>
      <p class="approval-intro">Review submitted time before it becomes locked.</p>
      <form class="approval-filters" data-approval-filters>
        <label>Person <select name="user_id" data-approval-filter-user><option value="">All</option></select></label>
        <label>Client <select name="client_id" data-approval-filter-client><option value="">All</option></select></label>
        <label>Project <select name="project_id" data-approval-filter-project><option value="">All</option></select></label>
        <button type="submit" class="filter-apply">Apply</button>
      </form>
      <p class="form-result" data-approval-queue-result role="status" aria-live="polite"></p>
      <section class="approval-queue" data-approval-queue aria-label="Pending timesheets"></section>
      <button type="button" class="load-more" data-approval-load-more hidden>Load more</button>
      <section class="approval-queue" data-approval-history aria-label="Recently approved timesheets"></section>
      <button type="button" class="load-more" data-approval-history-load-more hidden>Load more</button>
    </section>
    <section class="timesheet-lock-policy" data-lock-policy-panel hidden aria-labelledby="lock-policy-title">
      <header>
        <div><p class="eyebrow">Organization policy</p><h2 id="lock-policy-title">Time and expense locks</h2></div>
        <p>Deadline and manual locks remain in force until explicitly unlocked.</p>
      </header>
      <form class="lock-policy-form" data-lock-policy-form>
        <label class="lock-policy-toggle"><input name="autoLock" type="checkbox" data-lock-policy-auto>Automatically lock completed weeks</label>
        <label>Deadline day
          <select name="deadlineDay" data-lock-policy-day>
            <option value="sunday">Sunday</option><option value="monday">Monday</option>
            <option value="tuesday">Tuesday</option><option value="wednesday">Wednesday</option>
            <option value="thursday">Thursday</option><option value="friday">Friday</option>
            <option value="saturday">Saturday</option>
          </select>
        </label>
        <label>Deadline time<input name="deadlineTime" type="time" data-lock-policy-time required></label>
        <label>Organization timezone<input name="timezone" type="text" data-lock-policy-timezone autocomplete="off" maxlength="128" required></label>
        <button class="primary-action" type="submit" data-lock-policy-submit>Save policy</button>
      </form>
      <form class="manual-lock-form" data-manual-lock-form>
        <div>
          <p class="eyebrow">One-time cutoff</p>
          <h3>Lock all tracked work through a date</h3>
        </div>
        <label>Locked through<input name="lockedThrough" type="date" data-manual-lock-through required></label>
        <label>Reason<textarea name="reason" data-manual-lock-reason rows="3" maxlength="10000" required></textarea></label>
        <button type="submit" data-manual-lock-submit>Create lock</button>
      </form>
      <p class="form-result" data-lock-policy-result role="status" aria-live="polite"></p>
      <div class="timesheet-lock-list" data-timesheet-lock-list aria-live="polite"></div>
    </section>
  </main>
  <main class="app-content invoice-workspace" data-invoice-list-page${view === 'invoice-list' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Money</p><h1>Invoices</h1></div>
      <a class="primary-action invoice-create-link" href="/invoices/new">Generate invoice</a>
    </header>
    <p class="invoice-intro">Browse generated and imported invoices. Amounts are shown in each invoice's own currency.</p>
    <p class="form-result invoice-page-status" data-invoice-list-status role="status" aria-live="polite">Loading invoices…</p>
    <section class="invoice-list" data-invoice-list aria-label="Invoices"></section>
    <button class="invoice-load-more" type="button" data-invoice-load-more hidden>Load more invoices</button>
  </main>
  <main class="app-content invoice-workspace" data-invoice-detail-page${view === 'invoice-detail' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Invoices</p><h1>Invoice detail</h1></div>
      <a href="/invoices">Back to invoices</a>
    </header>
    <p class="form-result invoice-page-status" data-invoice-detail-status role="status" aria-live="polite">Loading invoice…</p>
    <button class="invoice-load-more" type="button" data-invoice-detail-retry hidden>Retry invoice</button>
    <article class="invoice-document" data-invoice-document data-document-shell data-ez-theme="precision" hidden>
      <header class="invoice-document-heading">
        <div>
          <p class="eyebrow">Invoice</p>
          <h2 data-invoice-detail-number>—</h2>
          <p data-invoice-detail-subject hidden></p>
        </div>
        <div class="invoice-document-actions"><strong class="invoice-state" data-invoice-detail-state>—</strong><button type="button" data-invoice-deliver disabled hidden>Send invoice</button><button type="button" data-invoice-send disabled hidden>Mark sent</button></div>
      </header>
      <p class="invoice-reminder-line" data-invoice-reminder-line hidden></p>
      <dl class="invoice-facts">
        <div><dt>Client</dt><dd data-invoice-detail-client>—</dd></div>
        <div><dt>Issued</dt><dd data-invoice-detail-issued>—</dd></div>
        <div><dt>Due</dt><dd data-invoice-detail-due-date>—</dd></div>
        <div><dt>Period</dt><dd data-invoice-detail-period>—</dd></div>
        <div><dt>Purchase order</dt><dd data-invoice-detail-purchase-order>—</dd></div>
      </dl>
      ${renderInvoiceLineEditor()}
      <div class="invoice-line-wrap">
        <table class="invoice-line-table">
          <thead><tr><th scope="col">Description</th><th scope="col">Quantity</th><th scope="col">Rate</th><th scope="col">Amount</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody data-invoice-detail-lines></tbody>
        </table>
      </div>
      <dl class="invoice-totals">
        <div><dt>Discount</dt><dd data-invoice-detail-discount>—</dd></div>
        <div><dt>Tax</dt><dd data-invoice-detail-tax>—</dd></div>
        <div><dt>Total</dt><dd data-invoice-detail-total>—</dd></div>
        <div><dt>Amount due</dt><dd data-invoice-detail-due>—</dd></div>
      </dl>
      <section class="invoice-notes" data-invoice-detail-notes-section hidden>
        <h3>Notes</h3><p data-invoice-detail-notes></p>
      </section>
      ${renderInvoicePaymentSection()}
      ${renderInvoiceAttachmentSection()}
      <section class="invoice-history" aria-labelledby="invoice-message-heading">
        <h3 id="invoice-message-heading">History</h3>
        <ul data-invoice-detail-messages></ul>
      </section>
    </article>
  </main>
  <main class="app-content invoice-generation" data-invoice-generation-page${view === 'invoice-generation' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Invoices</p><h1>Generate an invoice</h1></div>
      <a href="/invoices">Back to invoices</a>
    </header>
    <p class="invoice-intro">Choose one client, a bounded date range, and the tracked work to turn into a draft invoice.</p>
    <form class="invoice-generation-form" data-invoice-generation-form>
      <fieldset>
        <legend>1. Client and period</legend>
        <label for="ez-invoice-client">Client
          <select id="ez-invoice-client" name="client" data-invoice-client required></select>
        </label>
        <div class="invoice-period">
          <label for="ez-invoice-from">From<input id="ez-invoice-from" name="from" type="date" required></label>
          <label for="ez-invoice-to">To<input id="ez-invoice-to" name="to" type="date" required></label>
        </div>
      </fieldset>
      <fieldset>
        <legend>2. Projects</legend>
        <div class="invoice-projects" data-invoice-projects role="group" aria-label="Projects">
          <p>Loading projects…</p>
        </div>
      </fieldset>
      <fieldset>
        <legend>3. Line detail</legend>
        <label for="ez-invoice-time-summary">Time entries
          <select id="ez-invoice-time-summary" name="timeSummary">
            <option value="project">Summarize by project</option>
            <option value="task">Summarize by task</option>
            <option value="people">Summarize by person</option>
            <option value="detailed">One line per entry</option>
            <option value="">Do not include time</option>
          </select>
        </label>
        <label for="ez-invoice-expense-summary">Expenses
          <select id="ez-invoice-expense-summary" name="expenseSummary">
            <option value="project">Summarize by project</option>
            <option value="category">Summarize by category</option>
            <option value="people">Summarize by person</option>
            <option value="detailed">One line per expense</option>
            <option value="">Do not include expenses</option>
          </select>
        </label>
      </fieldset>
      <p class="form-result" data-invoice-generation-result role="status" aria-live="polite"></p>
      <button type="button" data-retry-invoice-catalog hidden>Retry loading clients and projects</button>
      <button class="primary-action" type="submit" data-invoice-generation-submit data-auth-action disabled>Generate draft invoice</button>
    </form>
    <section class="invoice-generation-success" data-invoice-generation-success hidden aria-live="polite">
      <p class="eyebrow">Draft created</p>
      <h2 data-generated-invoice-number>Invoice</h2>
      <p data-generated-invoice-total></p>
      <p>The draft is saved and ready to review.</p>
      <a data-generated-invoice-link href="/invoices" hidden>Open draft invoice</a>
    </section>
  </main>
  ${renderClientDirectoryPages(view)}
  ${renderTeamPages(view)}
  ${renderProjectDirectoryPages(view)}
  ${renderTaskAdminPage(view)}
  ${renderReportsPage(view)}
  ${renderExpenseWorkflowPages(view)}
  ${renderExpenseCategoriesPage(view)}
  ${renderModuleSettingsPage(view)}
  ${renderInvoiceComposerDialog()}
  ${renderInvoiceDeliveryDialog()}
  ${renderInvoiceLineDialogs()}
  ${renderInvoicePaymentDialogs()}
  <dialog class="command-dialog" data-command-dialog aria-labelledby="command-title">
    <form data-command-form>
      <header><div><p class="eyebrow">Command bar</p><h2 id="command-title">Go or log time</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
      <label for="ez-command">Command</label>
      <input id="ez-command" name="command" autocomplete="off" placeholder="log 2h northpeak devops" required>
      <p class="hint">Try “log 2h project task”. Press Esc to close.</p>
      <p class="form-result" data-command-result role="status"></p>
      <button class="primary-action" type="submit">Run command</button>
    </form>
  </dialog>
  <dialog class="entry-dialog" data-entry-dialog data-timer-dialog data-note-dialog aria-labelledby="entry-title">
    <form data-timer-form novalidate data-entry-form data-note-form>
      <header><div><p class="eyebrow" data-entry-context>Time entry</p><h2 id="entry-title" data-entry-title data-note-title>Log time</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
      <div class="entry-assignment">
        <label>Project<input name="project" data-entry-project autocomplete="off" required></label>
        <label>Task<input name="task" data-entry-task autocomplete="off" required></label>
      </div>
      <label>Date<input name="spent_date" data-entry-date type="date" required></label>
      <label data-entry-duration>Duration<input name="duration" data-entry-duration-input inputmode="decimal" autocomplete="off" placeholder="1:30"></label>
      <div class="entry-times" data-entry-times hidden>
        <label>Start<input name="started_time" data-entry-start autocomplete="off" placeholder="9:00 AM"></label>
        <label>End<input name="ended_time" data-entry-end autocomplete="off" placeholder="5:00 PM"></label>
      </div>
      <p class="hint" data-entry-running hidden>This entry is running. Stop it before changing its assignment or timing.</p>
      <label for="ez-entry-note">Note<textarea id="ez-entry-note" name="notes" data-entry-note-input data-timer-note data-note-input rows="5" maxlength="10000" aria-describedby="note-hint note-result"></textarea></label>
      <p class="hint" id="note-hint" data-entry-note-hint data-timer-note-hint data-note-hint>Optional. Up to 10,000 characters.</p>
      <p class="form-result" id="note-result" data-entry-result data-timer-result data-note-result role="status"></p>
      <div class="timer-actions"><button class="primary-action" type="submit" data-entry-submit>Save entry</button><button type="button" data-stop-timer hidden>Stop running timer</button></div>
    </form>
  </dialog>
  <dialog class="menu-dialog" data-menu-dialog aria-labelledby="menu-title">
    <header><h2 id="menu-title">Navigate</h2><button type="button" data-dialog-close aria-label="Close">×</button></header>
    <nav aria-label="Mobile primary">${navigation}</nav>
  </dialog>
  <dialog class="row-dialog" data-row-dialog aria-labelledby="row-title">
    <form data-row-form>
      <header><div><p class="eyebrow">Timesheet row</p><h2 id="row-title">Add project and task</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
      <label>Project<select name="project" data-row-project required></select></label>
      <label>Task<select name="task" data-row-task required></select></label>
      <p class="form-result" data-row-result role="status"></p>
      <button class="primary-action" type="submit">Add row</button>
    </form>
  </dialog>
  <dialog class="rejection-dialog" data-rejection-dialog aria-labelledby="rejection-title">
    <form data-rejection-form novalidate>
      <header><div><p class="eyebrow">Return timesheet</p><h2 id="rejection-title">Reason for rejection</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
      <label for="ez-rejection-reason">What needs to change?<textarea id="ez-rejection-reason" name="reason" data-rejection-reason rows="5" maxlength="10000" required></textarea></label>
      <p class="hint">Required. This reason is shown to the person who submitted the timesheet.</p>
      <p class="form-result" data-rejection-result role="status" aria-live="polite"></p>
      <button class="primary-action" type="submit" data-rejection-submit>Reject timesheet</button>
    </form>
  </dialog>
  <dialog class="rejection-dialog" data-withdrawal-dialog aria-labelledby="withdrawal-title">
    <form data-withdrawal-form novalidate>
      <header><div><p class="eyebrow">Explicit unlock</p><h2 id="withdrawal-title">Reopen approved timesheet</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
      <label for="ez-withdrawal-reason">Why is this period being reopened?<textarea id="ez-withdrawal-reason" name="reason" data-withdrawal-reason rows="5" maxlength="10000" required></textarea></label>
      <p class="hint">Required. This action and reason are written to the audit stream.</p>
      <p class="form-result" data-withdrawal-result role="status" aria-live="polite"></p>
      <button class="primary-action" type="submit" data-withdrawal-submit>Reopen timesheet</button>
    </form>
  </dialog>
  <footer class="build-stamp">${escapeHtml(options.environment)} · ${escapeHtml(shortRelease)}</footer>
  </div>
</body>
</html>`
}

export const webAssets = {
  stylesheet: shellStylesheet,
  javascript: shellJavascript,
} as const
