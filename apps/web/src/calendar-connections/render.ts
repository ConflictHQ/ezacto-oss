export const renderCalendarConnections = (): string => `
<section aria-labelledby="calendar-connections-heading" data-calendar-connections hidden>
  <h2 id="calendar-connections-heading">Connected calendars</h2>
  <p class="hint">Connect your Google or Microsoft calendar to suggest time entries. Review suggestions before adding them to your timesheet.</p>
  <p class="form-result" role="status" aria-live="polite" data-calendar-connections-status></p>
  <div data-calendar-connections-list></div>
  <button type="button" data-calendar-connections-reload>Refresh connections</button>
</section>`
