/**
 * A log read a page at a time, whose place lives in the address (issue 929).
 *
 * The email log, the event deliveries and the backup runs are histories that
 * only grow. They used to load the newest 200 rows and stop, which is the
 * wrong place to be silent: an operator looking for last month's failure was
 * told nothing when it fell off the end. They now page by the server's signed
 * cursor, and each table's filters, page size, order and cursor sit in the
 * address under the table's own prefix (`email_status=failed&email_cursor=...`)
 * so a page can be linked, reloaded and walked back through with the browser's
 * Back button.
 *
 * The cursor is the server's and is opaque here. "Older" follows it. "Newer"
 * is only ever a place this visit has been, which is why a link that opens deep
 * in a log offers a way back to its newest page rather than a Newer that would
 * need a cursor nobody has.
 */

export const LOG_PAGE_SIZES = [25, 50, 100, 200] as const
export const DEFAULT_LOG_PAGE_SIZE = 50

export type LogOrder = 'newest' | 'oldest'

/** One table's place in a log, as the address carries it. */
export interface LogAddress {
  readonly filters: Readonly<Record<string, string>>
  readonly perPage: number
  readonly order: LogOrder
  readonly cursor: string | null
  /**
   * How many rows come before this page. Only for the "Rows 51–100" label: the
   * server's cursor is what finds the page, so a hand-edited offset can make
   * the label wrong and nothing else.
   */
  readonly offset: number
}

export interface LogPageResult<Row> {
  readonly data: readonly Row[]
  readonly links: { readonly next: string | null }
  readonly page: {
    readonly per_page: number
    readonly next_cursor: string | null
    readonly total: number
  }
}

/** Filters are short, so a long value in an address is not one this wrote. */
const maximumFilterLength = 200
const maximumCursorLength = 4_096

const sizeFrom = (raw: string | null): number => {
  const size = Number(raw)
  return (LOG_PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_LOG_PAGE_SIZE
}

export const readLogAddress = (
  params: URLSearchParams,
  prefix: string,
  filterKeys: readonly string[],
): LogAddress => {
  const filters: Record<string, string> = {}
  for (const key of filterKeys) {
    const value = params.get(`${prefix}_${key}`)
    if (value !== null && value !== '' && value.length <= maximumFilterLength) filters[key] = value
  }
  const cursor = params.get(`${prefix}_cursor`)
  const offset = Number(params.get(`${prefix}_offset`))
  return {
    filters,
    perPage: sizeFrom(params.get(`${prefix}_per_page`)),
    order: params.get(`${prefix}_order`) === 'oldest' ? 'oldest' : 'newest',
    cursor: cursor !== null && cursor !== '' && cursor.length <= maximumCursorLength ? cursor : null,
    offset: Number.isSafeInteger(offset) && offset > 0 ? offset : 0,
  }
}

/**
 * Writes one table's place into an address, leaving every other table's alone.
 * What equals the default is left out, so an untouched log has a clean address.
 */
export const writeLogAddress = (
  params: URLSearchParams,
  prefix: string,
  filterKeys: readonly string[],
  address: LogAddress,
): void => {
  for (const key of [...filterKeys, 'per_page', 'order', 'cursor', 'offset']) {
    params.delete(`${prefix}_${key}`)
  }
  for (const key of filterKeys) {
    const value = address.filters[key]
    if (value !== undefined && value !== '') params.set(`${prefix}_${key}`, value)
  }
  if (address.perPage !== DEFAULT_LOG_PAGE_SIZE) params.set(`${prefix}_per_page`, String(address.perPage))
  if (address.order !== 'newest') params.set(`${prefix}_order`, address.order)
  if (address.cursor !== null) {
    params.set(`${prefix}_cursor`, address.cursor)
    if (address.offset > 0) params.set(`${prefix}_offset`, String(address.offset))
  }
}

/** "Rows 51–100 of 312", or "No rows" when the filters match nothing. */
export const rangeLabel = (offset: number, shown: number, total: number, noun: string): string => {
  if (shown === 0) return `No ${noun}`
  return `Rows ${String(offset + 1)}–${String(offset + shown)} of ${String(total)}`
}

export interface LogPagerOptions {
  readonly address: LogAddress
  readonly shown: number
  readonly total: number
  readonly nextCursor: string | null
  readonly noun: string
  readonly onPrevious: () => void
  readonly onNext: () => void
  readonly onPerPage: (size: number) => void
}

/**
 * Newer and Older buttons, a page-size control and the row count.
 *
 * Newer and Older mean what they say whichever way the log is ordered: read
 * newest first, Older is the next page; read oldest first, Newer is.
 */
export const renderLogPager = (options: LogPagerOptions): HTMLElement => {
  const nav = document.createElement('nav')
  nav.className = 'log-pager'
  nav.setAttribute('aria-label', `${options.noun} pages`)

  const count = document.createElement('p')
  count.className = 'log-pager-count'
  count.setAttribute('role', 'status')
  count.textContent = rangeLabel(options.address.offset, options.shown, options.total, options.noun)

  const newestFirst = options.address.order === 'newest'
  const button = (label: string, enabled: boolean, onSelect: () => void): HTMLButtonElement => {
    const control = document.createElement('button')
    control.type = 'button'
    control.className = 'log-pager-button'
    control.textContent = label
    control.disabled = !enabled
    control.addEventListener('click', onSelect)
    return control
  }
  const hasPrevious = options.address.cursor !== null
  const hasNext = options.nextCursor !== null
  const previous = button(newestFirst ? 'Newer' : 'Older', hasPrevious, options.onPrevious)
  const next = button(newestFirst ? 'Older' : 'Newer', hasNext, options.onNext)
  previous.dataset.logPrevious = ''
  next.dataset.logNext = ''

  const sizeLabel = document.createElement('label')
  sizeLabel.className = 'log-pager-size'
  sizeLabel.textContent = 'Rows per page '
  const size = document.createElement('select')
  size.dataset.logPerPage = ''
  for (const choice of LOG_PAGE_SIZES) {
    const option = document.createElement('option')
    option.value = String(choice)
    option.textContent = String(choice)
    option.selected = choice === options.address.perPage
    size.appendChild(option)
  }
  size.addEventListener('change', () => {
    options.onPerPage(sizeFrom(size.value))
  })
  sizeLabel.appendChild(size)

  nav.appendChild(count)
  nav.appendChild(previous)
  nav.appendChild(next)
  nav.appendChild(sizeLabel)
  return nav
}

export interface PagedLogOptions<Row> {
  /** Names the table's parameters in the address: `email` gives `email_status`. */
  readonly prefix: string
  readonly filterKeys: readonly string[]
  /** Holds the filter controls, each marked `data-log-filter="<key>"`. */
  readonly controls: HTMLElement
  /** Where the table and its pager are drawn. */
  readonly list: HTMLElement
  readonly status: HTMLElement
  /** What a row is, for the messages: "messages", "deliveries", "runs". */
  readonly noun: string
  readonly read: (
    address: LogAddress,
    signal: AbortSignal,
  ) => Promise<LogPageResult<Row>>
  /** Draws the rows. The pager is added below whatever this returns. */
  readonly draw: (rows: readonly Row[], address: LogAddress) => HTMLElement
  /** Said in place of the table when no row matches. */
  readonly empty: (filtered: boolean) => string
  /** A line under the filters about the rows on screen, such as how many failed. */
  readonly summary?: (rows: readonly Row[]) => string
  /** Said when the page could not be read; the table is not drawn as empty. */
  readonly failure: string
}

export interface PagedLog {
  /** Reads the address and loads the page it names. */
  load(signal: AbortSignal): Promise<void>
  /** Reads the page again, for a change to its rows that is not a new place. */
  reload(): Promise<void>
  /**
   * Moves to another place in the log, as a new entry in the browser's history.
   * Settles when the page has been read, so a caller can put focus back.
   */
  go(next: LogAddress): Promise<void>
  address(): LogAddress
}

const controlsOf = (controls: HTMLElement): HTMLInputElement[] =>
  [...controls.querySelectorAll('[data-log-filter]')] as unknown as HTMLInputElement[]

export const createPagedLog = <Row>(options: PagedLogOptions<Row>): PagedLog => {
  const { prefix, filterKeys } = options
  let address = readLogAddress(new URLSearchParams(globalThis.location.search), prefix, filterKeys)
  let signal: AbortSignal | null = null
  let generation = 0
  // The pages this visit has stepped past, so Newer is a place it has been.
  let stack: { cursor: string | null; offset: number }[] = []
  let lastRows: readonly Row[] | null = null
  let lastPage: LogPageResult<Row> | null = null

  const showControls = (): void => {
    for (const control of controlsOf(options.controls)) {
      control.value = address.filters[control.dataset['logFilter'] ?? ''] ?? ''
    }
  }

  const writeAddress = (next: LogAddress): void => {
    const params = new URLSearchParams(globalThis.location.search)
    writeLogAddress(params, prefix, filterKeys, next)
    const search = params.toString()
    globalThis.history.pushState(
      null,
      '',
      `${globalThis.location.pathname}${search === '' ? '' : `?${search}`}${globalThis.location.hash}`,
    )
  }

  const restartButton = (): HTMLButtonElement => {
    const restart = document.createElement('button')
    restart.type = 'button'
    restart.className = 'log-pager-button'
    restart.textContent = 'Back to the newest rows'
    restart.addEventListener('click', () => {
      void go({ ...address, cursor: null, offset: 0 })
    })
    return restart
  }

  const draw = (): void => {
    if (lastRows === null || lastPage === null) return
    const filtered = Object.keys(address.filters).length > 0
    if (lastRows.length === 0) {
      const message = document.createElement('p')
      message.className = 'log-empty'
      message.textContent = options.empty(filtered)
      options.list.replaceChildren(message)
      if (address.cursor !== null) options.list.appendChild(restartButton())
      options.status.textContent = ''
      return
    }
    const page = lastPage
    const rows = lastRows
    options.list.replaceChildren(
      options.draw(rows, address),
      renderLogPager({
        address,
        shown: rows.length,
        total: page.page.total,
        nextCursor: page.page.next_cursor,
        noun: options.noun,
        onPrevious: () => {
          const back = stack.pop()
          void go({ ...address, cursor: back?.cursor ?? null, offset: back?.offset ?? 0 }, true)
        },
        onNext: () => {
          if (page.page.next_cursor === null) return
          stack.push({ cursor: address.cursor, offset: address.offset })
          void go({ ...address, cursor: page.page.next_cursor, offset: address.offset + rows.length }, true)
        },
        onPerPage: (size) => {
          void go({ ...address, perPage: size, cursor: null, offset: 0 })
        },
      }),
    )
    options.status.textContent = options.summary?.(rows) ?? ''
  }

  const read = async (): Promise<void> => {
    const active = signal
    if (active === null) return
    const mine = ++generation
    options.status.textContent = `Loading ${options.noun}…`
    try {
      const result = await options.read(address, active)
      if (active.aborted || mine !== generation) return
      lastRows = result.data
      lastPage = result
      draw()
    } catch (error) {
      if (active.aborted || mine !== generation) return
      // This screen is what somebody reads when something has gone wrong, so a
      // failure to read it says so rather than drawing an empty table that
      // looks like nothing was ever there.
      lastRows = null
      lastPage = null
      options.list.replaceChildren()
      if (address.cursor !== null) options.list.appendChild(restartButton())
      options.status.textContent = error instanceof Error ? error.message : options.failure
    }
  }

  function go(next: LogAddress, keepStack = false): Promise<void> {
    if (!keepStack) stack = []
    address = next
    writeAddress(next)
    showControls()
    return read()
  }

  const readControls = (): void => {
    const filters: Record<string, string> = {}
    for (const control of controlsOf(options.controls)) {
      const value = control.value.trim()
      if (value !== '') filters[control.dataset['logFilter'] ?? ''] = value
    }
    void go({ ...address, filters, cursor: null, offset: 0 })
  }

  options.controls.addEventListener('change', (event) => {
    if ((event.target as Element | null)?.closest('[data-log-filter]') !== null) readControls()
  })
  options.controls.addEventListener('click', (event) => {
    if ((event.target as Element | null)?.closest('[data-log-clear]') === null) return
    void go({ ...address, filters: {}, cursor: null, offset: 0 })
  })

  return {
    async load(active) {
      // Back and Forward walk the pages: the address is the truth, so it is
      // read again rather than rebuilt from what this visit remembers.
      globalThis.addEventListener(
        'popstate',
        () => {
          address = readLogAddress(new URLSearchParams(globalThis.location.search), prefix, filterKeys)
          stack = []
          showControls()
          void read()
        },
        { signal: active },
      )
      signal = active
      address = readLogAddress(new URLSearchParams(globalThis.location.search), prefix, filterKeys)
      stack = []
      showControls()
      await read()
    },
    reload: read,
    go: (next) => go(next),
    address: () => address,
  }
}
