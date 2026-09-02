import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
const packageManifest = fileURLToPath(new URL('../package.json', import.meta.url))

const typescriptFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map((entry) => {
    const path = `${directory}/${entry.name}`
    return entry.isDirectory()
      ? typescriptFiles(path)
      : Promise.resolve(entry.name.endsWith('.ts') ? [path] : [])
  }))
  return files.flat()
}

describe('database package layering', () => {
  it('[architecture] never imports the delivery-layer Mailer package', async () => {
    const files = await typescriptFiles(sourceRoot)
    const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')))
    const runtimeSources = sources.map((source) =>
      source.replace(/import\s+type\b[\s\S]*?\bfrom\s+['"][^'"]+['"]/gu, ''),
    )
    expect(runtimeSources.join('\n')).not.toMatch(
      /['"]@ezacto\/mailer(?:\/[^'"]*)?['"]/u,
    )
    const manifest = JSON.parse(await readFile(packageManifest, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies).not.toHaveProperty('@ezacto/mailer')
  })
})
