import { dashboardCards, type DashboardCard } from './model.js'

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )

/**
 * Every card ships hidden. The document is the same for every profile -- the
 * worker renders the shell before it knows who asked -- so a card is only put
 * on the page once the browser has read the gate its section already applies.
 */
const renderCard = (card: Readonly<DashboardCard>): string =>
  `<section class="dashboard-card" data-dashboard-card="${card.key}" aria-labelledby="ez-dashboard-${card.key}" hidden>` +
  `<h2 id="ez-dashboard-${card.key}">${escapeHtml(card.title)}</h2>` +
  `<strong class="dashboard-figure" data-dashboard-figure>—</strong>` +
  `<p class="dashboard-detail" data-dashboard-detail></p>` +
  `<ul class="dashboard-currencies" data-dashboard-currencies hidden></ul>` +
  `<p class="dashboard-note" data-dashboard-note hidden></p>` +
  `<a class="dashboard-card-link" href="${escapeHtml(card.href)}" data-dashboard-link>${escapeHtml(card.linkLabel)}</a>` +
  `</section>`

/**
 * The home screen. It answers "is anything wrong or waiting" and hands every
 * "what happened" question to the section that owns it -- Reports already
 * exists, and a second one would be worse than none.
 */
export const renderDashboardPage = (view?: string): string => `
  <main class="app-content dashboard-workspace page--grid" data-dashboard-page${view === 'dashboard' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Where things stand</p><h1>Home</h1></div>
      <a class="dashboard-week-link" href="/">Open this week</a>
    </header>
    <p class="form-result dashboard-status" data-dashboard-status role="status" aria-live="polite">Loading your dashboard…</p>
    <button type="button" data-dashboard-retry hidden>Retry</button>
    <div class="dashboard-cards" data-dashboard-cards>${dashboardCards.map(renderCard).join('')}</div>
  </main>`
