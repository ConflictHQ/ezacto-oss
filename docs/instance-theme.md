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
