import { shellJavascript, shellStylesheet } from '../generated/shell-assets.js'
import { themeManifest } from '../theme.js'

export interface AppShellOptions {
  readonly environment: string
  readonly release: string
  readonly brand?: string
  readonly activeSection?:
    'Time' | 'Expenses' | 'Projects' | 'Clients' | 'Invoices' | 'Reports'
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
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ]!,
  )

const safePath = (value: string): string => {
  if (!value.startsWith('/') || value.startsWith('//')) {
    throw new Error('deep links must be same-origin absolute paths')
  }
  return value
}

export const renderDataQualityBanner = (
  options: DataQualityBannerOptions,
): string =>
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

const sections = [
  'Time',
  'Expenses',
  'Projects',
  'Clients',
  'Invoices',
  'Reports',
] as const

const hrefFor = (section: (typeof sections)[number]): string =>
  section === 'Time' ? '/' : `/${section.toLocaleLowerCase('en-US')}`

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
    <button class="timer-chip" type="button" data-timer-chip data-state="loading" aria-haspopup="dialog">
      <span class="live-dot" aria-hidden="true"></span>
      <span data-timer-label>Timer</span>
      <span data-timer-elapsed>—</span>
    </button>
    <button class="command-trigger" type="button" data-command-trigger aria-haspopup="dialog">⌘K</button>
    <button class="menu-trigger" type="button" data-menu-trigger aria-label="Open navigation" aria-haspopup="dialog">Menu</button>
  </header>
  <nav class="tabstrip" aria-label="Time views">
    <a href="/" aria-current="page">Week</a><a href="/?view=day">Day</a><a href="/?view=calendar">Calendar</a>
  </nav>
  <main class="app-content" data-app-content>
    <header class="context-row">
      <div><p class="eyebrow">This week</p><h1>Time</h1></div>
      <button class="primary-action" type="button" data-command-trigger>Log time</button>
    </header>
    <aside class="session-status" data-session-status role="status">Connecting to your ezacto session…</aside>
    <section class="week-surface" aria-labelledby="week-heading">
      <header><h2 id="week-heading">Week entries</h2><span data-week-total>—</span></header>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Project</th><th>Task</th><th>Date</th><th>Hours</th><th>Status</th></tr></thead>
          <tbody data-entry-rows><tr><td colspan="5">Loading time entries…</td></tr></tbody>
        </table>
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
  <noscript>${renderEmptyState('JavaScript is required', 'The ezacto app uses JavaScript to read and write your time safely.')}</noscript>
  <footer class="build-stamp">${escapeHtml(options.environment)} · ${escapeHtml(shortRelease)}</footer>
</body>
</html>`
}

export const webAssets = {
  stylesheet: shellStylesheet,
  javascript: shellJavascript,
} as const
