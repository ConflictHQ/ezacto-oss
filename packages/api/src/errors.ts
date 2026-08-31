import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiContext } from './context.js'

const codePattern = /^[a-z][a-z0-9_]*$/

export interface FieldError {
  field: string
  code: string
  message: string
  minimum_length?: number
}

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    fields: FieldError[]
  }
  request_id: string
}

interface ApiErrorOptions {
  status: ContentfulStatusCode
  code: string
  message: string
  fields?: readonly FieldError[]
}

export interface JsonBodyOptions {
  /** Maximum UTF-8 bytes accepted before JSON parsing. Defaults to 1 MiB. */
  maxBytes?: number
}

export const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024

/** A deliberate HTTP failure. Unknown exceptions are never serialized verbatim. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode
  readonly code: string
  readonly fields: readonly FieldError[]

  constructor({ status, code, message, fields = [] }: ApiErrorOptions) {
    super(message)
    this.name = 'ApiError'
    if (status < 400 || status > 599) throw new RangeError('API error status must be 4xx or 5xx')
    assertCode(code, 'error code')
    for (const field of fields) {
      if (field.field.trim().length === 0) throw new TypeError('field error path cannot be empty')
      assertCode(field.code, 'field error code')
      if (field.message.trim().length === 0) throw new TypeError('field error message cannot be empty')
      if (
        field.minimum_length !== undefined &&
        (!Number.isSafeInteger(field.minimum_length) || field.minimum_length < 1)
      ) {
        throw new TypeError('field error minimum_length must be a positive safe integer')
      }
    }
    if (status === 422 && fields.length === 0) {
      throw new TypeError('422 API errors must carry at least one field error')
    }
    this.status = status
    this.code = code
    this.fields = fields.map((field) => ({ ...field }))
  }
}

const assertCode = (code: string, label: string): void => {
  if (!codePattern.test(code)) throw new TypeError(`${label} must be lowercase snake case`)
}

export const validationError = (
  fields: readonly FieldError[],
  message = 'The request contains invalid fields.',
): ApiError =>
  new ApiError({
    status: 422,
    code: 'validation_failed',
    message,
    fields,
  })

type JsonRequestContext = Pick<Context, 'req'>

export const readJsonBody = async <T>(
  context: JsonRequestContext,
  { maxBytes = DEFAULT_MAX_JSON_BODY_BYTES }: JsonBodyOptions = {},
): Promise<T> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('JSON body byte limit must be a positive safe integer')
  }
  const contentType = context.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (
    contentType === undefined ||
    (contentType !== 'application/json' && !contentType.endsWith('+json'))
  ) {
    throw new ApiError({
      status: 415,
      code: 'unsupported_media_type',
      message: 'Request body must use an application/json content type.',
    })
  }

  const declaredLength = context.req.header('content-length')
  if (declaredLength !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) {
      throw new ApiError({
        status: 400,
        code: 'invalid_content_length',
        message: 'Content-Length must be a non-negative decimal byte count.',
      })
    }
    if (Number(declaredLength) > maxBytes) throw payloadTooLarge(maxBytes)
  }

  const bytes = await readLimitedBody(context.req.raw.body, maxBytes)
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return JSON.parse(text) as T
  } catch {
    throw new ApiError({
      status: 400,
      code: 'invalid_json',
      message: 'Request body is not valid JSON.',
    })
  }
}

const payloadTooLarge = (maxBytes: number): ApiError =>
  new ApiError({
    status: 413,
    code: 'payload_too_large',
    message: `Request body exceeds the ${maxBytes}-byte limit.`,
  })

const readLimitedBody = async (
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> => {
  if (body === null) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw payloadTooLarge(maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

const bodyFor = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
  code: string,
  message: string,
  fields: readonly FieldError[],
): ApiErrorBody => ({
  error: { code, message, fields: fields.map((field) => ({ ...field })) },
  request_id: context.get('requestId'),
})

export const errorResponse = <Bindings extends object>(
  error: Error,
  context: Context<ApiContext<Bindings>>,
): Response => {
  if (error instanceof ApiError && error.status < 500) {
    return context.json(
      bodyFor(context, error.code, error.message, error.fields),
      error.status,
      { 'cache-control': 'no-store' },
    )
  }
  return context.json(
    bodyFor(context, 'internal_error', 'The request could not be completed.', []),
    error instanceof ApiError ? error.status : 500,
    { 'cache-control': 'no-store' },
  )
}

export const notFoundResponse = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): Response =>
  context.json(
    bodyFor(context, 'not_found', 'The requested resource does not exist.', []),
    404,
    { 'cache-control': 'no-store' },
  )
