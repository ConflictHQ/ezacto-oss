/**
 * Notifications: what happened that concerns you, newest first (the ezacto-ui
 * Notifications panel). The bell at the end of the breadcrumb row leads here
 * and carries the count of what you have not seen.
 *
 * The page is a frame for the browser code to fill. Which sources a person may
 * read depends on who they are -- decisions on your own weeks for everyone,
 * the review queue for a reviewer, the activity log for an administrator --
 * and the server does not know that when it renders the shell.
 */
export const renderNotificationsPage = (view?: string): string => `
  <main class="app-content notifications-page page--grid" data-notifications-page${view === 'notifications' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">For you</p><h1>Notifications</h1></div>
      <button class="notif-mark-read" type="button" data-notifications-mark-read hidden>Mark all as read</button>
    </header>
    <p class="notifications-status" data-notifications-status role="status" aria-live="polite">Loading notifications…</p>
    <div class="notif-list" data-notifications-list></div>
  </main>
`
