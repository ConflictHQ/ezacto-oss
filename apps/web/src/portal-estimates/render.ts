import { portalBrandHead, portalPaletteAttribute, portalWordmark, type PortalBrandChrome } from '../portal-brand.js'
import { defaultTheme } from '../theme.js'

/**
 * The page a contact of a client reads an estimate on and answers it (issue
 * 1010, slice 3).
 *
 * Standalone, like the Apple disconnect page: it shares the stylesheet and
 * nothing of the staff shell, because a contact has no staff session and the
 * shell's scripts would only ask them to sign in. Every value on it is filled in
 * by `browser.ts` from the portal routes, so the markup states nothing it has
 * not read.
 *
 * It sets no cookie of its own and loads no analytics. The sign-in token arrives
 * in the URL fragment and is removed from the address bar before anything else
 * happens; `no-referrer` keeps even the path from leaving.
 */

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )

export const renderPortalEstimatesPage = (options: {
  brand: string
  chrome?: PortalBrandChrome
}): string => `<!doctype html>
<html lang="en" data-ez-theme="${defaultTheme}" data-ez-scheme="light"${portalPaletteAttribute(options.chrome)}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="referrer" content="no-referrer">
  <title>Your estimates — ${escapeHtml(options.brand)}</title>
  <link rel="stylesheet" href="/assets/ezacto.css">
${portalBrandHead(options.chrome)}  <script type="module" src="/assets/portal-estimates.js"></script>
</head>
<body>
  <main class="portal-estimates" data-portal-estimates>
    <header class="portal-estimates-header">
      ${portalWordmark(options.chrome, options.brand)}
      <p class="eyebrow">${escapeHtml(options.brand)}</p>
      <h1 id="portal-estimates-heading" tabindex="-1" data-portal-heading>Your estimates</h1>
    </header>
    <p class="form-result" data-portal-status role="status" aria-live="polite">Loading…</p>
    <section data-portal-sign-in hidden aria-labelledby="portal-sign-in-heading">
      <h2 id="portal-sign-in-heading">Sign in to review your estimates</h2>
      <form data-portal-sign-in-form>
        <label for="portal-contact-email">Email address</label>
        <input id="portal-contact-email" data-portal-email type="email" autocomplete="email" maxlength="320" required>
        <button type="submit" data-portal-request-link>Send me a sign-in link</button>
      </form>
      <p>Use the email address your organization has on file. The link expires and can be used once.</p>
    </section>
    <section data-portal-list-view hidden aria-labelledby="portal-estimates-heading">
      <div data-portal-list></div>
    </section>
    <section data-portal-detail-view hidden aria-labelledby="portal-estimates-heading">
      <p><a href="?" data-portal-back>Back to your estimates</a></p>
      <dl class="recurring-facts" data-portal-facts></dl>
      <section aria-labelledby="portal-lines-heading">
        <h2 id="portal-lines-heading">What is quoted</h2>
        <div data-portal-lines></div>
        <dl class="portal-estimates-totals" data-portal-totals></dl>
      </section>
      <section data-portal-notes-section hidden aria-labelledby="portal-notes-heading">
        <h2 id="portal-notes-heading">Notes</h2>
        <p class="portal-estimates-notes" data-portal-notes></p>
      </section>
      <section aria-labelledby="portal-answer-heading">
        <h2 id="portal-answer-heading">Your answer</h2>
        <p data-portal-answer-line></p>
        <div class="portal-estimates-actions" data-portal-actions hidden>
          <button class="primary-action" type="button" data-portal-accept>Accept this estimate</button>
          <button type="button" data-portal-decline>Decline this estimate</button>
        </div>
        <div class="portal-estimates-confirm" data-portal-confirm hidden role="group" aria-labelledby="portal-confirm-text">
          <p id="portal-confirm-text" data-portal-confirm-text tabindex="-1"></p>
          <button class="primary-action" type="button" data-portal-confirm-yes>Confirm</button>
          <button type="button" data-portal-confirm-no>Cancel</button>
        </div>
      </section>
    </section>
  </main>
</body>
</html>`
