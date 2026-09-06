const decimalPattern = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/

interface DecimalParts {
  numerator: bigint
  scale: number
}

const decimalParts = (literal: string, field: string): DecimalParts => {
  const match = decimalPattern.exec(literal)
  if (!match) throw new Error(`${field} is not a JSON decimal: ${literal}`)
  const fraction = match[3] ?? ''
  const exponent = Number(match[4] ?? 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) {
    throw new Error(`${field} exponent is outside the supported range`)
  }
  const digits = BigInt(`${match[2]}${fraction}`)
  return {
    numerator: match[1] === '-' ? -digits : digits,
    scale: fraction.length - exponent,
  }
}

const checkedNumber = (value: bigint, field: string, maximum = 9_007_199_254_740_991n): number => {
  if (value < -maximum || value > maximum) throw new Error(`${field} is outside the safe range`)
  return Number(value)
}

const CENTS_MAXIMUM = 9_000_000_000_000n

export const moneyLiteralToCents = (literal: string, field = 'money'): number => {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(literal)) {
    throw new Error(
      `${field} must be a plain decimal with at most two fractional digits: ${literal}`,
    )
  }
  const { numerator, scale } = decimalParts(literal, field)
  const cents = scale <= 2 ? numerator * 10n ** BigInt(2 - scale) : numerator
  return checkedNumber(cents, field, CENTS_MAXIMUM)
}

export interface CentsTransform {
  cents: number
  residue: string | null
}

/**
 * A per-unit rate, not a money total. Harvest stores rates at whatever
 * precision the account set them — a mileage category at $0.485/mile is the
 * IRS half-cent rate, not bad data — while ezacto money columns are integer
 * cents. Round half-even and hand back the source literal as a residue so the
 * load report can explain the difference, exactly as decimal hours do. The
 * authoritative line `amount` is still parsed by `moneyLiteralToCents`, so a
 * rounded rate can never move a total.
 */
export const rateLiteralToCents = (literal: string, field = 'rate'): CentsTransform => {
  const { numerator, scale } = decimalParts(literal, field)
  if (scale <= 2) {
    return { cents: checkedNumber(numerator * 10n ** BigInt(2 - scale), field, CENTS_MAXIMUM), residue: null }
  }
  const denominator = 10n ** BigInt(scale - 2)
  const cents = roundHalfEven(numerator, denominator)
  const residue = numerator % denominator === 0n ? null : literal
  return { cents: checkedNumber(cents, field, CENTS_MAXIMUM), residue }
}

const roundHalfEven = (numerator: bigint, denominator: bigint): bigint => {
  const negative = numerator < 0n
  const magnitude = negative ? -numerator : numerator
  const quotient = magnitude / denominator
  const remainder = magnitude % denominator
  const twice = remainder * 2n
  const rounded =
    twice > denominator || (twice === denominator && quotient % 2n === 1n)
      ? quotient + 1n
      : quotient
  return negative ? -rounded : rounded
}

export interface SecondsTransform {
  seconds: number
  residue: string | null
}

export const hoursLiteralToSeconds = (literal: string, field = 'hours'): SecondsTransform => {
  const { numerator, scale } = decimalParts(literal, field)
  const scaled = numerator * 3600n
  const denominator = scale > 0 ? 10n ** BigInt(scale) : 1n
  const whole = scale > 0 ? roundHalfEven(scaled, denominator) : scaled * 10n ** BigInt(-scale)
  if (whole < 0n) throw new Error(`${field} cannot be negative`)
  const exactNumerator = scale > 0 ? scaled : whole
  const residue = scale > 0 && exactNumerator % denominator !== 0n ? literal : null
  return { seconds: checkedNumber(whole, field), residue }
}

export const percentLiteralToPpm = (
  literal: string | null,
  field = 'percentage',
): number | null => {
  if (literal === null) return null
  const { numerator, scale } = decimalParts(literal, field)
  if (scale > 4) throw new Error(`${field} has more than four decimal places: ${literal}`)
  const ppm = scale <= 4 ? numerator * 10n ** BigInt(4 - scale) : numerator
  if (ppm < 0n || ppm > 1_000_000n) throw new Error(`${field} must be between 0 and 100`)
  return Number(ppm)
}

export const canonicalHarvestTime = (value: string | null, clock: string): string | null => {
  if (value === null) return null
  const canonical = /^(\d{2}):(\d{2})$/.exec(value)
  if (canonical) {
    const hour = Number(canonical[1])
    const minute = Number(canonical[2])
    if (hour <= 23 && minute <= 59) return value
  }
  if (clock !== '12h') throw new Error(`time ${value} is not canonical HH:MM for a 24h account`)
  const twelve = /^(\d{1,2}):(\d{2})(am|pm)$/i.exec(value.replace(/\s+/g, ''))
  if (!twelve) throw new Error(`time ${value} is not a Harvest 12h time`)
  let hour = Number(twelve[1])
  const minute = Number(twelve[2])
  if (hour < 1 || hour > 12 || minute > 59) throw new Error(`time ${value} is invalid`)
  if (hour === 12) hour = 0
  if (twelve[3].toLowerCase() === 'pm') hour += 12
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export const billingMethod = (
  isBillable: boolean,
  isFixedFee: boolean,
): { value: 'non_billable' | 'time_materials' | 'fixed_fee'; anomaly: boolean } => {
  if (!isBillable) return { value: 'non_billable', anomaly: isFixedFee }
  return { value: isFixedFee ? 'fixed_fee' : 'time_materials', anomaly: false }
}

const baseRoles = new Set(['administrator', 'manager', 'member'])

export const accessRoles = (
  roles: readonly string[],
): {
  profile: 'administrator' | 'project_manager' | 'member'
  managerGrants: string[]
} => ({
  profile: roles.includes('administrator')
    ? 'administrator'
    : roles.includes('manager')
      ? 'project_manager'
      : 'member',
  managerGrants: roles.filter((role) => !baseRoles.has(role)),
})

const pointer = (path: readonly (string | number)[]): string =>
  `/${path.map((part) => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`

/** Captures every number token before JSON.parse can round ids or erase scale. */
export const numberLexemes = (source: string): Map<string, string> => {
  const numbers = new Map<string, string>()
  let at = 0
  const space = (): void => {
    while (/\s/.test(source[at] ?? '')) at += 1
  }
  const stringToken = (): string => {
    const start = at++
    let escaped = false
    while (at < source.length) {
      const char = source[at++]
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') return JSON.parse(source.slice(start, at)) as string
    }
    throw new Error('unterminated JSON string')
  }
  const value = (path: readonly (string | number)[]): void => {
    space()
    const char = source[at]
    if (char === '{') {
      at += 1
      space()
      if (source[at] === '}') {
        at += 1
        return
      }
      for (;;) {
        space()
        if (source[at] !== '"') throw new Error('invalid JSON object key')
        const key = stringToken()
        space()
        if (source[at++] !== ':') throw new Error('invalid JSON object separator')
        value([...path, key])
        space()
        if (source[at] === '}') {
          at += 1
          return
        }
        if (source[at++] !== ',') throw new Error('invalid JSON object')
      }
    }
    if (char === '[') {
      at += 1
      space()
      if (source[at] === ']') {
        at += 1
        return
      }
      let index = 0
      for (;;) {
        value([...path, index++])
        space()
        if (source[at] === ']') {
          at += 1
          return
        }
        if (source[at++] !== ',') throw new Error('invalid JSON array')
      }
    }
    if (char === '"') {
      stringToken()
      return
    }
    const start = at
    while (at < source.length && !/[\s,\]}]/.test(source[at])) at += 1
    const token = source.slice(start, at)
    if (decimalPattern.test(token)) numbers.set(pointer(path), token)
    else if (!['true', 'false', 'null'].includes(token))
      throw new Error(`invalid JSON token ${token}`)
  }
  value([])
  space()
  if (at !== source.length) throw new Error('trailing JSON data')
  return numbers
}
