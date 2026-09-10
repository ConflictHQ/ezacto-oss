import { describe, expect, it } from 'vitest'
import {
  brandAssetAccept,
  brandAssetRejection,
  brandAssetSlotCopy,
  MAX_BRAND_ASSET_BYTES,
} from '../src/module-settings/model.js'

const file = (overrides: Partial<{ name: string; type: string; size: number }> = {}) => ({
  name: 'logo.png',
  type: 'image/png',
  size: 20_000,
  ...overrides,
})

describe('#489 brand asset upload control', () => {
  it('[unit] every slot says which ground its mark is drawn on', () => {
    // The whole failure this copy exists to stop: an operator reads "dark" as
    // "the dark logo", uploads a dark-on-transparent mark, and it vanishes
    // against the near-black topbar. Each label has to name the background.
    const dark = brandAssetSlotCopy.find((copy) => copy.slot === 'wordmark_dark')!
    const light = brandAssetSlotCopy.find((copy) => copy.slot === 'wordmark_light')!
    expect(dark.label).toContain('dark backgrounds')
    expect(dark.hint).toContain('light-coloured')
    expect(dark.preview).toBe('dark')
    expect(light.label).toContain('light backgrounds')
    expect(light.hint).toContain('dark-coloured')
    expect(light.preview).toBe('light')
  })

  it('[unit] every slot maps to the path segment its route uses', () => {
    expect(brandAssetSlotCopy.map((copy) => [copy.slot, copy.segment])).toEqual([
      ['wordmark_dark', 'wordmark-dark'],
      ['wordmark_light', 'wordmark-light'],
      ['favicon', 'favicon'],
    ])
  })

  it('[unit] the picker offers only the three raster types the route accepts', () => {
    expect(brandAssetAccept).toBe('image/png,image/jpeg,image/webp')
    expect(brandAssetAccept).not.toContain('svg')
  })

  it('[unit] a PNG, JPEG or WebP inside the cap is accepted', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(brandAssetRejection(file({ type }))).toBeNull()
    }
    expect(brandAssetRejection(file({ size: MAX_BRAND_ASSET_BYTES }))).toBeNull()
  })

  it('[unit] SVG is refused by name, with the reason', () => {
    const rejection = brandAssetRejection(
      file({ name: 'logo.svg', type: 'image/svg+xml' }),
    )
    expect(rejection).toContain('SVG is not accepted')
    expect(rejection).toContain('script')
  })

  it('[unit] a file over the cap is refused before it is sent', () => {
    expect(brandAssetRejection(file({ size: MAX_BRAND_ASSET_BYTES + 1 }))).toContain(
      'or smaller',
    )
    expect(brandAssetRejection(file({ size: 0 }))).toContain('empty')
  })

  it('[unit] anything else is refused as not one of the three', () => {
    expect(brandAssetRejection(file({ name: 'logo.gif', type: 'image/gif' }))).toContain(
      'PNG, JPEG or WebP',
    )
  })
})
