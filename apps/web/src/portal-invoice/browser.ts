/**
 * Tells the server that the invoice page was shown to a person (issue 936).
 *
 * A mail scanner fetches the page's address and reads the HTML; it does not
 * run this. A browser does, and only reports once the page is actually
 * visible, so a tab opened in the background or prerendered is not a view
 * until somebody switches to it.
 *
 * The report carries nothing: the address it posts to is the page's own, and
 * a failure is swallowed, because nobody reading their invoice should ever
 * see a receipt go wrong.
 */
export const reportInvoiceShown = (): void => {
  const path = window.location.pathname.replace(/\/+$/u, '')
  let sent = false
  const send = () => {
    if (sent || document.visibilityState !== 'visible') return
    sent = true
    void fetch(`${path}/viewed`, {
      method: 'POST',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      keepalive: true,
    }).catch(() => undefined)
  }
  send()
  document.addEventListener('visibilitychange', send)
}
