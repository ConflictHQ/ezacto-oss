# Instance theme

An instance can wear its own colours. Settings → Appearance, administrator only.
Change nothing and it looks the way it shipped.

## What it is

The shell draws everything from a set of named colour tokens — `ground`, `ink`,
`action` and so on — published as CSS custom properties (`--ez-ground`). The
built-in palette is compiled into the stylesheet at build time. An instance
palette is a stored override of any of those tokens, served as a second
stylesheet that loads after the first.

That is the whole mechanism, and the load order is the point: both write custom
properties on `:root` at equal specificity, so the later one wins.

Nothing is per-user. This is how the instance looks to everybody who signs in.

## Setting it

Settings → Appearance offers a swatch and a hex box per token. Type or paste a
value; leave a box empty and that token keeps its built-in colour. **Save
colours** stores the palette, **Undo my changes** discards what you have typed
since the last save, and **Back to the built-in theme** removes the palette
entirely.

A saved palette applies on the next page load.

Two tokens are declared but spend nothing in the stylesheet, so they are not
offered — see issue 437, which is the open question of what they are for.

## Light, dim and dark

The built-in theme has three schemes -- light, a dim slate, and dark -- and
each person picks System, Light, Dim or Dark under **Settings → You → Theme**.
System follows their computer, which only ever asks for light or dark. The
choice is per browser and is kept in a cookie (`ezacto_scheme`), because the
page has to be rendered in it before anything paints; the profile has nowhere
to keep a display preference.

An instance palette is the light scheme. Under System, everyone sees it,
whatever their computer is set to; somebody who picks Dim or Dark outright
sees that built-in scheme instead. The palette is checked against the light
scheme and never mixed into the others, so nothing reaches the screen that
the contrast rule has not passed. Documents a client receives are always the
light scheme.

## Readability is enforced, not advised

Every palette is checked before it is stored. The shell declares the colour
pairs that have to stay legible — body text on its ground, a button label on its
fill, a status word on its band — each with the contrast ratio it owes, and the
built-in theme is held to them. An instance palette answers to exactly the same
list.

A palette that fails is refused with the token at fault, the pair it broke and
the ratio it reached:

```
palette.ground — ink/ground text would be 1.07:1, below the 4.5:1 this
instance requires to stay readable.
```

This is the most common thing to hit, and it is worth knowing why. Setting a
dark `ground` on its own leaves the built-in near-black `ink` on top of it. A
dark palette is not one colour: expect to set the ground, the card surface, the
body text and the secondary text together, and then whichever status colours
were tuned for a white page.

The alternative — accepting the palette and letting the operator discover it —
produces an instance nobody can sign in to in order to undo it. Hence a refusal.

## What a client portal can read

`GET /api/v1/brand` returns the organisation name, the stored brand marks and
the palette, for any signed-in principal. A portal that wants to match the app
reads it there rather than approximating from a screenshot.

`palette` is `{}` for an instance on the built-in theme, and absent entirely on
a deployment that composes no theme surface — so a caller can tell "nothing has
been set" from "this deployment cannot tell me".

## Notes for operators and implementers

- **The palette is replaced whole, never patched.** Contrast is a property of
  the palette rather than of any one colour in it, so a partial update could
  only be validated against whatever happened to be stored — and two
  administrators editing at once would each pass against a palette neither ends
  up with.
- **Colours are six-digit hex.** Case is normalised, shorthand (`#abc`) is
  refused rather than expanded, because expanding it would be guessing at the
  one value you came to set.
- **It is a stylesheet, not an inline `<style>` block.** The shell is served
  under `style-src 'self' https://fonts.googleapis.com`, which admits no inline
  style; a `<style>` block would be dropped by the browser with no visible
  error. The stylesheet revalidates, so a changed colour appears on the next
  navigation while an unchanged palette costs a 304.
- **A database that has not run the migration serves no palette.** The shell
  renders the built-in colours. A theme lookup is never allowed to be the reason
  a page fails to render.
- **Stored values are guarded twice.** The route validates on the way in and the
  schema constrains the column, because these bytes are served inside a
  stylesheet and a value that could close a declaration would be an injection
  against every session on the instance.

## API

| Method | Path | Who |
| --- | --- | --- |
| `GET` | `/api/v1/settings/theme` | administrator |
| `POST` | `/api/v1/settings/theme` | administrator |
| `DELETE` | `/api/v1/settings/theme` | administrator |
| `GET` | `/api/v1/brand` | any signed-in principal |
| `GET` | `/assets/instance-theme.css` | anyone |

The stylesheet takes no principal: it is linked from the sign-in page, which is
fetched by a browser that has no session by definition. It reveals the
instance's colours, which is what it exists to put on the screen.

`POST` takes the whole palette:

```json
{ "palette": { "ground": "#1D1D1D", "surface": "#282828", "ink": "#F4F4F4" } }
```

An administrator session is required; an API token is refused. Changing how the
whole instance looks is a decision a person makes, not something a script should
carry.

## The surfaces that do not read the tokens (#666)

The shell reads `apps/web/theme-tokens.json`, compiled and contrast-checked.
Nothing else did, which is the gap #666 measured: mobile, the website, the
portal and the extension each carried hand-written hex, because there was
nothing they could read. The compiler now also emits

    apps/web/generated/theme-palette.json

which is deliberately the dullest possible shape — slot name to value, one level
deep, every theme rather than only the default. Anything with a JSON parser can
consume it without knowing what a slot is. It is generated: edit
`theme-tokens.json` and run `npm run theme:generate`, and `--check` fails a build
that left it stale.

### Stripe checkout is set in Stripe's dashboard, and does not match

The checkout page cannot import anything; its branding lives in Stripe's own
dashboard. Recorded here so nobody has to rediscover it from a screenshot:

| | value | nearest token |
| --- | --- | --- |
| background | `#1d1d1d` | none — `ink` is `#1A1A2E` |
| accent | `#db394c` | none — `action` is `#254FE8`, a blue |

Neither hex appears anywhere in the palette, and the accent is not merely a
shade off: the checkout page is branded red where the product's action colour is
blue. This is a **client-facing** surface, so the divergence costs more than an
internal one would — being a shade off reads as a different company, and being a
different hue reads as a different company more loudly.

**Decided: the dashboard moves onto the tokens.** Set the Stripe checkout
background to `ink` and its accent to `action`, so the page a client pays on
matches the product they are paying for. It is a dashboard change rather than a
code one, which is why it is recorded here — nothing in this repo can enforce
it, and the next person to compare the two needs to know which side was
considered right.

## Brand surface audit (#1011)

Where an instance's colours and marks reach, and where they do not. Each row is
one surface, cites the source that decides it, and is exactly one of:

- **delivered**: the source reads the instance brand today.
- **gap**: the source does not, and the surface wears the built-in look.
- **external**: set outside this repository.
- **none**: nothing in this repository draws it.

`packages/core/test/brand-surfaces.test.ts` holds this table to the source. A
delivered row fails the build if its source stops reading the brand; a gap row
fails the build once its source starts, so the row is flipped in the same change
that closes the gap; and a new HTML page, PDF writer or email body builder that
has no row fails until it gets one. A new surface cannot quietly bypass the
instance brand.

| Surface | What | Source | Status |
| --- | --- | --- | --- |
| `shell-colours` | App shell and sign-in link the instance stylesheet after the built-in one | `apps/web/src/shell/render.ts` | delivered |
| `shell-marks` | Topbar and sign-in splash draw the dark-ground wordmark, falling back to the deployment name | `apps/web/src/shell/render.ts` | delivered |
| `shell-favicon` | Tab icon from the `favicon` slot | `apps/web/src/shell/render.ts` | delivered |
| `document-shell-marks` | Document shell draws the light-ground wordmark | `apps/web/src/shell/render.ts` | delivered |
| `palette-stylesheet` | `GET /assets/instance-theme.css`, served without a session | `packages/api/src/instance-theme.ts` | delivered |
| `portal-brand-api` | `GET /api/v1/brand`: name, marks and palette for a portal | `packages/api/src/brand-assets.ts` | delivered |
| `invoice-pdf-logo` | Invoice PDF draws the `wordmark_light` mark, else the company name | `packages/db/src/money-resources.ts`, `entries/worker/src/invoice-documents.ts` | delivered |
| `invoice-pdf-colours` | Invoice PDF is greyscale apart from the fixed watermark; no palette token reaches it | `packages/core/src/invoice-document.ts` | gap |
| `report-pdf-name` | Detailed-time report header carries the nearest-ancestor report brand name | `packages/db/src/month-end-pack.ts`, `packages/core/src/report-document.ts` | delivered |
| `report-pdf-logo-colours` | Report brands store a logo URL and two colours; the report PDF draws only the name | `packages/core/src/report-document.ts` | gap |
| `email-body` | The HTML part of outgoing mail opens with a header: the `wordmark_light` mark by its public `/brand/...` URL (alt text is the company name) and a rule in the palette's `action` colour. Nothing is set, nothing is added | `packages/core/src/email-brand.ts`, `packages/api/src/email-brand.ts` | delivered |
| `email-text-body` | The plain-text part of every message, and the invoice email, which is plain text only, carry no mark or colour | `packages/core/src/invoice-email.ts`, `packages/core/src/email-templates.ts` | gap |
| `email-sender` | The mailer takes the provider From value and nothing from the brand; `emailSenderName` is read only by the demo | `packages/mailer/src/index.ts` | gap |
| `apple-disconnect` | The standalone Apple disconnect page links neither the instance stylesheet nor a mark, and names the product in its title and copy | `apps/web/src/shell/render.ts` | gap |
| `portal-estimate-review` | The standalone page a client's contact reads and answers an estimate on (`GET /portal/estimate-review`) links neither the instance stylesheet nor a mark, and carries only the deployment name, in its title and above its heading | `apps/web/src/portal-estimates/render.ts` | gap |
| `portal-invoice` | The standalone page a client reaches from the link in an emailed invoice (`GET /portal/invoices/:token`) links neither the instance stylesheet nor a mark, and carries only the company name, in its title and above its heading | `apps/web/src/portal-invoice/render.ts` | gap |
| `stripe-checkout` | Branded in Stripe's dashboard; see the note above | none | external |
| `native-apps` | Mobile themes are owned by ConflictHQ/ezacto-mobile#25 | none | none |

Not found anywhere: a product name an administrator sets (the deployment name
comes from the `BRAND_NAME` variable, not from Settings), a footer line or
signature text, and any use of the palette in a document.

### Deliberately never branded

These stay as they are whatever an instance configures, and this audit does not
propose changing them:

- **The legal and transactional sender.** The verified sender identity and the
  provider From value on mail identify who is sending. A brand never replaces
  or hides them.
- **The AGPL notice and attribution.** `LICENSE` and `NOTICE` describe the
  software as licensed; branding customer-facing surfaces does not alter those
  obligations.
- **Store listing identity.** The app store names, bundle identifiers and
  listings of the native apps.
- **Custom domains.** Owned by the hosted and portal work, not by this table.

Product renaming, hiding the product name, and any pricing or entitlement for
white-label are undecided and recorded as such in #1011. Nothing in this
repository gates branding.
