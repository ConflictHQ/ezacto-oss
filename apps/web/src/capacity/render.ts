import { iconMarkup } from '../components/icons.js'

/**
 * The capacity screen (issue 1007, slice 2): planned hours against capacity and
 * tracked time, person by week. Read-only by design; there is no control here
 * that changes a plan.
 */
export const renderCapacityPage = (view?: string): string => `
  <main class="app-content capacity-workspace page--grid" data-capacity-page${view === 'capacity' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Team</p><h1>Capacity</h1></div>
    </header>
    <p class="capacity-intro">Planned hours against what each person can do in a week, with the time actually tracked beside it. A plan is not work and is never billed; a week planned beyond capacity is flagged, not blocked.</p>
    <section class="team-period" aria-label="Weeks shown">
      <button type="button" data-capacity-previous aria-label="Earlier weeks">${iconMarkup('chevron', { direction: 'left' })}</button>
      <strong data-capacity-label>—</strong>
      <button type="button" data-capacity-next aria-label="Later weeks">${iconMarkup('chevron')}</button>
      <button type="button" data-capacity-current>${iconMarkup('calendar')}This week</button>
    </section>
    <p class="form-result capacity-status" data-capacity-status role="status" aria-live="polite">Loading capacity…</p>
    <div class="capacity-grid" data-capacity-grid></div>
    <button type="button" data-capacity-retry hidden>Retry loading capacity</button>
  </main>
`
