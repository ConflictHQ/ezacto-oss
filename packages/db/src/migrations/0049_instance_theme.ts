// Provenance: ezacto-oss #591; an instance should be able to wear its own
// colours rather than the ones the build shipped.
//
// Why a table and not deployment configuration. The brand marks went this way
// first (0045) and for the same reason: a self-hosted instance may have nobody
// who can set a repository variable and redeploy, and an operator who has just
// been given a palette by their designer should not need one. The marks and the
// palette are the same act -- making the instance look like the organisation --
// so they are set on the same screen and stored the same way.
//
// Why one JSON column instead of a row per slot. The palette is written whole
// and read whole: the settings screen saves every slot at once because the
// contrast rule is a property of the palette rather than of any one colour in
// it, and the stylesheet route emits all of them together. A row per slot would
// buy per-slot history nobody asked for and make "what is the current palette?"
// a query that can return a half-applied answer mid-write. `organizations`
// already stores its module set and its reminder policy as JSON, so this is the
// shape this schema reaches for.
//
// Why the values are guarded here as well as in the route. These bytes are
// served to a browser inside a stylesheet. A value that closed the declaration
// and opened a rule of its own would be stylesheet injection against every
// session on the instance, so what may be stored is narrowed to a six-digit hex
// colour and nothing else. The route validates first; this is the second line,
// so a row written by any other path -- an import, a console, a later feature
// -- still cannot carry anything a browser would read as anything but a colour.
// SQLite cannot express that in a CHECK over a JSON object, so it is a trigger
// over `json_each`, one per writing statement.
//
// The slot *names* are deliberately not constrained here. Which slots exist is
// the web shell's design-token contract, and a copy of that list in a frozen
// migration would be a second source able to drift from the stylesheet the
// browser actually loads. The route holds names to the contract; the schema
// holds values to being colours.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND CAST(substr(${column}, 12, 2) AS INTEGER) BETWEEN 0 AND 23
  AND CAST(substr(${column}, 15, 2) AS INTEGER) BETWEEN 0 AND 59
  AND CAST(substr(${column}, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

/**
 * Six uppercase hex digits behind a `#`, as a GLOB.
 *
 * Written out rather than generated so the DDL reads as what it enforces. GLOB
 * is case-sensitive in SQLite, which is the point: the route upper-cases on the
 * way in, so a lower-case value in the column means something wrote around the
 * route and is worth refusing rather than quietly accepting.
 */
const hexColorGlob = "'#[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'"

const paletteIsColors = (column: string) => `EXISTS (
    SELECT 1 FROM json_each(${column})
    WHERE json_each.type <> 'text' OR json_each.value NOT GLOB ${hexColorGlob}
  )`

export const instanceThemeMigration = [
  `CREATE TABLE instance_theme (
    -- One instance, one palette, stated in the schema rather than trusted to
    -- every writer.
    id INTEGER PRIMARY KEY CHECK (id = 1),
    -- Slot name to colour. An empty object is the instance on the built-in
    -- theme, which is a state the settings screen can reach and save.
    palette TEXT NOT NULL
      CHECK (json_valid(palette) AND json_type(palette) = 'object'),
    -- Who set it. A change to how the whole instance looks that appeared with
    -- no author is one nobody can be asked about.
    updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE TRIGGER instance_theme_colors_insert
    BEFORE INSERT ON instance_theme
    FOR EACH ROW WHEN ${paletteIsColors('NEW.palette')}
    BEGIN
      SELECT RAISE(ABORT, 'instance_theme.palette holds six-digit uppercase hex colours only');
    END`,
  `CREATE TRIGGER instance_theme_colors_update
    BEFORE UPDATE ON instance_theme
    FOR EACH ROW WHEN ${paletteIsColors('NEW.palette')}
    BEGIN
      SELECT RAISE(ABORT, 'instance_theme.palette holds six-digit uppercase hex colours only');
    END`,
] as const
