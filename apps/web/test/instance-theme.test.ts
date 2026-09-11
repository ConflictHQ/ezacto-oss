import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readInstancePalette } from '@ezacto/core'
import { instancePaletteContract } from '../src/instance-theme.js'
import { themeSlotCopy, themeSlotGroups } from '../src/module-settings/model.js'
import { renderAppShell } from '../src/shell/render.js'
import { cssCustomProperty, themeSlotNames } from '../src/theme.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

const shell = (instanceTheme?: boolean) =>
  renderAppShell({
    environment: 'test',
    release: 'instance-theme-test',
    ...(instanceTheme === undefined ? {} : { instanceTheme }),
  })

describe('the palette contract the instance is held to (#591)', () => {
  it('[unit] offers exactly the slots the shell declares', () => {
    // Stated from the tokens rather than transcribed, so a retuned or renamed
    // token cannot leave the settable set behind.
    expect(instancePaletteContract.slots).toEqual(themeSlotNames)
  })

  it('[unit] starts from the built-in theme, so an unset slot keeps its colour', () => {
    expect(instancePaletteContract.base['ground']).toBe('#FFFFFF')
    expect(Object.keys(instancePaletteContract.base).sort()).toEqual(
      [...themeSlotNames].sort(),
    )
  })

  it('[security] holds an instance palette to the bars the shipped theme answers to', () => {
    // The point of sharing the requirement list rather than writing a looser
    // one: an operator's palette is legible by the same standard the shipped
    // one is, and a requirement added for the built-in theme reaches instance
    // palettes without anyone remembering to copy it.
    expect(instancePaletteContract.requirements.length).toBeGreaterThan(0)
    const names = instancePaletteContract.requirements.map((r) => r.name)
    expect(names).toContain('ink/ground text')
  })

  it('[security] refuses a dark ground on its own and takes a whole dark palette', () => {
    // Against the real tokens, not a fixture: this is the check an administrator
    // of this build actually meets.
    expect(
      readInstancePalette({ ground: '#1D1D1D' }, instancePaletteContract).errors.some(
        (error) => error.code === 'contrast',
      ),
    ).toBe(true)
  })
})

describe('the palette an administrator is offered', () => {
  it('[unit] offers a control for every token the stylesheet actually spends', async () => {
    // The ratchet, in both directions. A token with no job (#437) must not get
    // a control, because a control that changes a stored value and nothing on
    // the screen is a setting that lies; and a token that gains a job must gain
    // a control, or the palette it belongs to cannot be completed.
    const stylesheet = await readFile(resolve(root, 'src', 'shell', 'shell.css'), 'utf8')
    const spent = themeSlotNames.filter((name) =>
      stylesheet.includes(`var(${cssCustomProperty(name)})`),
    )
    expect([...themeSlotCopy.map((copy) => copy.slot)].sort()).toEqual([...spent].sort())
  })

  it('[unit] puts every control in a declared group', () => {
    for (const copy of themeSlotCopy) {
      expect(themeSlotGroups).toContain(copy.group)
    }
  })

  it('[unit] names each slot once', () => {
    const slots = themeSlotCopy.map((copy) => copy.slot)
    expect(new Set(slots).size).toBe(slots.length)
  })

  it('[unit] leads with the four the issue names, and the ink they need', () => {
    const core = themeSlotCopy.filter((copy) => copy.group === 'Core').map((c) => c.slot)
    for (const slot of ['ground', 'surface', 'muted', 'ink']) {
      expect(core).toContain(slot)
    }
    expect(themeSlotCopy.find((copy) => copy.slot === 'action')?.group).toBe('Accent')
  })
})

describe('how the palette reaches the browser', () => {
  it('[security] is linked as a stylesheet, because the shell admits no inline style', () => {
    // `style-src 'self' https://fonts.googleapis.com` carries no
    // `'unsafe-inline'`, so a `<style>` block would be dropped by the browser
    // and the instance would silently render the built-in colours.
    const markup = shell(true)
    expect(markup).toContain('<link rel="stylesheet" href="/assets/instance-theme.css">')
    expect(markup).not.toMatch(/<style[\s>]/u)
  })

  it('[unit] loads the instance palette after the built-in one, or it would not win', () => {
    // Both write custom properties on `:root` at equal specificity, so the one
    // that lands later is the one that applies. Order is the whole mechanism.
    const markup = shell(true)
    expect(markup.indexOf('/assets/instance-theme.css')).toBeGreaterThan(
      markup.indexOf('/assets/ezacto.css'),
    )
  })

  it('[unit] leaves the link out for an instance with no palette', () => {
    // A stylesheet that would be empty costs every page load a request for
    // nothing.
    for (const markup of [shell(false), shell()]) {
      expect(markup).not.toContain('/assets/instance-theme.css')
      expect(markup).toContain('/assets/ezacto.css')
    }
  })
})
