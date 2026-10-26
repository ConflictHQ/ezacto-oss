# Harvest shim corpus

`snapshot-*.input.json` and `.golden.json` are **synthetic derivatives of recorded
Harvest objects**, not raw responses. Personal/contact text, identifiers, dates,
commercial rates, amounts and duration magnitudes are replaced. Representation
classes, nulls, booleans and known enums remain. The expected golden is an
independent projection of the redacted source, never the shim's own output.

| Family | Snapshot-derived pairs | Existing invented pairs |
| --- | ---: | ---: |
| clients | 30 | 3 |
| projects | 78 | 3 |
| tasks | 21 | 3 |
| users | 60 | 3 |
| time_entries | 20 | 9 |
| expenses | 8 | 4 |
| project_assignments | 0 | 3 |
| Total | 217 | 28 |

Time-entry selection covers distinct representation/state classes rather than
only the first page. Source/projection provenance is in
[the evidence record](../../../../../docs/evidence/16-harvest-corpus-provenance.json).
The tests enforce at least 200 snapshot-derived objects, exact recorded counts,
byte comparisons and the synthetic-string allowlist.

The original eight-family requirement in #16 is **not fulfilled**. Invoices are
not served yet, and the private snapshot contains no recorded
`/users/:id/project_assignments` response. Existing assignment examples remain
explicitly invented; nothing is labeled as a recorded endpoint response.
Unsupported source fields are omitted, so these are comparisons of the covered
subset, not full raw-response byte equivalence.

To prepare a new private candidate, from the repository root:

```sh
node scripts/harvest-shim-corpus.mjs /absolute/private/snapshot /absolute/new/private-output
```

The output must not exist and must remain outside the source snapshot, including
through symlinks. The generator emits no raw values in diagnostics and refuses
unknown enum/string representations. Review the candidate and provenance before
copying synthetic pairs into this directory; never add the source snapshot,
credentials or raw responses to git.
