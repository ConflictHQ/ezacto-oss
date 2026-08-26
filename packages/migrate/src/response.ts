// Shared vocabulary for describing a Harvest response that is not the shape we
// expected. Only the *description* is shared: `auth` refuses to write a manifest
// from a bad preflight, `extract` refuses to silently stop paginating — those are
// different consequences and each module states its own, so the reader of an error
// learns what actually failed rather than a generic "bad response".

/** How a value reads in an error message: "missing", "null", "an array", "a string". */
export const describe = (value: unknown): string => {
  if (value === undefined) return 'missing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}
