// Cutting the wire bytes of each record out of a response body, without going
// through JSON.parse first.
//
// migration-spec §2.3 is unambiguous — "one Harvest object per line, verbatim,
// unmodified", and "**Raw means raw.**" Re-serialising a parsed object does not
// meet that, and the ways it fails are not cosmetic:
//
//   {"id":9007199254740993}  ->  {"id":9007199254740992}   id changed value
//   {"hours":8.00}           ->  {"hours":8}               scale lost
//   {"rate":1e2}             ->  {"rate":100}              literal rewritten
//   {"x":0.1000000000000000055511151231257827} -> {"x":0.1} precision gone
//
// `time_entry.id` is a bigint (research §15.5), so the first line is a primary
// key silently changing. And §3's load rule — "money decimals … **fail loudly**
// on >2 decimal places, never round silently" — has to read the textual form,
// which is gone the moment the number becomes a JS double.
//
// The envelope still goes through JSON.parse: `links` and `total_entries` are
// read as values and none of the above applies to them. Only the records are cut
// from the source text.

/** A cursor over a JSON document that knows where strings start and end. */
interface Scan {
  readonly src: string
  pos: number
}

/** Advances past a string literal, respecting escapes. Assumes src[pos] === '"'. */
const skipString = (s: Scan): void => {
  s.pos += 1
  let escaped = false
  while (s.pos < s.src.length) {
    const c = s.src[s.pos]
    if (escaped) escaped = false
    else if (c === '\\') escaped = true
    else if (c === '"') {
      s.pos += 1
      return
    }
    s.pos += 1
  }
}

const isSpace = (c: string): boolean => c === ' ' || c === '\n' || c === '\r' || c === '\t'

const skipSpace = (s: Scan): void => {
  while (s.pos < s.src.length && isSpace(s.src[s.pos])) s.pos += 1
}

/** Reads the string literal at pos and returns its decoded-enough key text. */
const readKey = (s: Scan): string => {
  const from = s.pos + 1
  skipString(s)
  return s.src.slice(from, s.pos - 1)
}

/**
 * Finds `"key": [` at the top level of the document and returns the index of the
 * `[`, or -1. Depth-aware so a nested object carrying the same key — a record
 * with its own `links`, say — cannot be mistaken for the envelope's.
 */
const findCollection = (src: string, key: string): number => {
  const s: Scan = { src, pos: 0 }
  let depth = 0
  while (s.pos < src.length) {
    const c = src[s.pos]
    if (c === '"') {
      const atTop = depth === 1
      const text = readKey(s)
      if (atTop && text === key) {
        skipSpace(s)
        if (src[s.pos] !== ':') return -1
        s.pos += 1
        skipSpace(s)
        return src[s.pos] === '[' ? s.pos : -1
      }
      continue
    }
    if (c === '{' || c === '[') depth += 1
    else if (c === '}' || c === ']') depth -= 1
    s.pos += 1
  }
  return -1
}

/**
 * The exact source text of every element of `body[key]`, in order.
 *
 * Returns null when the shape is not what we expect — the caller then has a
 * decision to make and a reason to report, rather than a silently wrong file.
 */
export const sliceCollection = (src: string, key: string): string[] | null => {
  const open = findCollection(src, key)
  if (open < 0) return null

  const s: Scan = { src, pos: open + 1 }
  const out: string[] = []
  let depth = 0
  let start = -1

  while (s.pos < src.length) {
    const c = src[s.pos]

    if (c === '"') {
      if (start < 0) start = s.pos
      skipString(s)
      continue
    }
    if (c === '{' || c === '[') {
      if (start < 0) start = s.pos
      depth += 1
      s.pos += 1
      continue
    }
    if (c === '}' || c === ']') {
      if (depth === 0 && c === ']') {
        if (start >= 0) out.push(src.slice(start, s.pos).trim())
        return out
      }
      depth -= 1
      s.pos += 1
      continue
    }
    if (c === ',' && depth === 0) {
      if (start >= 0) {
        out.push(src.slice(start, s.pos).trim())
        start = -1
      }
      s.pos += 1
      continue
    }
    if (start < 0 && !isSpace(c)) start = s.pos
    s.pos += 1
  }
  return null // ran off the end: unterminated array
}

/**
 * Removes whitespace that sits *between* tokens, leaving every string literal and
 * every number literal byte-identical.
 *
 * Only reached when a server pretty-prints, because JSONL cannot hold a record
 * containing a raw newline. JSON forbids literal newlines inside strings (they
 * must be escaped), so nothing removed here can be part of a value — this is the
 * one normalisation the format forces, and `extract` records it as an anomaly
 * rather than doing it quietly.
 */
export const collapseBetweenTokens = (src: string): string => {
  const s: Scan = { src, pos: 0 }
  let out = ''
  while (s.pos < src.length) {
    const c = src[s.pos]
    if (c === '"') {
      const from = s.pos
      skipString(s)
      out += src.slice(from, s.pos)
      continue
    }
    if (!isSpace(c)) out += c
    s.pos += 1
  }
  return out
}

/** True when this slice cannot be written as one JSONL line as-is. */
export const spansLines = (slice: string): boolean => slice.includes('\n') || slice.includes('\r')
