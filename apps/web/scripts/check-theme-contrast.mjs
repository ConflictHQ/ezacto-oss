// The AA gate for the shipped theme (D16 rev2 scope: "AA contrast check in
// CI"). The arithmetic and the requirement table already live in
// src/theme-contrast.ts; this is only the runner that gives them an exit code,
// because a rule nothing runs is decoration.
//
// It reads the compiled manifest rather than theme-tokens.json so that it gates
// exactly what the shell serves. Node strips the types on import, so there is
// no build step between editing a token and learning the answer.
import { checkThemeContrast } from '../src/theme-contrast.ts'
import { generatedDefaultTheme, generatedThemes } from '../src/generated/theme-manifest.ts'

const results = checkThemeContrast(generatedThemes[generatedDefaultTheme])
const report = results
  .map(
    (result) =>
      `${result.passes ? 'ok  ' : 'FAIL'} ${result.name}: ${result.ratio.toFixed(2)}:1 ` +
      `(needs ${result.minimum.toFixed(1)}:1)`,
  )
  .join('\n')
process.stdout.write(`${generatedDefaultTheme} theme contrast\n${report}\n`)

const failures = results.filter((result) => !result.passes)
if (failures.length > 0) {
  // Changing a brand colour to clear the bar is the owner's call, so the gate
  // states the shortfall and stops rather than suggesting a replacement.
  process.stdout.write(
    `::error::${generatedDefaultTheme} fails WCAG AA on ${failures.length} pair(s): ` +
      `${failures.map((failure) => failure.name).join(', ')}\n`,
  )
  process.exitCode = 1
}
