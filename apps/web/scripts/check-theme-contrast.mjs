// The AA gate for the shipped theme (D16 rev2 scope: "AA contrast check in
// CI"). The arithmetic and the requirement table already live in
// src/theme-contrast.ts; this is only the runner that gives them an exit code,
// because a rule nothing runs is decoration.
//
// It reads the compiled manifest rather than theme-tokens.json so that it gates
// exactly what the shell serves. Node strips the types on import, so there is
// no build step between editing a token and learning the answer.
//
// Both schemes answer to the same table: the dark scheme is held to every pair
// the light one is, because it paints the same rules.
import { checkThemeContrast, themeSchemes } from '../src/theme-contrast.ts'
import { generatedDefaultTheme, generatedThemes } from '../src/generated/theme-manifest.ts'

const failures = []
for (const { scheme, theme } of themeSchemes(generatedThemes[generatedDefaultTheme])) {
  const results = checkThemeContrast(theme)
  const report = results
    .map(
      (result) =>
        `${result.passes ? 'ok  ' : 'FAIL'} ${result.name}: ${result.ratio.toFixed(2)}:1 ` +
        `(needs ${result.minimum.toFixed(1)}:1)`,
    )
    .join('\n')
  process.stdout.write(`${generatedDefaultTheme} theme contrast, ${scheme} scheme\n${report}\n`)
  for (const result of results) {
    if (!result.passes) failures.push(`${result.name} (${scheme})`)
  }
}

if (failures.length > 0) {
  // Changing a brand colour to clear the bar is the owner's call, so the gate
  // states the shortfall and stops rather than suggesting a replacement.
  process.stdout.write(
    `::error::${generatedDefaultTheme} fails WCAG AA on ${failures.length} pair(s): ` +
      `${failures.join(', ')}\n`,
  )
  process.exitCode = 1
}
