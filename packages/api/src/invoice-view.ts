import type { Context, Hono } from 'hono'
import type { ApiContext } from './context.js'

/**
 * The hosted invoice page a client reaches from the link in an emailed invoice
 * (issue 936).
 *
 * The first public, unauthenticated invoice surface, so the token is treated as
 * the bearer secret it is:
 *
 * - every refusal is one plain 404, whatever the reason -- never issued,
 *   malformed, expired, or an invoice no longer viewable -- so nothing here can
 *   be used to enumerate links or learn which of those it was;
 * - a caller over its per-minute allowance gets 429 before the token is looked
 *   at, so guessing costs the guesser and not the database;
 * - the token is never logged, never echoed in an error and never sent
 *   anywhere: the page's responses say `no-referrer` and `no-store`;
 * - fetching the page records nothing. Only the page's own report that it was
 *   shown, or a download of the document, is a view.
 */

/** What the routes need of the store behind them; the database package builds it. */
export interface InvoiceViewRouteService<Page> {
  allow(clientKey: string, now: string): Promise<boolean>
  open(token: string, now: string): Promise<Page | null>
  shown(token: string, now: string): Promise<boolean>
  download(token: string, now: string): Promise<{ filename: string; bytes: Uint8Array } | null>
}

export interface InvoiceViewRouteOptions<Page, Bindings = unknown> {
  readonly service: InvoiceViewRouteService<Page>
  readonly clock: () => string
  /** Who is asking, for the allowance; never stored as given. */
  readonly clientKey: (request: Request) => string
  readonly render: (page: Page, token: string, bindings: Bindings) => string | Promise<string>
  /** Headers the HTML page is served with (its content security policy among them). */
  readonly pageHeaders: Readonly<Record<string, string>>
}

const privateHeaders = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
} as const

/** The one answer to every token that opens nothing. */
const notFound = (): Response =>
  new Response('Not found', {
    status: 404,
    headers: { ...privateHeaders, 'content-type': 'text/plain; charset=utf-8' },
  })

const tooManyRequests = (): Response =>
  new Response('Too many requests', {
    status: 429,
    headers: {
      ...privateHeaders,
      'content-type': 'text/plain; charset=utf-8',
      'retry-after': '60',
    },
  })

/** A filename that survives a header: printable ASCII, no quotes or separators. */
const headerFilename = (filename: string): string =>
  filename.replace(/[^\x20-\x7e]|["\\/]/gu, '_')

export const installInvoiceViewRoutes = <Bindings extends object, Page>(
  api: Hono<ApiContext<Bindings>>,
  options: InvoiceViewRouteOptions<Page, Bindings>,
): void => {
  /** The token, once the caller is within its allowance. */
  const admitted = async (
    context: Context<ApiContext<Bindings>>,
    now: string,
  ): Promise<{ token: string } | Response> => {
    if (!(await options.service.allow(options.clientKey(context.req.raw), now))) {
      return tooManyRequests()
    }
    return { token: context.req.param('token') ?? '' }
  }

  api.get('/portal/invoices/:token', async (context) => {
    const now = options.clock()
    const admission = await admitted(context, now)
    if (admission instanceof Response) return admission
    const page = await options.service.open(admission.token, now)
    if (page === null) return notFound()
    return new Response(await options.render(page, admission.token, context.env), {
      status: 200,
      headers: {
        ...privateHeaders,
        ...options.pageHeaders,
        'content-type': 'text/html; charset=utf-8',
      },
    })
  })

  api.post('/portal/invoices/:token/viewed', async (context) => {
    const now = options.clock()
    const admission = await admitted(context, now)
    if (admission instanceof Response) return admission
    return (await options.service.shown(admission.token, now))
      ? new Response(null, { status: 204, headers: privateHeaders })
      : notFound()
  })

  api.get('/portal/invoices/:token/document', async (context) => {
    const now = options.clock()
    const admission = await admitted(context, now)
    if (admission instanceof Response) return admission
    const document = await options.service.download(admission.token, now)
    if (document === null) return notFound()
    return new Response(document.bytes as BodyInit, {
      status: 200,
      headers: {
        ...privateHeaders,
        'content-type': 'application/pdf',
        'content-length': String(document.bytes.byteLength),
        'content-disposition': `attachment; filename="${headerFilename(document.filename)}"`,
      },
    })
  })
}
