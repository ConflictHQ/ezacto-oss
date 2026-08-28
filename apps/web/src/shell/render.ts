import { shellJavascript, shellStylesheet } from '../generated/shell-assets.js'
import { themeManifest } from '../theme.js'

export interface AppShellOptions {
  readonly environment: string
  readonly release: string
  readonly brand?: string
  readonly activeSection?: 'Time' | 'Expenses' | 'Projects' | 'Clients' | 'Invoices' | 'Reports'
  readonly signInProviders?: readonly SignInProvider[]
}

export type SignInProvider = 'google'

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

export const renderDocumentShell = (title: string, content: string): string =>
  `<article class="document-shell" data-document-shell data-ez-theme="precision">` +
  `<header><a href="/">← Time</a><span>ezacto</span></header>` +
  `<main><h1>${escapeHtml(title)}</h1><div class="document-content">${escapeHtml(content)}</div>` +
  `</main></article>`

const sections = ['Time', 'Expenses', 'Projects', 'Clients', 'Invoices', 'Reports'] as const

const hrefFor = (section: (typeof sections)[number]): string =>
  section === 'Time' ? '/' : `/${section.toLocaleLowerCase('en-US')}`

const providerSignIn = (providers: readonly SignInProvider[]): string => {
  if (!providers.includes('google')) {
    return `<p class="oidc-unavailable" data-oidc-unavailable>Single sign-on is not available for this instance. Use your email and password.</p>`
  }
  return (
    `<div class="oidc-entry" data-oidc-entry>` +
    `<a class="oidc-sign-in" data-oidc-provider="google" href="${safePath('/auth/oidc/google')}">Continue with Google</a>` +
    `<span class="auth-divider" aria-hidden="true">or use your password</span>` +
    `</div>`
  )
}

export const renderAppShell = (options: AppShellOptions): string => {
  const active = options.activeSection ?? 'Time'
  const brand = options.brand ?? 'ezacto'
  const shortRelease = options.release.slice(0, 7)
  const navigation = sections
    .map(
      (section) =>
        `<a href="${hrefFor(section)}"${section === active ? ' aria-current="page"' : ''}>${section}</a>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en" data-ez-theme="precision">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="ezacto-environment" content="${escapeHtml(options.environment)}">
  <meta name="ezacto-release" content="${escapeHtml(options.release)}">
  <title>${escapeHtml(brand)} — Time</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="${escapeHtml(themeManifest.precision.fontStylesheet)}">
  <link rel="stylesheet" href="/assets/ezacto.css">
  <script type="module" src="/assets/ezacto.js"></script>
</head>
<body>
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
  </header>
  <nav class="tabstrip" aria-label="Time views">
    <a href="/" aria-current="page">Week</a><a href="/?view=day">Day</a><a href="/?view=calendar">Calendar</a>
  </nav>
  <main class="app-content" data-app-content>
    <header class="context-row">
      <div><p class="eyebrow">This week</p><h1>Time</h1></div>
      <button class="primary-action" type="button" data-command-trigger data-auth-action disabled>Log time</button>
    </header>
    <section class="auth-shell" data-auth-shell data-state="loading" aria-label="Account">
      <form class="sign-in-form" data-sign-in-form method="post" action="/auth/sign-in" hidden>
        <div class="auth-heading">
          <p class="eyebrow">Your ezacto account</p>
          <h2>Sign in to your week</h2>
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
      <div class="current-identity" data-current-identity hidden>
        <div>
          <p class="eyebrow">Signed in</p>
          <p class="identity-label"><strong>User #<span data-current-user-id>—</span></strong><span data-current-profile>—</span></p>
        </div>
        <button type="button" data-logout>Sign out</button>
        <p class="auth-result" data-logout-result role="status" aria-live="polite"></p>
      </div>
    </section>
    <aside class="session-status" data-session-status role="status">
      <span data-session-message>Connecting to your ezacto session…</span>
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
  <dialog class="timer-dialog" data-timer-dialog aria-labelledby="timer-title">
    <form data-timer-form>
      <header><div><p class="eyebrow">Global timer</p><h2 id="timer-title">Start a timer</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
      <label>Project<input name="project" autocomplete="off" required></label>
      <label>Task<input name="task" autocomplete="off" required></label>
      <p class="form-result" data-timer-result role="status"></p>
      <div class="timer-actions"><button class="primary-action" type="submit">Start timer</button><button type="button" data-stop-timer>Stop running timer</button></div>
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
  <dialog class="note-dialog" data-note-dialog aria-labelledby="note-title">
    <form data-note-form>
      <header><div><p class="eyebrow">Cell note</p><h2 id="note-title" data-note-title>Add a note</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
      <label>Note<textarea name="notes" data-note-input rows="5" maxlength="65535"></textarea></label>
      <p class="form-result" data-note-result role="status"></p>
      <button class="primary-action" type="submit">Save note</button>
    </form>
  </dialog>
  <noscript>${renderEmptyState('JavaScript is required', 'The ezacto app uses JavaScript to read and write your time safely.')}</noscript>
  <footer class="build-stamp">${escapeHtml(options.environment)} · ${escapeHtml(shortRelease)}</footer>
</body>
</html>`
}

export const webAssets = {
  stylesheet: shellStylesheet,
  javascript: shellJavascript,
} as const
