import type { Context, Hono, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'

/**
 * The brand marks an operator uploads (#489), and the one route in this
 * codebase that answers an anonymous browser with stored bytes.
 *
 * Three decisions are made here rather than per deployment.
 *
 * SERVING. The mark is public. An attachment downloads through an
 * authenticated route because a receipt belongs to the person who filed it; a
 * wordmark is drawn on the sign-in page, which is fetched by a browser that has
 * no session by definition, and on an invoice read by a client who has none
 * either. Gating it would mean either a signed URL minted per render -- which
 * the sign-in page cannot mint, having nobody to mint it for -- or leaving the
 * logo off the two surfaces the operator asked for it on. So the download route
 * takes no principal. What keeps that from being a hole in the bucket is the
 * shape of the URL: it addresses one slot and one content hash, it is checked
 * against the row that is current for that slot, and it can therefore name
 * nothing else in the object store. A stale hash is a 404, not a different
 * object.
 *
 * FORMAT. Raster only -- PNG, JPEG, WebP -- and SVG is refused with its own
 * message. An SVG is a document: it may carry `<script>`, and a browser that
 * navigates directly to one served from this origin will run it, which turns
 * an upload form into stored cross-site scripting against every session on the
 * instance. The alternatives were both refused deliberately. Sanitising needs a
 * real sanitiser over a real DOM, which the Worker runtime does not have, and a
 * hand-rolled element allowlist is the classic way to ship a sanitiser that
 * misses one vector. Serving from a separate sandbox origin is the other real
 * answer, and it is not available to the deployment this feature exists for:
 * the self-hosted instance with one hostname and nowhere to put a file.
 *
 * The declared content type is not trusted. The bytes are sniffed and what the
 * sniff found is what gets stored and later served, so a file called
 * `logo.png` whose content is an SVG is refused rather than served back with
 * the type it claimed.
 *
 * SIZE. Half a megabyte, against the attachment path's twenty-five. A wordmark
 * is tens of kilobytes; the cap is what bounds the object an unauthenticated
 * request can pull, so it is small deliberately and enforced twice -- here, and
 * as a CHECK in migration 0045, so no other writer can widen it.
 */
export const MAX_BRAND_ASSET_BYTES = 512 * 1024
const multipartOverheadBytes = 16 * 1024

export type BrandAssetSlot = 'wordmark_light' | 'wordmark_dark' | 'favicon'

interface SlotDefinition {
  slot: BrandAssetSlot
  /** The path segment. Dashes, because it appears in a URL a browser caches. */
  segment: string
}

const slotDefinitions: readonly SlotDefinition[] = [
  { slot: 'wordmark_light', segment: 'wordmark-light' },
  { slot: 'wordmark_dark', segment: 'wordmark-dark' },
  { slot: 'favicon', segment: 'favicon' },
]

export const brandAssetSegment = (slot: BrandAssetSlot): string =>
  slotDefinitions.find((definition) => definition.slot === slot)!.segment

const slotForSegment = (segment: string): BrandAssetSlot => {
  const definition = slotDefinitions.find((candidate) => candidate.segment === segment)
  if (definition === undefined) {
    throw new ApiError({
      status: 404,
      code: 'not_found',
      message: 'The brand asset slot does not exist.',
    })
  }
  return definition.slot
}

export interface StoredBrandAsset {
  slot: BrandAssetSlot
  contentHash: string
  fileKey: string
  contentType: string
  byteSize: number
  updatedAt: string
}

export interface BrandAssetObject {
  body: BodyInit
}

/**
 * Entry-owned, and threaded with the request environment rather than closed
 * over one. The Worker serves the shell from an app built with no runtime
 * services at all -- that split is what keeps a page render off the migration
 * path -- so the surface has to be usable from a request context that holds
 * nothing but its bindings.
 */
export interface BrandAssetSurface<Bindings extends object> {
  list(env: Bindings): Promise<readonly StoredBrandAsset[]>
  read(env: Bindings, fileKey: string): Promise<BrandAssetObject | null>
  write(
    env: Bindings,
    input: {
      slot: BrandAssetSlot
      bytes: ArrayBuffer
      contentHash: string
      fileKey: string
      contentType: string
      actorUserId: number
      now: string
    },
  ): Promise<StoredBrandAsset>
  remove(env: Bindings, slot: BrandAssetSlot): Promise<boolean>
}

const magicNumbers: readonly { contentType: string; matches(bytes: Uint8Array): boolean }[] = [
  {
    contentType: 'image/png',
    matches: (bytes) =>
      bytes.length > 8 &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (byte, index) => bytes[index] === byte,
      ),
  },
  {
    contentType: 'image/jpeg',
    matches: (bytes) =>
      bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  {
    // RIFF....WEBP. The four size bytes between the two tags are content, so
    // they are skipped rather than matched.
    contentType: 'image/webp',
    matches: (bytes) =>
      bytes.length > 12 &&
      [0x52, 0x49, 0x46, 0x46].every((byte, index) => bytes[index] === byte) &&
      [0x57, 0x45, 0x42, 0x50].every((byte, index) => bytes[index + 8] === byte),
  },
]

/**
 * An SVG has no magic number -- it is XML, and may open with a declaration, a
 * doctype, a comment or whitespace -- so it is recognised rather than matched,
 * and only so that it can be refused by name. Being told "SVG is not accepted"
 * is the difference between an operator converting their logo and an operator
 * concluding the upload is broken.
 */
const looksLikeMarkup = (bytes: Uint8Array): boolean => {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(0, 512))
    .trimStart()
    .toLowerCase()
  return head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!doctype')
}

export const sniffBrandAssetType = (bytes: ArrayBuffer): string => {
  const head = new Uint8Array(bytes)
  const matched = magicNumbers.find((candidate) => candidate.matches(head))
  if (matched !== undefined) return matched.contentType
  const markup = looksLikeMarkup(head)
  throw validationError([
    {
      field: 'file',
      code: markup ? 'markup_not_accepted' : 'unsupported_image',
      message: markup
        ? 'SVG and other markup are not accepted: they can carry script and would be served from this instance. Upload a PNG, JPEG or WebP.'
        : 'A brand asset must be a PNG, JPEG or WebP image.',
    },
  ])
}

const hash = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Its own prefix in the bucket, not the attachments' one. The nightly export
 * and any future sweep of orphaned attachment content both reason about
 * `sha256/`, and a brand mark is neither an attachment nor an export.
 */
export const brandAssetFileKey = (contentHash: string): string =>
  `brand/sha256/${contentHash.slice(0, 2)}/${contentHash}`

export const brandAssetPath = (slot: BrandAssetSlot, contentHash: string): string =>
  `/brand/${brandAssetSegment(slot)}/${contentHash}`

const serialize = (asset: StoredBrandAsset) => ({
  slot: asset.slot,
  content_hash: asset.contentHash,
  content_type: asset.contentType,
  byte_size: asset.byteSize,
  url: brandAssetPath(asset.slot, asset.contentHash),
  updated_at: asset.updatedAt,
})

const assertAdministrator = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): number => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator') {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can change the brand assets.',
    })
  }
  return principal.userId
}

const multipartFile = async <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): Promise<ArrayBuffer> => {
  const contentType = context.req.header('content-type') ?? ''
  if (
    !/^multipart\/form-data\s*;/i.test(contentType) ||
    !/boundary\s*=\s*(?:"[^"]+"|[^;\s]+)/i.test(contentType)
  ) {
    throw new ApiError({
      status: 415,
      code: 'unsupported_media_type',
      message: 'Brand asset uploads require multipart/form-data with a boundary.',
    })
  }
  let form: FormData
  try {
    form = await context.req.raw.formData()
  } catch {
    throw new ApiError({
      status: 400,
      code: 'invalid_multipart',
      message: 'The multipart request body is malformed.',
    })
  }
  const entries = [...form.entries()]
  if (entries.length !== 1 || entries[0]?.[0] !== 'file') {
    throw validationError([
      {
        field: 'file',
        code: 'exactly_one_required',
        message: 'provide exactly one file part and no other fields',
      },
    ])
  }
  const value = entries[0][1]
  if (!(value instanceof Blob)) {
    throw validationError([
      { field: 'file', code: 'file_required', message: 'file must be a binary file part' },
    ])
  }
  if (value.size > MAX_BRAND_ASSET_BYTES) {
    throw new ApiError({
      status: 413,
      code: 'payload_too_large',
      message: `A brand asset must be ${MAX_BRAND_ASSET_BYTES} bytes or smaller.`,
    })
  }
  const bytes = await value.arrayBuffer()
  // Measured again after reading rather than trusted from `Blob.size`: the cap
  // has to hold against the bytes that would actually be stored, and an empty
  // part is refused here rather than reaching the sniffer as a zero-length
  // buffer that matches nothing.
  if (bytes.byteLength > MAX_BRAND_ASSET_BYTES || bytes.byteLength === 0) {
    throw new ApiError({
      status: 413,
      code: 'payload_too_large',
      message: `A brand asset must be between 1 and ${MAX_BRAND_ASSET_BYTES} bytes.`,
    })
  }
  return bytes
}

/** Administrator-only management of the stored marks, under `/api/v1`. */
export const installBrandAssetRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  surface: BrandAssetSurface<Bindings>,
  clock: () => string = () => new Date().toISOString(),
): void => {
  const uploadLimit = bodyLimit({
    maxSize: MAX_BRAND_ASSET_BYTES + multipartOverheadBytes,
    onError: () => {
      throw new ApiError({
        status: 413,
        code: 'payload_too_large',
        message: `A brand asset must be ${MAX_BRAND_ASSET_BYTES} bytes or smaller.`,
      })
    },
  }) as MiddlewareHandler<ApiContext<Bindings>>
  api.use('/settings/brand-assets/:slot', uploadLimit)

  api.get('/settings/brand-assets', async (context) => {
    assertAdministrator(context)
    return context.json(
      {
        data: (await surface.list(context.env)).map(serialize),
        links: { self: '/api/v1/settings/brand-assets' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/settings/brand-assets/:slot', async (context) => {
    const actorUserId = assertAdministrator(context)
    const slot = slotForSegment(context.req.param('slot') ?? '')
    const bytes = await multipartFile(context)
    const contentType = sniffBrandAssetType(bytes)
    const contentHash = await hash(bytes)
    const stored = await surface.write(context.env, {
      slot,
      bytes,
      contentHash,
      fileKey: brandAssetFileKey(contentHash),
      contentType,
      actorUserId,
      now: clock(),
    })
    return context.json({ data: serialize(stored) }, 201, { 'cache-control': 'no-store' })
  })

  // Removing a stored mark is how an operator gets back to the deploy-time URL
  // or to the text wordmark, so it is part of the feature rather than tidying.
  api.delete('/settings/brand-assets/:slot', async (context) => {
    assertAdministrator(context)
    const slot = slotForSegment(context.req.param('slot') ?? '')
    if (!(await surface.remove(context.env, slot))) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'No brand asset is stored in that slot.',
      })
    }
    return context.body(null, 204, { 'cache-control': 'no-store' })
  })
}

/**
 * The anonymous download. Content-addressed, so the response is immutable and
 * a browser that has the mark never asks again; a replaced mark changes the
 * hash and therefore the URL, which is why the cache lifetime can be a year
 * without an operator having to wait one to see their new logo.
 */
/**
 * The brand as any signed-in principal may read it: the organisation's name
 * and the marks it has stored. The settings list above is for the
 * administrator who changes the marks; this is for a portal or integration
 * that has a token and wants to wear the tenant's brand. It carries nothing
 * the public mark URLs do not already reveal.
 */
export const installBrandRoute = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: {
    organizationName: () => Promise<string>
    assets: (env: Bindings) => Promise<readonly StoredBrandAsset[]>
  },
): void => {
  api.get('/brand', async (context) => {
    const [organizationName, assets] = await Promise.all([
      options.organizationName(),
      options.assets(context.env),
    ])
    return context.json(
      {
        data: {
          organization_name: organizationName,
          assets: assets.map((asset) => ({
            slot: asset.slot,
            url: brandAssetPath(asset.slot, asset.contentHash),
            content_type: asset.contentType,
            updated_at: asset.updatedAt,
          })),
        },
        links: { self: '/api/v1/brand' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })
}

export const installPublicBrandAssetRoutes = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  surface: BrandAssetSurface<Bindings>,
): void => {
  app.get('/brand/:slot/:hash', async (context) => {
    const slot = slotForSegment(context.req.param('slot') ?? '')
    const asset = (await surface.list(context.env)).find(
      (candidate) => candidate.slot === slot,
    )
    if (asset === undefined || asset.contentHash !== context.req.param('hash')) {
      return context.body(null, 404, { 'cache-control': 'no-store' })
    }
    const object = await surface.read(context.env, asset.fileKey)
    if (object === null) return context.body(null, 404, { 'cache-control': 'no-store' })
    return new Response(object.body, {
      status: 200,
      headers: {
        'cache-control': 'public, max-age=31536000, immutable',
        'content-type': asset.contentType,
        'content-length': String(asset.byteSize),
        // Defence in depth for a path that serves operator-supplied bytes to
        // anyone: nosniff stops a browser re-typing them as something
        // executable, and the sandbox policy applies to a direct navigation,
        // where the response is a document rather than an image.
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
        'x-frame-options': 'DENY',
      },
    })
  })
}
