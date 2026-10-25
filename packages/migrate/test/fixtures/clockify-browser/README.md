# Clockify Detailed CSV golden fixtures

These fixtures explicitly bind `clockify-detailed-browser@2` (including raw
source formula admission). They are invented, sanitized test input, not a captured live-provider
export or evidence that a Clockify connection exists. Reserved `.invalid`
addresses and URLs cannot identify a customer. No source API is contacted.

- `detailed-time.csv` is UTF-8 with a BOM, a quoted comma/multiline/Unicode note,
  12/24-hour clocks, second precision, an overnight entry, a duration/clock
  mismatch, omitted dimensions and excluded money/attachment/custom columns.
- `daylight-saving.csv` covers a gap and repeated-hour interpretation in the
  explicitly named exporter zone, without guessing an offset.
- `*.expected.json` records hand-reviewed physical record starts, exact source
  seconds and public diagnostic codes. Source duration is not a destination
  rounding preview; destination policy is reviewed by the import planner.
- `admission-cases.json` commits reproducible malformed inputs. `hex` represents
  invalid UTF-8; JSON escapes preserve a NUL without placing binary bytes in the
  repository. The repeated-field descriptor materializes the exact raw boundary.
  A formula in an ignored custom column must be rejected by the browser reader,
  while the existing CLI adapter keeps its historical behavior.

The HTML-shaped note is inert source text, not a DOM fixture. Parser tests prove
it is preserved literally and that no network call or evaluation occurs; browser
safe-text rendering is a separate UI check.
