import {
  TrackedMutationLockedError,
  TrackedResourceAssignmentError,
  TrackedResourceConflictError,
  TrackedResourceInputError,
  TrackedResourceNotFoundError,
} from '@ezacto/core'
import type { Context } from 'hono'
import type { ApiContext } from '../context.js'
import {
  ApiError,
  readJsonBody,
  validationError,
  type FieldError,
} from '../errors.js'

export const isJsonObject = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const readObjectBody = async <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): Promise<Record<string, unknown>> => {
  const body = await readJsonBody<unknown>(context)
  if (!isJsonObject(body)) {
    throw validationError([
      {
        field: 'body',
        code: 'invalid',
        message: 'request body must be a JSON object',
      },
    ])
  }
  return body
}

export const unknownFieldErrors = (
  object: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): FieldError[] =>
  Object.keys(object)
    .filter((key) => !allowed.has(key))
    .map((field) => ({
      field,
      code: 'unknown',
      message: `${field} is not accepted`,
    }))

export const requiredPositiveInteger = (
  object: Record<string, unknown>,
  field: string,
  errors: FieldError[],
): number | undefined => {
  const value = object[field]
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    errors.push({
      field,
      code: value === undefined ? 'required' : 'invalid_integer',
      message: `${field} must be a positive safe integer`,
    })
    return undefined
  }
  return value as number
}

export const optionalPositiveInteger = (
  object: Record<string, unknown>,
  field: string,
  errors: FieldError[],
): number | undefined => {
  if (!Object.hasOwn(object, field)) return undefined
  return requiredPositiveInteger(object, field, errors)
}

export const optionalNonnegativeInteger = (
  object: Record<string, unknown>,
  field: string,
  errors: FieldError[],
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined => {
  if (!Object.hasOwn(object, field)) return undefined
  const value = object[field]
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    errors.push({
      field,
      code: 'invalid_integer',
      message: `${field} must be a non-negative safe integer at most ${maximum}`,
    })
    return undefined
  }
  return value as number
}

export const optionalBoolean = (
  object: Record<string, unknown>,
  field: string,
  errors: FieldError[],
): boolean | undefined => {
  if (!Object.hasOwn(object, field)) return undefined
  const value = object[field]
  if (typeof value !== 'boolean') {
    errors.push({
      field,
      code: 'invalid_boolean',
      message: `${field} must be a boolean`,
    })
    return undefined
  }
  return value
}

export const optionalNullableString = (
  object: Record<string, unknown>,
  field: string,
  errors: FieldError[],
  maximumLength = 10_000,
): string | null | undefined => {
  if (!Object.hasOwn(object, field)) return undefined
  const value = object[field]
  if (
    value !== null &&
    (typeof value !== 'string' || value.length > maximumLength)
  ) {
    errors.push({
      field,
      code: 'invalid_string',
      message: `${field} must be a string no longer than ${maximumLength} characters or null`,
    })
    return undefined
  }
  return value as string | null
}

export const optionalNullableObject = (
  object: Record<string, unknown>,
  field: string,
  errors: FieldError[],
): Record<string, unknown> | null | undefined => {
  if (!Object.hasOwn(object, field)) return undefined
  const value = object[field]
  if (value !== null && !isJsonObject(value)) {
    errors.push({
      field,
      code: 'invalid_object',
      message: `${field} must be a JSON object or null`,
    })
    return undefined
  }
  return value as Record<string, unknown> | null
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/

export const isCanonicalDate = (value: string): boolean => {
  const match = datePattern.exec(value)
  if (!match) return false
  const epoch = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  )
  const date = new Date(epoch)
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  )
}

export const optionalDate = (
  object: Record<string, unknown>,
  field: string,
  errors: FieldError[],
): string | undefined => {
  if (!Object.hasOwn(object, field)) return undefined
  const value = object[field]
  if (typeof value !== 'string' || !isCanonicalDate(value)) {
    errors.push({
      field,
      code: 'invalid_date',
      message: `${field} must be a real canonical YYYY-MM-DD date`,
    })
    return undefined
  }
  return value
}

const timePattern = /^(\d{2}):(\d{2})$/

export const isCanonicalTime = (value: string): boolean => {
  const match = timePattern.exec(value)
  return match !== null && Number(match[1]) <= 23 && Number(match[2]) <= 59
}

export const optionalTime = (
  object: Record<string, unknown>,
  field: string,
  errors: FieldError[],
): string | undefined => {
  if (!Object.hasOwn(object, field)) return undefined
  const value = object[field]
  if (typeof value !== 'string' || !isCanonicalTime(value)) {
    errors.push({
      field,
      code: 'invalid_time',
      message: `${field} must be a canonical 24-hour HH:MM time`,
    })
    return undefined
  }
  return value
}

const timestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

export const isCanonicalTimestamp = (value: string): boolean => {
  const match = timestampPattern.exec(value)
  if (!match) return false
  const epoch = Date.parse(value)
  const timestamp = new Date(epoch)
  return (
    Number.isFinite(epoch) &&
    timestamp.getUTCFullYear() === Number(match[1]) &&
    timestamp.getUTCMonth() === Number(match[2]) - 1 &&
    timestamp.getUTCDate() === Number(match[3]) &&
    timestamp.getUTCHours() === Number(match[4]) &&
    timestamp.getUTCMinutes() === Number(match[5]) &&
    timestamp.getUTCSeconds() === Number(match[6]) &&
    timestamp.getUTCMilliseconds() ===
      Number((match[7] ?? '').padEnd(3, '0') || 0)
  )
}

export const assertFields = (errors: readonly FieldError[]): void => {
  if (errors.length > 0) throw validationError(errors)
}

export const resourceId = (raw: string, label: string): number => {
  if (!/^[1-9][0-9]*$/.test(raw)) throw notFound(label)
  const id = Number(raw)
  if (!Number.isSafeInteger(id)) throw notFound(label)
  return id
}

export const notFound = (label: string): ApiError =>
  new ApiError({
    status: 404,
    code: 'not_found',
    message: `The requested ${label} does not exist.`,
  })

export const translateResourceError = (
  error: unknown,
  label: string,
): never => {
  if (error instanceof ApiError) throw error
  if (error instanceof TrackedMutationLockedError) {
    throw new ApiError({
      status: 422,
      code: error.code,
      message: 'The tracked record is locked and cannot be changed.',
      fields: [
        {
          field: label.replaceAll(' ', '_'),
          code: error.reasonCode,
          message: error.reason,
        },
      ],
    })
  }
  if (error instanceof TrackedResourceNotFoundError) throw notFound(label)
  if (error instanceof TrackedResourceAssignmentError) {
    throw new ApiError({
      status: 403,
      code: error.code,
      message: error.message,
    })
  }
  if (error instanceof TrackedResourceConflictError) {
    throw new ApiError({
      status: 409,
      code: error.code,
      message: error.message,
    })
  }
  if (error instanceof TrackedResourceInputError) {
    throw validationError([
      { field: error.field, code: error.reasonCode, message: error.message },
    ])
  }
  throw error
}

export const strictSearchParams = (
  url: URL,
  allowed: ReadonlySet<string>,
): Map<string, string> => {
  const parsed = new Map<string, string>()
  const errors: FieldError[] = []
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key)
    if (!allowed.has(key)) {
      errors.push({
        field: key,
        code: 'unknown',
        message: `${key} is not accepted`,
      })
      continue
    }
    if (values.length !== 1) {
      errors.push({
        field: key,
        code: 'duplicate',
        message: `${key} may appear once`,
      })
      continue
    }
    parsed.set(key, values[0]!)
  }
  assertFields(errors)
  return parsed
}

export const queryPositiveInteger = (
  params: ReadonlyMap<string, string>,
  field: string,
  errors: FieldError[],
): number | undefined => {
  const raw = params.get(field)
  if (raw === undefined) return undefined
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    errors.push({
      field,
      code: 'invalid_integer',
      message: `${field} must be a positive safe integer`,
    })
    return undefined
  }
  return Number(raw)
}

export const queryBoolean = (
  params: ReadonlyMap<string, string>,
  field: string,
  errors: FieldError[],
): boolean | undefined => {
  const raw = params.get(field)
  if (raw === undefined) return undefined
  if (raw !== 'true' && raw !== 'false') {
    errors.push({
      field,
      code: 'invalid_boolean',
      message: `${field} must be true or false`,
    })
    return undefined
  }
  return raw === 'true'
}

export const queryDate = (
  params: ReadonlyMap<string, string>,
  field: string,
  errors: FieldError[],
): string | undefined => {
  const raw = params.get(field)
  if (raw === undefined) return undefined
  if (!isCanonicalDate(raw)) {
    errors.push({
      field,
      code: 'invalid_date',
      message: `${field} must be a real canonical YYYY-MM-DD date`,
    })
    return undefined
  }
  return raw
}

export const queryTimestamp = (
  params: ReadonlyMap<string, string>,
  field: string,
  errors: FieldError[],
): string | undefined => {
  const raw = params.get(field)
  if (raw === undefined) return undefined
  if (!isCanonicalTimestamp(raw)) {
    errors.push({
      field,
      code: 'invalid_timestamp',
      message: `${field} must be a real canonical UTC timestamp`,
    })
    return undefined
  }
  return raw
}

export const queryNonemptyString = (
  params: ReadonlyMap<string, string>,
  field: string,
  errors: FieldError[],
  maximumLength = 255,
): string | undefined => {
  const raw = params.get(field)
  if (raw === undefined) return undefined
  if (raw.length === 0 || raw.length > maximumLength) {
    errors.push({
      field,
      code: 'invalid_string',
      message: `${field} must contain between 1 and ${maximumLength} characters`,
    })
    return undefined
  }
  return raw
}

export const queryEnum = <Value extends string>(
  params: ReadonlyMap<string, string>,
  field: string,
  values: readonly Value[],
  errors: FieldError[],
): Value | undefined => {
  const raw = params.get(field)
  if (raw === undefined) return undefined
  if (!(values as readonly string[]).includes(raw)) {
    errors.push({
      field,
      code: 'unsupported',
      message: `${field} must be one of ${values.join(', ')}`,
    })
    return undefined
  }
  return raw as Value
}
