const escapeAttribute = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll("'", '&#39;')

type ConfirmationScheme = 'system' | 'light' | 'dim' | 'dark'

/** Match the web display-cookie parser: first exact name, raw value, closed preference. */
export const confirmationScheme = (cookie: string | undefined): ConfirmationScheme => {
  for (const part of (cookie ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== 'ezacto_scheme') continue
    const value = part.slice(separator + 1).trim()
    return value === 'light' || value === 'dim' || value === 'dark' ? value : 'system'
  }
  return 'system'
}

// compile-theme-tokens.mjs requires Precision as the only OSS/default theme.
// The native web audit compares this marker and effective ink to canonical web tokens.
export const magicLinkConfirmPage = (
  token: string, scheme: ConfirmationScheme,
  action: '/auth/magic-link/verify' | '/portal/verify',
): string =>
  `<!doctype html><html lang="en" data-ez-theme="precision" data-ez-scheme="${scheme}"><head><meta charset="utf-8">` +
  `<meta name="color-scheme" content="${scheme === 'system' ? 'light dark' : scheme === 'dim' ? 'dark' : scheme}">` +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta name="robots" content="noindex"><title>Finish signing in</title><link rel="stylesheet" href="/assets/ezacto.css"></head>' +
  '<body><main class="standalone-auth"><section class="auth-card"><h1>Finish signing in</h1>' +
  '<p>Confirm to sign in with this link. It works once.</p>' +
  `<form method="post" action="${action}">` +
  `<input type="hidden" name="token" value="${escapeAttribute(token)}">` +
  '<button class="primary-action" type="submit">Continue</button></form></section></main></body></html>'

