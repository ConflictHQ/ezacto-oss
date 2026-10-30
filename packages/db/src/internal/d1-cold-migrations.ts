/** This is a conservative classifier for our reviewed migration SQL, not a
 * general SQL parser. Unknown, ambiguous and compound statements stay isolated. */
const tokens = (sql: string): string[] | null => {
  const result: string[] = []
  for (let index = 0; index < sql.length;) {
    const character = sql[index]!
    if (/\s/.test(character)) {
      index++
      continue
    }
    if (character === '\0') return null
    if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index + 2)
      index = end === -1 ? sql.length : end + 1
      continue
    }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2)
      if (end === -1) return null
      index = end + 2
      continue
    }
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      const closing = character === '[' ? ']' : character
      let closed = false
      index++
      while (index < sql.length) {
        if (sql[index] !== closing) {
          index++
          continue
        }
        if (closing !== ']' && sql[index + 1] === closing) {
          index += 2
          continue
        }
        index++
        closed = true
        break
      }
      if (!closed) return null
      result.push('$QUOTED')
      continue
    }
    if (/[A-Za-z_]/.test(character)) {
      const start = index++
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index]!)) index++
      result.push(sql.slice(start, index).toUpperCase())
    } else {
      result.push(character)
      index++
    }
  }
  return result
}

const singleStatement = (sql: string, trigger: boolean): boolean => {
  const words = tokens(sql)
  if (!words?.length) return false
  if (!trigger) {
    const separators = words.filter((word) => word === ';').length
    return separators === 0 || (separators === 1 && words.at(-1) === ';')
  }
  const begin = words.indexOf('BEGIN')
  if (begin === -1 || words.slice(0, begin).includes(';')) return false
  let cases = 0
  for (let index = begin + 1; index < words.length; index++) {
    const word = words[index]
    if (word === 'BEGIN') return false
    if (word === 'CASE') cases++
    if (word !== 'END') continue
    if (cases > 0) {
      cases--
      continue
    }
    if (words[index - 1] !== ';') return false
    const tail = words.slice(index + 1)
    return tail.length === 0 || (tail.length === 1 && tail[0] === ';')
  }
  return false
}

export const isOrdinaryD1SchemaStatement = (sql: string): boolean => {
  const text = sql.trimStart()
  // PRAGMAs change connection/transaction behavior. Deferred constraints and
  // all data-moving/unknown statements retain the original commit boundary.
  if (/\b(?:DEFERRABLE|PRAGMA)\b/i.test(text)) return false
  const trigger = /^CREATE\s+TRIGGER\b/i.test(text)
  const ordinary =
    /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[A-Za-z_]\w*\s*\(/i.test(text) ||
    /^CREATE\s+(?:UNIQUE\s+)?(?:INDEX|VIEW)\b/i.test(text) ||
    trigger ||
    /^ALTER\s+TABLE\s+[A-Za-z_]\w*\s+ADD\b/i.test(text) ||
    /^DROP\s+(?:INDEX|TRIGGER|VIEW)\b/i.test(text)
  return ordinary && singleStatement(text, trigger)
}
