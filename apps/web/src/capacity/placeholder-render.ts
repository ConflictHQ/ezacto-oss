export const renderPlaceholderPlanning = (): string => `
  <section class="capacity-planning placeholder-planning" aria-labelledby="placeholder-heading">
    <h2 id="placeholder-heading">Unassigned work</h2>
    <p>Project demand waiting for a person. These hours have no personal capacity, utilization, rate or tracked time.</p>
    <p class="data-table-scroll-hint">On smaller screens, scroll the planning tables horizontally to see all details and actions.</p>
    <p data-placeholder-status class="form-result" role="status" aria-live="polite"></p>
    <button type="button" data-placeholder-reload hidden>Reload saved planning</button>
    <div data-placeholder-totals></div>
    <div data-placeholder-rows></div>
    <div data-placeholder-administration hidden>
      <h3>Planning placeholders</h3>
      <form class="capacity-form" data-placeholder-definition-form>
        <label>Placeholder name<input name="name" required maxlength="120" autocomplete="off"></label>
        <button type="submit" data-placeholder-definition-save>Add placeholder</button>
        <button type="button" data-placeholder-definition-cancel hidden>Cancel name edit</button>
      </form>
      <div data-placeholder-definitions></div>
      <h3>Plan unassigned work</h3>
      <form class="capacity-form" data-placeholder-plan-form>
        <label>Placeholder<select name="placeholder_id" required></select></label>
        <label>Project<select name="project_id" required></select></label>
        <label>From<input name="start_date" type="date" required></label>
        <label>To<input name="end_date" type="date" required></label>
        <label>Hours per week<input name="hours" type="text" inputmode="decimal" required></label>
        <button type="submit" data-placeholder-plan-save>Add unassigned work</button>
        <button type="button" data-placeholder-plan-cancel hidden>Cancel plan edit</button>
      </form>
      <form class="capacity-form" data-placeholder-assign-form hidden>
        <h3>Assign unassigned work</h3>
        <p data-placeholder-assign-description></p>
        <label>Person<select name="user_id" required></select></label>
        <p>This creates a person allocation. Project access and staffing are managed separately; assigning this plan grants neither.</p>
        <button type="submit">Assign to person</button>
        <button type="button" data-placeholder-assign-cancel>Cancel assignment</button>
      </form>
      <dialog class="settings-token-dialog" data-placeholder-archive-dialog aria-labelledby="placeholder-archive-heading">
        <form class="settings-form" data-placeholder-archive-form>
          <h3 id="placeholder-archive-heading">Archive unassigned planning</h3>
          <p data-placeholder-archive-description></p>
          <p>Existing person allocations and tracked time stay in place. Archived demand can no longer be assigned.</p>
          <div class="dialog-actions"><button type="button" data-placeholder-archive-cancel>Cancel</button><button type="submit">Archive</button></div>
        </form>
      </dialog>
    </div>
  </section>
`;
