import { shellJavascript, shellStylesheet } from '../generated/shell-assets.js'
import { iconMarkup } from '../components/icons.js'
import { INSTANCE_THEME_STYLESHEET_PATH } from '../instance-theme.js'
import { defaultTheme, themeManifest } from '../theme.js'
import { type DeploymentBrand, resolveDeploymentBrand } from '../brand.js'
import { renderClientDirectoryPages } from '../clients/render.js'
import { renderRoleAdminPage } from '../roles/render.js'
import { renderProjectDirectoryPages } from '../projects/render.js'
import { renderDashboardPage } from '../dashboard/render.js'
import { renderReportsPage } from '../reports/render.js'
import { renderExpenseWorkflowPages } from '../expenses/render.js'
import { renderTaskAdminPage } from '../tasks/render.js'
import { renderTeamPages } from '../team/render.js'
import { renderExpenseCategoriesPage } from '../expense-categories/render.js'
import { renderEmailConfigPage } from '../email-config/render.js'
import { renderRecurringPage } from '../recurring/render.js'
import { renderRetainerDialogs, renderRetainerPage } from '../retainers/render.js'
import {
  renderActivityLogPage,
  renderModuleSettingsPage,
} from '../module-settings/render.js'
import {
  renderInvoiceAttachmentSection,
  renderInvoiceComposerDialog,
  renderInvoiceEditDialog,
  renderInvoicePaymentDialogs,
  renderInvoicePaymentSection,
  renderInvoiceLineDialogs,
  renderInvoiceLineEditor,
  renderInvoiceOverflowMenu,
  renderInvoiceTransitionDialog,
} from '../invoices/render.js'

export interface ShellTab {
  readonly label: string
  readonly href: string
  readonly current?: boolean
}

export interface AppShellOptions {
  readonly environment: string
  readonly release: string
  readonly brand?: Partial<DeploymentBrand>
  /**
   * Whether this instance has a palette of its own (issue 591). Only a flag: the
   * colours themselves are served as a stylesheet, because the shell's
   * `style-src` admits no inline style, and linking a stylesheet that would be
   * empty costs every page load a request for nothing.
   */
  readonly instanceTheme?: boolean
  readonly activeSection?:
    // 'Settings' matches no nav item on purpose. Without it the default lands
    // on 'Time', so the module settings page marked Time as the page you were
    // on; naming a section outside the primary nav marks nothing, which is the
    // truth.
    | 'Settings'
    | 'Home'
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
    | 'dashboard'
    | 'time'
    | 'timesheet-approvals'
    | 'invoice-list'
    | 'invoice-detail'
    | 'invoice-generation'
    | 'invoice-recurring'
    | 'invoice-retainers'
    | 'client-list'
    | 'client-detail'
    | 'project-list'
    | 'project-detail'
    | 'task-list'
    | 'reports'
    | 'expense-list'
    | 'expense-detail'
    | 'expense-categories'
    | 'settings-user'
    | 'settings-company'
    | 'settings-activity'
    | 'settings-templates'
    | 'settings-roles'
    | 'team-list'
    | 'team-person'
    | 'not-found'
  /**
   * The level-2 strip under the header. Time supplies its own Week/Day pair
   * when this is absent, which is what every page rendered before the strip was
   * a parameter of anything: one section owned the only sub-navigation in the
   * shell and no other could have any.
   */
  readonly tabs?: readonly ShellTab[]
  readonly signInProviders?: readonly SignInProvider[]
  /**
   * Sign-in credentials printed on the page. Only a demo deployment ever
   * supplies them, and only a deployment whose database is rebuilt nightly has
   * any business doing so.
   */
  readonly demoAccounts?: readonly DemoSignInAccount[]
  /** Presentation hint only. The browser still validates the session before enabling the app. */
  readonly sessionCookiePresent?: boolean
}

export type SignInProvider = 'google' | 'github'

export interface DemoSignInAccount {
  /** What the account is, e.g. "Administrator". */
  readonly label: string
  readonly email: string
  readonly password: string
  /** One line on what this account can see, so the choice between them means something. */
  readonly describes: string
}

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

/**
 * Time's own strip is the fallback, not the definition. Its links are marked
 * data-time-views because the browser rewrites aria-current on them from the
 * ?view= parameter -- a rule that is right for Time and wrong for every other
 * section, which does not navigate by that parameter and would have its current
 * tab stripped on load.
 *
 * It also carries view-switch, because Week and Day are two ways of looking at
 * one screen rather than two sections of the app; the level-2 underline now
 * says "you are in this part of ezacto" for Invoices and Reports, and a signal
 * that means two things means neither.
 */
const renderTabStrip = (options: AppShellOptions): string => {
  const view = options.view ?? 'time'
  if (options.tabs === undefined) {
    return (
      `<nav class="tabstrip view-switch" aria-label="Time views" data-time-views${view === 'time' ? '' : ' hidden'}>` +
      `<a href="/" aria-current="page">Week</a><a href="/?view=day">Day</a>` +
      // Restored now that it leads somewhere. It was deleted in issue 296's first
      // stage precisely because a tab that does nothing is worse than a missing
      // feature, and putting it back without the panel would repeat that.
      `<a href="/?view=calendar">Calendar</a>` +
      `</nav>`
    )
  }
  if (options.tabs.length === 0) return ''
  const links = options.tabs
    .map(
      (tab) =>
        `<a href="${escapeHtml(safePath(tab.href))}"${tab.current === true ? ' aria-current="page"' : ''}>` +
        `${escapeHtml(tab.label)}</a>`,
    )
    .join('')
  return `<nav class="tabstrip" aria-label="${escapeHtml(options.activeSection ?? 'Section')} views">${links}</nav>`
}

/**
 * Invoices' four destinations. Four routes render the same strip, and a strip
 * assembled separately at each of them is a strip whose tabs disagree about
 * where they point; the only thing a route chooses is which one it is on.
 */
const invoiceDestinations = [
  ['Overview', '/invoices', 'invoice-list'],
  ['Recurring', '/invoices/recurring', 'invoice-recurring'],
  ['Retainers', '/invoices/retainers', 'invoice-retainers'],
  // Configure left this strip for Settings. Two of the five templates it edits
  // -- the email-verification and password-reset messages -- are account mail
  // with nothing to do with invoicing, and it sits beside sender identity and
  // DNS, which is company-wide setup (issue 546). /invoices/configure still
  // resolves; it redirects.
] as const

export const invoiceTabs = (view: AppShellOptions['view']): readonly ShellTab[] =>
  invoiceDestinations.map(([label, href, destination]) => ({
    label,
    href,
    ...(view === destination ? { current: true } : {}),
  }))

/**
 * The mark, or the name set in it. Which of the two configured wordmarks a
 * surface asks for is decided by the ground it paints, not by the surface:
 * the topbar and the sign-in splash are `--ez-ink` and take the dark-ground
 * mark, the document shell is `--ez-ground` and takes the light-ground one.
 *
 * The name stays the alt text rather than being dropped, so a mark that fails
 * to load, or a reader who is not looking at the screen, still gets the brand
 * the deployment set instead of an empty link.
 */
/**
 * Same-origin, and therefore loadable. Every shell response sets
 * `img-src 'self' data:`, so only a mark this deployment serves itself can be an
 * `<img>` at all -- an uploaded asset, which lives at a root-relative
 * `/brand/<slot>/<hash>`.
 *
 * `//host/path` is excluded deliberately: it reads as a path and is a
 * cross-origin URL, which is exactly the case a `startsWith('/')` alone gets
 * wrong.
 */
const sameOriginMark = (source: string): boolean =>
  source.startsWith('/') && !source.startsWith('//')

/**
 * `BRAND_WORDMARK_*` take URLs to files the operator hosts elsewhere, and the
 * CSP above refuses those outright. Rendering one as an `<img>` regardless
 * would replace a styled wordmark with whatever the browser does for a blocked
 * image -- on the sign-in splash, which is the first thing anyone sees.
 *
 * So the two sources are not interchangeable and are not treated as one: an
 * uploaded mark is served from here and renders; a configured URL keeps the
 * text wordmark it has always rendered. `team/browser.ts` reached the same
 * conclusion about avatars for the same reason, and keeps its text underneath.
 */
const wordmark = (source: string | undefined, brand: string): string =>
  source === undefined || source === '' || !sameOriginMark(source)
    ? escapeHtml(brand)
    : `<img class="brand-mark" src="${escapeHtml(source)}" alt="${escapeHtml(brand)}">`

export const renderEmptyState = (title: string, detail: string): string =>
  `<section class="empty-state" data-empty-state>` +
  `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p></section>`

export const renderDocumentShell = (title: string, content: string, brand?: Partial<DeploymentBrand>): string => {
  const b = resolveDeploymentBrand(brand)
  return `<article class="document-shell" data-document-shell data-ez-theme="${defaultTheme}">` +
  `<header><a href="/">← Time</a><span>${wordmark(b.wordmarkLight, b.name)}</span></header>` +
  `<main><h1>${escapeHtml(title)}</h1><div class="document-content">${escapeHtml(content)}</div>` +
  `</main></article>`
}

const sections = [
  'Home',
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

/**
 * The sections that browse the firm's directories rather than the reader's own
 * work. They share one attribute because they answer one question -- may this
 * profile browse them -- and the browser opens all three from the same
 * capability, the way Approvals, Team and Invoices are each opened from theirs.
 */
const directorySections: ReadonlySet<(typeof sections)[number]> = new Set([
  'Projects',
  'Tasks',
  'Clients',
])

const hrefFor = (section: (typeof sections)[number]): string =>
  section === 'Home'
    ? '/dashboard'
    : section === 'Time'
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

/**
 * The credentials panel a demo deployment publishes on its own front page.
 *
 * Two accounts rather than one, because the interesting thing about a demo is
 * what each profile is allowed to see, and a single administrator login hides
 * exactly that. The fill button is not a convenience: a nineteen-character
 * password typed by hand is where a person gives up on a demo.
 */
const demoCredentials = (accounts: readonly DemoSignInAccount[]): string => {
  if (accounts.length === 0) return ''
  const rows = accounts
    .map(
      (account) =>
        `<li>` +
        `<p class="demo-account-label">${escapeHtml(account.label)}</p>` +
        `<p class="demo-account-describes">${escapeHtml(account.describes)}</p>` +
        `<p class="demo-account-secret"><code>${escapeHtml(account.email)}</code>` +
        `<code>${escapeHtml(account.password)}</code></p>` +
        `<button type="button" class="demo-account-fill" data-demo-fill` +
        ` data-demo-email="${escapeHtml(account.email)}"` +
        ` data-demo-password="${escapeHtml(account.password)}">` +
        `Fill in ${escapeHtml(account.label.toLowerCase())}</button>` +
        `</li>`,
    )
    .join('')
  return (
    `<section class="demo-credentials" data-demo-credentials aria-label="Demo accounts">` +
    `<p class="eyebrow">Demo instance</p>` +
    `<p class="demo-credentials-note">Every client, project and hour here is invented, ` +
    `and the database is wiped and rebuilt each night. Sign in with either account.</p>` +
    `<ul>${rows}</ul>` +
    `</section>`
  )
}

/**
 * What an unrouted path renders (issue 557).
 *
 * A stale bookmark or a mistyped URL used to drop the reader onto the API's
 * JSON error object filling the viewport, with no way back. This is the same
 * shell every other page gets, so the header and navigation are already there;
 * the body only has to say what happened and offer the way out.
 */
const renderNotFoundPage = (view?: string): string => `
  <main class="app-content page--grid" data-not-found-page${view === 'not-found' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Not found</p><h1>That page does not exist</h1></div>
    </header>
    <p class="not-found-intro">The address may be mistyped, or the page may have moved since it was bookmarked.</p>
    <p><a href="/">Go to Time</a></p>
  </main>`

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
        `<a href="${hrefFor(section)}"${section === 'Approvals' ? ' data-approvals-nav hidden' : ''}${section === 'Team' ? ' data-team-nav hidden' : ''}${section === 'Invoices' ? ' data-money-nav hidden' : ''}${directorySections.has(section) ? ' data-directory-nav hidden' : ''}${section === active ? ' aria-current="page"' : ''}>${section}</a>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en" data-ez-theme="${defaultTheme}" data-app-view="${view}" data-auth-state="${resumeSession ? 'checking' : 'unknown'}" data-brand="${escapeHtml(brand)}">
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
${options.instanceTheme === true ? `  <link rel="stylesheet" href="${INSTANCE_THEME_STYLESHEET_PATH}">\n` : ''}  <script type="module" src="/assets/ezacto.js"></script>
</head>
<body>
  <section class="auth-gateway" data-auth-gateway data-state="checking" aria-label="${escapeHtml(brand)} sign in" aria-busy="true"${resumeSession ? ' hidden' : ''}>
    <div class="auth-splash">
      <a class="auth-wordmark" href="/" aria-label="${escapeHtml(brand)} home">${wordmark(b.wordmarkDark, brand)}</a>
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
          ${demoCredentials(options.demoAccounts ?? [])}
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
    <a class="brand" href="/" aria-label="${escapeHtml(brand)} home">${wordmark(b.wordmarkDark, brand)}</a>
    <nav class="primary-nav" aria-label="Primary">${navigation}</nav>
    <button class="timer-chip" type="button" data-timer-chip data-state="loading" data-auth-action disabled aria-haspopup="dialog">
      ${iconMarkup('clock')}
      <span class="live-dot" aria-hidden="true"></span>
      <span data-timer-label>Timer</span>
      <span data-timer-elapsed>—</span>
    </button>
    <!--
      Masking is a display state, not a permission: the figures still arrive and
      the screens still total them, and this decides whether they are drawn. It
      renders pressed-out because shown is the default, and the browser sets it
      from storage before the first paint.
    -->
    <button class="money-toggle" type="button" data-money-toggle data-auth-action disabled aria-pressed="false" aria-label="Hide money amounts ($)" title="Hide money amounts ($)"><span aria-hidden="true">$</span></button>
    <button class="command-trigger" type="button" data-command-trigger data-auth-action disabled aria-haspopup="dialog" aria-label="Search and commands (⌘K)">${iconMarkup('magnifier')}<span aria-hidden="true">⌘K</span></button>
    <button class="menu-trigger" type="button" data-menu-trigger aria-label="Open navigation" aria-haspopup="dialog">Menu</button>
    <div class="account" data-auth-shell data-state="loading">
      <div class="account-identity" data-current-identity hidden>
        <svg class="identity-avatar" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="8.5" r="3.25"/><path d="M5.75 19a6.25 6.25 0 0 1 12.5 0"/></svg>
        <span class="identity-text">
          <span class="visually-hidden">Signed in as </span><span class="identity-name" data-current-profile>—</span>
          <span class="identity-meta">User #<span data-current-user-id>—</span></span>
        </span>
        <a class="identity-settings" href="/settings/user" data-settings-link>Settings</a>
        <button type="button" class="identity-signout" data-logout>Sign out</button>
        <p class="auth-result visually-hidden" data-logout-result role="status" aria-live="polite"></p>
      </div>
    </div>
  </header>
  ${renderTabStrip(options)}
  <main class="app-content page--grid" data-app-content${view === 'time' ? '' : ' hidden'}>
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
        <!--
          The mount point for the shared period control, which replaces the
          hand-rolled week stepper that stood here: the "Monday–Sunday" eyebrow
          (static text, and a lie on an organization whose week starts on
          Saturday), the "Week of …" label, and the two chevrons either side of
          the "This week" button. The control is week-only here because the grid
          below draws seven day columns and a month is not seven of anything.

          The heading stays as the section's accessible name. It is hidden
          because the control immediately below it says the same thing in a form
          the reader can also operate, and naming the week twice on one row is
          the noise §6 asks screens to stop making.
        -->
        <div class="week-period" data-week-period>
          <h2 class="visually-hidden" id="week-heading">Timesheet week</h2>
        </div>
        <div class="week-actions">
          <button type="button" data-week-current data-auth-action disabled>${iconMarkup('calendar')}This week</button>
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
          <button type="button" data-unsubmit-timesheet data-auth-action hidden disabled>Unsubmit week</button>
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
      <section class="calendar-week" data-calendar-week aria-label="Calendar">
        <p class="form-result" data-calendar-status role="status" aria-live="polite">Loading calendar…</p>
        <div data-calendar-grid></div>
      </section>
      <div class="day-list" data-day-list data-view="phone">
        <header class="day-switcher">
          <button type="button" data-day-previous data-auth-action disabled aria-label="Previous day">${iconMarkup('chevron', { direction: 'left' })}</button>
          <strong data-day-label>—</strong>
          <button type="button" data-day-next data-auth-action disabled aria-label="Next day">${iconMarkup('chevron')}</button>
        </header>
        <div data-day-rows><p class="day-empty">Loading time entries…</p></div>
      </div>
    </section>
  </main>
  <main class="app-content timesheet-approvals page--grid" data-timesheet-approvals-page${view === 'timesheet-approvals' ? '' : ' hidden'}>
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
  <main class="app-content invoice-workspace page--grid" data-invoice-list-page${view === 'invoice-list' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Money</p><h1>Invoices</h1></div>
      <a class="primary-action invoice-create-link" href="/invoices/new">Generate invoice</a>
    </header>
    <p class="invoice-intro">Browse generated and imported invoices. Amounts are shown in each invoice's own currency.</p>
    <div class="invoice-list-toolbar">
      <fieldset aria-label="Invoice state">
        <legend class="visually-hidden">Invoice state</legend>
        <button type="button" data-invoice-filter="outstanding" aria-pressed="true">Outstanding</button>
        <button type="button" data-invoice-filter="paid" aria-pressed="false">Paid</button>
        <button type="button" data-invoice-filter="closed" aria-pressed="false">Closed</button>
        <button type="button" data-invoice-filter="all" aria-pressed="false">All</button>
      </fieldset>
      <label for="ez-invoice-search">Search by invoice number or client
        <input id="ez-invoice-search" type="search" data-invoice-search autocomplete="off" placeholder="INV-1024 or client">
      </label>
    </div>
    <p class="form-result invoice-page-status" data-invoice-list-status role="status" aria-live="polite">Loading invoices…</p>
    <section class="invoice-list" data-invoice-list aria-label="Invoices"></section>
    <button class="invoice-load-more" type="button" data-invoice-load-more hidden>Load more invoices</button>
  </main>
  <main class="app-content invoice-workspace page--grid" data-invoice-detail-page${view === 'invoice-detail' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Invoices</p><h1>Invoice detail</h1></div>
      <a href="/invoices">Back to invoices</a>
    </header>
    <p class="form-result invoice-page-status" data-invoice-detail-status role="status" aria-live="polite">Loading invoice…</p>
    <button class="invoice-load-more" type="button" data-invoice-detail-retry hidden>Retry invoice</button>
    <article class="invoice-document" data-invoice-document data-document-shell data-ez-theme="${defaultTheme}" hidden>
      <header class="invoice-document-heading">
        <div>
          <p class="eyebrow">Invoice</p>
          <h2 data-invoice-detail-number>—</h2>
          <p data-invoice-detail-subject hidden></p>
        </div>
        <div class="invoice-document-actions"><strong class="invoice-state" data-invoice-detail-state>—</strong><button type="button" data-invoice-print>Print</button><button type="button" data-invoice-edit disabled hidden>Edit invoice</button><button type="button" data-invoice-send disabled hidden>Send invoice</button>${renderInvoiceOverflowMenu()}</div>
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
        <div><dt>Discount</dt><dd class="money" data-invoice-detail-discount>—</dd></div>
        <div><dt>Tax</dt><dd class="money" data-invoice-detail-tax>—</dd></div>
        <div><dt>Total</dt><dd class="money" data-invoice-detail-total>—</dd></div>
        <div><dt>Amount due</dt><dd class="money" data-invoice-detail-due>—</dd></div>
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
  <main class="app-content invoice-generation page--document" data-invoice-generation-page${view === 'invoice-generation' ? '' : ' hidden'}>
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
        <!--
          The mount point for the shared period control, which replaces the bare
          From/To pair that stood here. Empty in the served HTML because the
          control is DOM the way data-table is DOM: one implementation, built
          once, rather than a string copy in this renderer to keep in step with
          the browser one. It takes the fieldset's own date fields, so no band is
          added to §6's budget of three between the tab strip and the first data
          row.
        -->
        <div class="invoice-period" data-invoice-period></div>
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
  ${renderRecurringPage(view)}
  ${renderRetainerPage(view)}
  ${renderEmailConfigPage(view)}
  ${renderClientDirectoryPages(view)}
  ${renderTeamPages(view)}
  ${renderProjectDirectoryPages(view)}
  ${renderTaskAdminPage(view)}
  ${renderDashboardPage(view)}
  ${renderReportsPage(view)}
  ${renderExpenseWorkflowPages(view)}
  ${renderExpenseCategoriesPage(view)}
  ${renderModuleSettingsPage(view)}
  ${renderActivityLogPage(view)}
  ${renderRoleAdminPage(view)}
  ${renderNotFoundPage(view)}
  ${renderInvoiceComposerDialog()}
  ${renderInvoiceEditDialog()}
  ${renderInvoiceLineDialogs()}
  ${renderInvoicePaymentDialogs()}
  ${renderInvoiceTransitionDialog()}
  ${renderRetainerDialogs()}
  <dialog class="command-dialog" data-command-dialog aria-labelledby="command-title">
    <form data-command-form>
      <header><div><p class="eyebrow">Command bar</p><h2 id="command-title">Go or log time</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
      <label for="ez-command">Command</label>
      <input id="ez-command" name="command" autocomplete="off" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="ez-command-results" placeholder="Search, or log 2h northpeak devops" required>
      <p class="hint">Type to find a destination; ↑↓ to choose, Enter to go. Or “log 2h project task”. Esc to close.</p>
      <div class="command-results" id="ez-command-results" data-command-results role="listbox" aria-label="Destinations"></div>
      <p class="form-result" data-command-result role="status"></p>
      <button class="primary-action" type="submit">Run command</button>
    </form>
  </dialog>
  <dialog class="entry-dialog" data-entry-dialog data-timer-dialog data-note-dialog aria-labelledby="entry-title">
    <form data-timer-form novalidate data-entry-form data-note-form>
      <header><div><p class="eyebrow" data-entry-context>Time entry</p><h2 id="entry-title" data-entry-title data-note-title>Log time</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
      <div class="entry-assignment">
        <label>Project<select name="project" data-entry-project data-entry-project-options required></select></label>
        <label>Task<select name="task" data-entry-task data-entry-task-options required></select></label>
      </div>
      <label>Date<input name="spent_date" data-entry-date type="date" required></label>
      <label data-entry-duration>Duration<input name="duration" data-entry-duration-input inputmode="decimal" autocomplete="off"></label>
      <div class="entry-times" data-entry-times hidden>
        <label>Start<input name="started_time" data-entry-start autocomplete="off" placeholder="9:00 AM"></label>
        <label>End<input name="ended_time" data-entry-end autocomplete="off" placeholder="5:00 PM"></label>
      </div>
      <p class="hint" data-entry-running hidden>This entry is running. Stop it before changing its assignment or timing.</p>
      <label for="ez-entry-note">Note<textarea id="ez-entry-note" name="notes" data-entry-note-input data-timer-note data-note-input rows="5" maxlength="10000" aria-describedby="note-hint note-result"></textarea></label>
      <p class="hint" id="note-hint" data-entry-note-hint data-timer-note-hint data-note-hint>Optional. Up to 10,000 characters.</p>
      <p class="form-result" id="note-result" data-entry-result data-timer-result data-note-result role="status"></p>
      <div class="timer-actions"><button class="primary-action" type="submit" data-entry-submit>Save entry</button><button type="button" data-stop-timer hidden>Stop running timer</button><button type="button" class="danger-action" data-entry-delete hidden>Delete entry</button></div>
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
