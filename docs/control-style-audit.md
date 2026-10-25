# Control style audit (#1260)

The reference for this pass is the shipped Precision tokens and the recorded
[design reference audit](design-reference-audit.md). The original supplied HTML
package was not recovered or re-inspected for this pass. This adds a regression
inventory to the existing design; it does not establish a new visual reference.

Run `npm run browser:prepare -w @ezacto/web`, then
`npm run controls:audit -w @ezacto/web -- --screenshots --output /tmp/ezacto-controls`.
The command starts the local Worker/D1 browser harness with synthetic owned
fixtures and accepts no remote server URL. `--record` records findings without
failing style checks; `--baseline` limits an exploratory scan to 390/light/sidebar.
Page identity assertions remain mandatory even in record mode.

Reports contain element types, classes, data-attribute **names**, computed style
and dimensions, never visible text, hrefs, input values or tokens. Authentication
traces remain disabled. Normal runs save a bounded set of synthetic screenshots;
`--screenshots` saves every probe. CI retains PNGs and metadata-only audit JSON as
`control-style-audit-<run>-<attempt>` for seven days. Link that genuine run artifact
from the PR for review. It contains no Playwright traces or error-context files.

[The work queue](control-style-work-queue.json) preserves baseline observations,
source findings, fixes and intentional exceptions. The initial heuristic found
native file-picker decoration and the magic confirmation button, but missed
partially reset standalone targets. Visual/source review expanded the queue to
portal secondary buttons/email and Apple checkbox/recovery controls. The final
exact-source four-case browser result is still required: earlier scans with an
incorrect focus target or a missing magic page are **not acceptance proof**.

The small detector tests prove default signatures, a themed counterexample,
file-picker decoration, compact standalone targets and privacy filtering without
mounting the shell. The browser guard rejects UA font/link/button/field/table
signatures, standalone buttons/text fields below 44px, and missing keyboard focus
rings. Hidden rendered controls are inspected by computed style/minimum height;
that is CSS inventory, not a claim of interaction coverage.

One parameterized browser file enumerates every current renderer view (33,
including not-found), all company/user settings sections, sign-in and standalone
controls. It asserts the native HTTP status and `html[data-app-view]` before each
shell probe, and the active settings pane or explicit unavailable-section marker.
Unavailable panes are labeled as hidden CSS inventory. The missing scheduled run
fixture exercises that view's error state, not a populated run. A manifest unit
test fails when the renderer view union changes. Four cases pair width 390/1280
with light/dark and sidebar/topbar so both palettes and navigation layouts are
exercised at each width.

Magic confirmation uses the real production GET handler through a GET-only
fixture delegate and an unissued format-valid token. Its status, heading, POST
form action, hidden token and single Continue button are asserted; nothing is
issued or redeemed. Its actual cookie-selected scheme, canonical theme marker
and effective ink are asserted without projecting a scheme onto the page. The
closed cookie parser follows the existing web first-match/raw-value behavior;
invalid preferences fall back to system. Portal estimates use native HTML/controller code with owned
read-only quote responses for coherent sign-in, list, detail and confirmation
states. Accept only opens confirmation; Cancel closes it, and a POST trap must
remain unused. Apple connected, recovery and success renderer states have separate
identity checks. The checkbox glyph must remain compact while its label is at
least 44px. Standalone invoice/document renderer probes use only owned data.
Their scripts are stripped to avoid activity; controls are not globally unhidden
for screenshots. Portal dark checks project the root scheme attribute to test
shared tokens, not production preference persistence. The document fragment gets
its host stylesheet. External font requests are blocked: computed font token
selection is tested, not downloaded font glyphs.

Staff invoice print-media inspection covers link/button CSS only; it is not an
issued document or print-layout certification. Binary PDF has no HTML control
cascade. Invoice email previews are subject/text, and built-in reminder HTML has
no links/buttons. Custom HTML is edited as text in the audited settings editor,
not rendered as a web preview. Native portal refusals are plain text/JSON, and
the shell not-found view is audited. These are explicit scope dispositions.

The shared file-selector rule removes native Arial/outset decoration while
keeping its existing 44px parent input target. Scoped shared standalone rules
supply 44px secondary buttons/text fields without enlarging calendar entries or
native checkbox glyphs. Ordinary inline text links keep the token link color;
blue appearance alone is not a default-style defect. Shared underline/hover/
visited rules have zero selector specificity so explicit navigation, wordmark
and primary-action styling wins. Magic confirmation uses the shipped stylesheet,
auth card and primary action; POST/token/one-use behavior is unchanged. These
checks are bounded regression evidence, not universal layout, screen-reader or
provider acceptance.
