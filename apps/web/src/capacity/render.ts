import { iconMarkup } from '../components/icons.js'

/**
 * The capacity screen (issue 1007, slice 2): planned hours against capacity and
 * tracked time, person by week. The page itself carries no control; the
 * controller gives an administrator the entry section below.
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
    <div data-capacity-placeholders hidden></div>
    <div data-capacity-planning hidden></div>
  </main>
`

/** The administrator's entry forms and the rows they change (issue 1007). */
export const renderPlanningSection = (): string => `
  <section class="capacity-planning" aria-label="Plan entry">
    <h2>Allocations</h2>
    <form class="capacity-form" data-planning-allocation-form novalidate>
      <input type="hidden" name="id">
      <label>Person <select name="user_id" required></select></label>
      <label>Project <select name="project_id" required></select></label>
      <label>From <input type="date" name="start_date" required></label>
      <label>To <input type="date" name="end_date" required></label>
      <label>Hours per week <input type="text" inputmode="decimal" name="hours" required></label>
      <button type="submit" data-planning-allocation-save>Add allocation</button>
      <button type="button" data-planning-allocation-cancel hidden>Cancel edit</button>
    </form>
    <p class="form-result" data-planning-allocation-status role="status" aria-live="polite"></p>
    <div data-planning-allocations></div>
    <h2>Time off</h2>
    <form class="capacity-form" data-planning-timeoff-form novalidate>
      <input type="hidden" name="id">
      <label>Person <select name="user_id" required></select></label>
      <label>Kind <select name="kind" required>
        <option value="vacation">Vacation</option>
        <option value="sick">Sick</option>
        <option value="holiday">Holiday</option>
        <option value="other">Other</option>
      </select></label>
      <label>From <input type="date" name="start_date" required></label>
      <label>To <input type="date" name="end_date" required></label>
      <label>Hours per day (blank for whole days) <input type="text" inputmode="decimal" name="hours"></label>
      <button type="submit" data-planning-timeoff-save>Add time off</button>
      <button type="button" data-planning-timeoff-cancel hidden>Cancel edit</button>
    </form>
    <p class="form-result" data-planning-timeoff-status role="status" aria-live="polite"></p>
    <div data-planning-timeoff></div>
    <section data-organization-holidays hidden aria-labelledby="organization-holidays-title">
      <h2 id="organization-holidays-title">Organization holidays</h2>
      <p>Whole days unavailable for everyone. Weekdays reduce each person's capacity by one fifth of their weekly hours; weekends leave capacity unchanged. Personal leave on the same date is counted once. These dates do not change tracked time.</p>
      <form class="capacity-form" data-holiday-form>
        <label>Holiday date<input name="date" type="date" required></label>
        <label>Holiday name<input name="name" required maxlength="120" autocomplete="off"></label>
        <button type="submit" data-holiday-save>Add holiday</button><button type="button" data-holiday-cancel hidden>Cancel holiday edit</button>
      </form>
      <p class="form-result" data-holiday-status role="status" aria-live="polite"></p>
      <div data-holiday-table></div>
      <dialog class="settings-token-dialog" data-holiday-delete-dialog aria-labelledby="holiday-delete-title">
        <form class="settings-form" data-holiday-delete-form><h3 id="holiday-delete-title">Remove organization holiday</h3>
          <p data-holiday-delete-description></p><p>Capacity will be recalculated for everyone. Personal leave stays in place.</p>
          <div class="dialog-actions"><button type="button" data-holiday-delete-cancel>Cancel</button><button type="submit">Remove holiday</button></div>
        </form>
      </dialog>
    </section>
  </section>
`
