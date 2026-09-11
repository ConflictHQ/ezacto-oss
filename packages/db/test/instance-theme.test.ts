import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerInstanceThemeStore } from '../src/instance-theme.js'
import { migrateContainer } from '../src/migrate.js'

const now = '2026-09-11T12:00:00.000Z'
const later = '2026-09-12T09:30:00.000Z'

const databases: BetterSqlite3.Database[] = []

const database = (): BetterSqlite3.Database => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  databases.push(sqlite)
  return sqlite
}

const dark = { ground: '#1D1D1D', surface: '#282828', ink: '#F4F4F4' }

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close()
})

describe('instance theme store (#591)', () => {
  it('[unit] an unthemed instance has no palette, not an empty one', async () => {
    // The difference the settings screen renders: "on the built-in theme" is a
    // row that is not there, which is also what the shell asks about when it
    // decides whether to link the stylesheet at all.
    expect(await createContainerInstanceThemeStore(database()).read()).toBeNull()
  })

  it('[unit] keeps the palette it was given', async () => {
    const store = createContainerInstanceThemeStore(database())
    await store.put({ palette: dark, updatedByUserId: null, now })
    expect((await store.read())?.palette).toEqual(dark)
  })

  it('[unit] saving again replaces the palette rather than merging into it', async () => {
    // Merging would make a slot impossible to unset: an operator who removes a
    // colour from the form would find it still applied.
    const store = createContainerInstanceThemeStore(database())
    await store.put({ palette: dark, updatedByUserId: null, now })
    await store.put({ palette: { action: '#DB394C' }, updatedByUserId: null, now: later })
    expect((await store.read())?.palette).toEqual({ action: '#DB394C' })
  })

  it('[unit] holds created_at at the first save and moves updated_at', async () => {
    const store = createContainerInstanceThemeStore(database())
    await store.put({ palette: dark, updatedByUserId: null, now })
    const second = await store.put({
      palette: { action: '#0B5E37' },
      updatedByUserId: null,
      now: later,
    })
    expect(second.createdAt).toBe(now)
    expect(second.updatedAt).toBe(later)
  })

  it('[unit] clearing says whether there was a palette to clear', async () => {
    const store = createContainerInstanceThemeStore(database())
    expect(await store.clear()).toBe(false)
    await store.put({ palette: dark, updatedByUserId: null, now })
    expect(await store.clear()).toBe(true)
    expect(await store.read()).toBeNull()
  })

  it('[unit] stores the slots in a stable order so one palette is one set of bytes', async () => {
    // The served stylesheet is derived from this column and cached by the
    // browser against it. Key order must not read as a change.
    const sqlite = database()
    const store = createContainerInstanceThemeStore(sqlite)
    await store.put({
      palette: { ink: '#F4F4F4', ground: '#1D1D1D' },
      updatedByUserId: null,
      now,
    })
    const first = sqlite.prepare('SELECT palette FROM instance_theme').get() as {
      palette: string
    }
    await store.put({
      palette: { ground: '#1D1D1D', ink: '#F4F4F4' },
      updatedByUserId: null,
      now: later,
    })
    const second = sqlite.prepare('SELECT palette FROM instance_theme').get() as {
      palette: string
    }
    expect(second.palette).toBe(first.palette)
  })

  it('[unit] rejects a clock that is not a canonical UTC timestamp', async () => {
    const store = createContainerInstanceThemeStore(database())
    await expect(
      store.put({ palette: dark, updatedByUserId: null, now: '2026-09-11 12:00:00' }),
    ).rejects.toThrow(RangeError)
  })
})

describe('the schema guard on stored colours (#591)', () => {
  const insert = (sqlite: BetterSqlite3.Database, palette: string) =>
    sqlite
      .prepare(
        `INSERT INTO instance_theme (id, palette, updated_by_user_id, created_at, updated_at)
         VALUES (1, ?, NULL, ?, ?)`,
      )
      .run(palette, now, now)

  it('[security] refuses a stored value that is not a colour, whatever wrote it', () => {
    // The second line behind the route. These bytes are served inside a
    // stylesheet, so a value that could close the declaration and open a rule
    // of its own must not be storable by any path -- an import, a console, or a
    // later feature that forgets to validate.
    const sqlite = database()
    expect(() =>
      insert(sqlite, JSON.stringify({ ground: 'red; } body { display: none }' })),
    ).toThrow(/six-digit uppercase hex colours only/)
  })

  it('[security] refuses shorthand, lower case, and a value that is not text', () => {
    const sqlite = database()
    for (const palette of [{ ground: '#abc' }, { ground: '#1d1d1d' }, { ground: 7 }]) {
      expect(() => insert(sqlite, JSON.stringify(palette))).toThrow(
        /six-digit uppercase hex colours only/,
      )
    }
  })

  it('[security] guards an update as well as an insert', () => {
    const sqlite = database()
    insert(sqlite, JSON.stringify({ ground: '#1D1D1D' }))
    expect(() =>
      sqlite
        .prepare('UPDATE instance_theme SET palette = ? WHERE id = 1')
        .run(JSON.stringify({ ground: 'url(https://example.invalid/x)' })),
    ).toThrow(/six-digit uppercase hex colours only/)
  })

  it('[unit] takes an empty palette and a well-formed one', () => {
    const sqlite = database()
    expect(() => insert(sqlite, '{}')).not.toThrow()
    sqlite.prepare('DELETE FROM instance_theme').run()
    expect(() => insert(sqlite, JSON.stringify(dark))).not.toThrow()
  })

  it('[unit] refuses a second row, because there is one instance', () => {
    const sqlite = database()
    insert(sqlite, '{}')
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO instance_theme (id, palette, updated_by_user_id, created_at, updated_at)
           VALUES (2, '{}', NULL, ?, ?)`,
        )
        .run(now, now),
    ).toThrow()
  })

  it('[unit] refuses a palette that is not a JSON object', () => {
    const sqlite = database()
    for (const palette of ['["#1D1D1D"]', 'not json', '"#1D1D1D"']) {
      expect(() => insert(sqlite, palette)).toThrow()
    }
  })
})
