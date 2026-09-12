// Builds ezacto.dev into ./dist from the repository's own sources: the guides
// in docs/, the README, RESTORE.md and CONTRIBUTING.md, the CLI README, and the
// OpenAPI contract. Deterministic, no network, no client-side JavaScript.
import { mkdir, readdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const out = join(here, 'dist')
const site = 'https://ezacto.dev'

const escape = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Guides in the order the navigation lists them. */
const GUIDES = [
  ['self-host-worker', 'docs/self-host-worker.md', 'Self-host on Cloudflare Workers'],
  ['self-host-container', 'docs/self-host-container.md', 'Self-host in a container'],
  ['restore', 'RESTORE.md', 'Backup and restore'],
  ['migrating-from-harvest', 'docs/migrating-from-harvest.md', 'Migrating from Harvest'],
  ['migration-spec', 'docs/migration-spec.md', 'Migration specification'],
  ['api-contract', 'docs/api-contract.md', 'API contract'],
  ['domain-model', 'docs/domain-model.md', 'Domain model'],
  ['architecture', 'docs/architecture.md', 'Architecture'],
  ['infra', 'docs/infra.md', 'Infrastructure'],
  ['instance-theme', 'docs/instance-theme.md', 'Instance theme'],
  ['attachment-storage', 'docs/attachment-storage.md', 'Attachment storage'],
  ['quickbooks-setup', 'docs/quickbooks-setup.md', 'QuickBooks setup'],
  ['testing-strategy', 'docs/testing-strategy.md', 'Testing strategy'],
  ['cutover-runbook', 'docs/cutover-runbook.md', 'Cutover runbook'],
  ['contributing', 'CONTRIBUTING.md', 'Contributing'],
]

const slugFor = new Map()
for (const [slug, file] of GUIDES) slugFor.set(file.replace(/^docs\//, ''), slug)
slugFor.set('cli/README.md', 'cli')

/** Rewrite repository-relative markdown links into site paths. */
const rewriteLink = (href, fromFile) => {
  if (/^(https?:|mailto:|#)/.test(href)) return href
  const [path, hash = ''] = href.split('#')
  const target = path.replace(/^(\.\.\/|\.\/)+/, '').replace(/^docs\//, '')
  if (target === 'LICENSE') return 'https://github.com/ConflictHQ/ezacto-oss/blob/main/LICENSE'
  if (target === 'CLA.md' || target === 'contributors.md' || target === 'bootstrap.md' || target === 'PLAN.md') {
    return `https://github.com/ConflictHQ/ezacto-oss/blob/main/${target}`
  }
  if (target === 'openapi/ezacto-v1.openapi.json') return '/openapi/v1.json'
  if (target.startsWith('images/')) return `/docs/${target}`
  if (target.endsWith('.md')) {
    const slug = slugFor.get(target)
    if (slug) return `/docs/${slug}/${hash ? '#' + hash : ''}`
    return `https://github.com/ConflictHQ/ezacto-oss/blob/main/${fromFile.startsWith('docs/') && !path.startsWith('..') ? 'docs/' : ''}${target}`
  }
  return `https://github.com/ConflictHQ/ezacto-oss/blob/main/${target}`
}

const renderMarkdown = (markdown, fromFile) => {
  const renderer = new marked.Renderer()
  const link = renderer.link.bind(renderer)
  renderer.link = (token) => link({ ...token, href: rewriteLink(token.href, fromFile) })
  const image = renderer.image.bind(renderer)
  renderer.image = (token) => image({ ...token, href: rewriteLink(token.href, fromFile) })
  return marked.parse(markdown, { renderer, gfm: true })
}

const CSS = `
:root{--ground:#FFFFFF;--surface:#F5F6F7;--surface2:#EBEDEF;--line:#E3E5E8;--ink:#14161A;--muted:#676C74;--action:#16794A;--data:#2F5AE0;--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}html{color-scheme:light}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.6 "IBM Plex Sans",ui-sans-serif,system-ui,sans-serif}
a{color:var(--data);text-underline-offset:3px}
header{border-bottom:1px solid var(--line);background:var(--surface)}
.bar{max-width:1100px;margin:0 auto;padding:14px 24px;display:flex;gap:24px;align-items:center;flex-wrap:wrap}
.bar .name{font-weight:700;font-size:18px;color:var(--ink);text-decoration:none;letter-spacing:-.3px}
.bar nav{display:flex;gap:18px;font-size:14px}.bar nav a{color:var(--muted);text-decoration:none}.bar nav a[aria-current]{color:var(--ink);font-weight:600}
.bar .ext{margin-left:auto}
main{max-width:1100px;margin:0 auto;padding:24px;display:grid;grid-template-columns:240px minmax(0,1fr);gap:40px}
aside{font-size:14px}aside h2{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:18px 0 8px}
aside a{display:block;color:var(--muted);text-decoration:none;padding:3px 0}aside a[aria-current]{color:var(--ink);font-weight:600}
article{min-width:0}article h1{font-size:30px;letter-spacing:-.5px;margin:0 0 14px}article h2{font-size:21px;margin:34px 0 10px;padding-top:12px;border-top:1px solid var(--line)}article h3{font-size:16px;margin:24px 0 8px}
article p,article li{max-width:72ch}article code{font:13px var(--mono);background:var(--surface2);padding:1px 5px;border-radius:4px}
article pre{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:14px 16px;overflow:auto}article pre code{background:none;padding:0;font-size:13px}
article table{border-collapse:collapse;font-size:14px;margin:12px 0;display:block;overflow:auto}article th,article td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}article th{background:var(--surface)}
article img{max-width:100%;border:1px solid var(--line);border-radius:6px}
article blockquote{margin:0;padding:2px 16px;border-left:3px solid var(--line);color:var(--muted)}
.method{display:inline-block;font:700 11px/1 var(--mono);padding:4px 7px;border-radius:4px;color:#fff;background:var(--muted);vertical-align:middle;margin-right:8px}
.method.get{background:var(--action)}.method.post{background:var(--data)}.method.patch{background:#B7791F}.method.delete{background:#C92A2A}
.op{border:1px solid var(--line);border-radius:6px;padding:14px 16px;margin:12px 0}.op h3{margin:0 0 6px;font:500 15px var(--mono)}.op .summary{margin:0 0 8px;color:var(--muted)}
.op h4{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:12px 0 4px}
.schema{border-top:1px solid var(--line);padding-top:14px;margin-top:14px}.schema h3{font:500 15px var(--mono);margin:0 0 6px}
footer{max-width:1100px;margin:0 auto;padding:30px 24px;color:var(--muted);font-size:12px;border-top:1px solid var(--line)}
@media (max-width:820px){main{grid-template-columns:1fr}aside{border-bottom:1px solid var(--line);padding-bottom:12px}}
`

const NAV = [
  ['/docs/', 'Guides'],
  ['/api/', 'API'],
  ['/cli/', 'CLI'],
]

const layout = ({ title, description, path, body, sidebar = '' }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · ezacto developers</title>
<meta name="description" content="${escape(description)}">
<link rel="canonical" href="${site}${path}">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description)}">
<meta property="og:url" content="${site}${path}">
<meta property="og:type" content="article">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>${CSS}</style>
</head>
<body>
<header><div class="bar">
<a class="name" href="/">ezacto <span style="color:var(--muted);font-weight:400">developers</span></a>
<nav>${NAV.map(([href, label]) => `<a href="${href}"${path.startsWith(href) ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
<nav class="ext"><a href="https://github.com/ConflictHQ/ezacto-oss">GitHub</a><a href="https://ezacto.io/">Demo</a><a href="https://ezacto.com/">ezacto.com</a></nav>
</div></header>
<main>
<aside>${sidebar}</aside>
<article>${body}</article>
</main>
<footer>ezacto is free software under the GNU AGPL v3, copyright CONFLICT LLC. This site is built from the repository at every release.</footer>
</body>
</html>
`

const guideSidebar = (current) => `
<h2>Guides</h2>
${GUIDES.map(([slug, , title]) => `<a href="/docs/${slug}/"${current === slug ? ' aria-current="page"' : ''}>${escape(title)}</a>`).join('\n')}
<h2>Reference</h2>
<a href="/api/">API reference</a>
<a href="/openapi/v1.json">OpenAPI document</a>
<a href="/cli/">ez CLI</a>
`

const firstParagraph = (markdown) => {
  const lines = markdown.split('\n')
  let i = 0
  while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('#'))) i += 1
  const para = []
  while (i < lines.length && lines[i].trim() !== '') para.push(lines[i++].trim())
  return para.join(' ').replace(/[`*_\[\]]/g, '').replace(/\([^)]*\)/g, '').slice(0, 300)
}

const stripTitle = (markdown) => markdown.replace(/^# .*\n+/, '')

/** The API reference, rendered statically from the contract. */
const apiPage = (openapi) => {
  const byTag = new Map()
  for (const [path, methods] of Object.entries(openapi.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const tag = op.tags?.[0] ?? 'other'
      if (!byTag.has(tag)) byTag.set(tag, [])
      byTag.get(tag).push({ path, method, op })
    }
  }
  const schemaName = (schema) => schema?.$ref?.split('/').pop() ?? null
  const refLink = (schema) => {
    const name = schemaName(schema)
    return name ? `<a href="#schema-${name}"><code>${escape(name)}</code></a>` : '<code>—</code>'
  }
  const paramRows = (params = []) =>
    params
      .map(
        (p) =>
          `<tr><td><code>${escape(p.name)}</code></td><td>${p.in}</td><td>${p.required ? 'yes' : ''}</td><td><code>${escape(
            p.schema?.type ?? '',
          )}${p.schema?.enum ? ': ' + p.schema.enum.join(' | ') : ''}</code></td></tr>`,
      )
      .join('')
  const sections = [...byTag.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, ops]) => {
      const list = ops
        .map(({ path, method, op }) => {
          const responses = Object.entries(op.responses ?? {})
            .filter(([code]) => code.startsWith('2'))
            .map(([code, r]) => `${code} ${refLink(r.content?.['application/json']?.schema)}`)
            .join(', ')
          const body = op.requestBody?.content
          const bodySchema = body ? Object.values(body)[0]?.schema : null
          const auth = (op.security ?? openapi.security ?? []).map((s) => Object.keys(s)[0]).join(' or ') || 'none'
          return `<div class="op" id="${escape(op.operationId ?? method + path)}">
<h3><span class="method ${method}">${method.toUpperCase()}</span>${escape(path)}</h3>
<p class="summary">${escape(op.summary ?? '')}</p>
${op.description ? `<div>${marked.parse(op.description)}</div>` : ''}
${op.parameters?.length ? `<h4>Parameters</h4><table><tr><th>name</th><th>in</th><th>required</th><th>type</th></tr>${paramRows(op.parameters)}</table>` : ''}
${bodySchema ? `<h4>Request body</h4><p>${refLink(bodySchema)}${op.requestBody.required ? ' (required)' : ''}</p>` : ''}
<h4>Responses</h4><p>${responses || '204 no content'}</p>
<h4>Authentication</h4><p><code>${escape(auth)}</code></p>
</div>`
        })
        .join('\n')
      return `<h2 id="tag-${escape(tag)}">${escape(tag)}</h2>\n${list}`
    })
    .join('\n')

  const schemas = Object.entries(openapi.components?.schemas ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, schema]) => {
      const props = Object.entries(schema.properties ?? {})
        .map(([prop, def]) => {
          const type =
            def.$ref ? refLink(def) :
            def.enum ? `<code>${def.enum.map(escape).join(' | ')}</code>` :
            def.anyOf ? def.anyOf.map((d) => (d.$ref ? refLink(d) : `<code>${escape(d.type ?? 'null')}</code>`)).join(' | ') :
            def.type === 'array' ? `array of ${def.items?.$ref ? refLink(def.items) : `<code>${escape(def.items?.type ?? 'any')}</code>`}` :
            `<code>${escape(def.type ?? 'any')}${def.format ? ' (' + escape(def.format) + ')' : ''}</code>`
          const required = (schema.required ?? []).includes(prop) ? 'yes' : ''
          return `<tr><td><code>${escape(prop)}</code></td><td>${type}</td><td>${required}</td></tr>`
        })
        .join('')
      return `<div class="schema" id="schema-${escape(name)}"><h3>${escape(name)}</h3>${
        schema.description ? `<p>${escape(schema.description)}</p>` : ''
      }${props ? `<table><tr><th>field</th><th>type</th><th>required</th></tr>${props}</table>` : `<p><code>${escape(JSON.stringify(schema).slice(0, 200))}</code></p>`}</div>`
    })
    .join('\n')

  const tagIndex = [...byTag.keys()].sort().map((t) => `<a href="#tag-${escape(t)}">${escape(t)}</a>`).join('\n')
  const body = `<h1>API reference</h1>
<p>${escape(openapi.info.description ?? '')} Version ${escape(openapi.info.version)}. The machine-readable document is at <a href="/openapi/v1.json">/openapi/v1.json</a>; the same JSON is served by every running instance at <code>/openapi/v1.json</code>. Read <a href="/docs/api-contract/">the API contract</a> first for errors, cursors and money-field redaction.</p>
<p>Authenticate with a bearer API token (<code>Authorization: Bearer ezacto_…</code>, issued under <em>Settings → API tokens</em>, scoped) or a browser session cookie. Operations marked <code>cookieSession</code> only cannot be called with a token.</p>
${sections}
<h2 id="schemas">Schemas</h2>
${schemas}`
  const sidebar = `<h2>Tags</h2>${tagIndex}<h2>Reference</h2><a href="#schemas">Schemas</a><a href="/openapi/v1.json">OpenAPI document</a><a href="/cli/">ez CLI</a>`
  return layout({
    title: 'API reference',
    description: `Every ${Object.keys(openapi.paths).length} path of the ezacto v1 API, rendered from the OpenAPI contract.`,
    path: '/api/',
    body,
    sidebar,
  })
}

const build = async () => {
  await rm(out, { recursive: true, force: true })
  await mkdir(join(out, 'docs', 'images'), { recursive: true })
  await mkdir(join(out, 'api'), { recursive: true })
  await mkdir(join(out, 'cli'), { recursive: true })
  await mkdir(join(out, 'openapi'), { recursive: true })
  const pages = []

  // Guides
  for (const [slug, file, title] of GUIDES) {
    const markdown = await readFile(join(root, file), 'utf8')
    const html = layout({
      title,
      description: firstParagraph(markdown),
      path: `/docs/${slug}/`,
      body: `<h1>${escape(title)}</h1>${renderMarkdown(stripTitle(markdown), file)}`,
      sidebar: guideSidebar(slug),
    })
    await mkdir(join(out, 'docs', slug), { recursive: true })
    await writeFile(join(out, 'docs', slug, 'index.html'), html)
    pages.push(`/docs/${slug}/`)
  }
  for (const image of await readdir(join(root, 'docs', 'images'), { recursive: true })) {
    const source = join(root, 'docs', 'images', image)
    if ((await readdir(dirname(source))).length && /\.(png|jpe?g|webp|svg|gif)$/i.test(image)) {
      await mkdir(dirname(join(out, 'docs', 'images', image)), { recursive: true })
      await copyFile(source, join(out, 'docs', 'images', image))
    }
  }

  // Guides index
  const guidesBody = `<h1>Guides</h1><p>Everything needed to run, operate, migrate to and extend ezacto, from the repository's own documentation.</p><ul>${GUIDES.map(
    ([slug, , title]) => `<li><a href="/docs/${slug}/">${escape(title)}</a></li>`,
  ).join('')}</ul>`
  await writeFile(
    join(out, 'docs', 'index.html'),
    layout({ title: 'Guides', description: 'Self-hosting, backup and restore, migrating from Harvest, and the design documents.', path: '/docs/', body: guidesBody, sidebar: guideSidebar('') }),
  )
  pages.push('/docs/')

  // API
  const openapi = JSON.parse(await readFile(join(root, 'openapi', 'ezacto-v1.openapi.json'), 'utf8'))
  await writeFile(join(out, 'api', 'index.html'), apiPage(openapi))
  await writeFile(join(out, 'openapi', 'v1.json'), JSON.stringify(openapi, null, 2))
  pages.push('/api/')

  // CLI
  const cliReadme = await readFile(join(root, 'packages', 'cli', 'README.md'), 'utf8')
  await writeFile(
    join(out, 'cli', 'index.html'),
    layout({
      title: 'ez CLI',
      description: firstParagraph(cliReadme),
      path: '/cli/',
      body: `<h1>ez, the command line</h1>${renderMarkdown(stripTitle(cliReadme), 'cli/README.md')}`,
      sidebar: guideSidebar(''),
    }),
  )
  pages.push('/cli/')

  // Home: the README's opening and licence, then the map of the site.
  const readme = await readFile(join(root, 'README.md'), 'utf8')
  const intro = readme.split(/\n## /)[0].replace(/^# .*\n+/, '')
  const licence = readme.match(/\n## Licence\n([\s\S]*?)(?=\n## |\s*$)/)?.[1] ?? ''
  const home = layout({
    title: 'ezacto developers',
    description: 'Self-host, integrate with, and contribute to ezacto: guides, the v1 API reference and the ez CLI.',
    path: '/',
    body: `<h1>Build on ezacto</h1>${renderMarkdown(intro, 'README.md')}
<h2>Start here</h2>
<ul>
<li><a href="/docs/self-host-worker/">Self-host on Cloudflare Workers</a> or <a href="/docs/self-host-container/">in a single container</a></li>
<li><a href="/docs/migrating-from-harvest/">Migrate from Harvest</a></li>
<li><a href="/api/">API reference</a> and the <a href="/openapi/v1.json">OpenAPI document</a></li>
<li><a href="/cli/">ez CLI</a></li>
<li><a href="https://github.com/ConflictHQ/ezacto-oss">Source on GitHub</a>, <a href="https://github.com/ConflictHQ/ezacto-portal-oss">the client portal</a></li>
</ul>
<h2>Licence</h2>${renderMarkdown(licence, 'README.md')}`,
    sidebar: guideSidebar(''),
  })
  await writeFile(join(out, 'index.html'), home)
  pages.push('/')

  await writeFile(
    join(out, '404.html'),
    layout({ title: 'Not found', description: 'No such page.', path: '/404', body: '<h1>Not found</h1><p>No such page. <a href="/">Start at the front.</a></p>', sidebar: guideSidebar('') }),
  )
  await writeFile(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${site}/sitemap.xml\n`)
  await writeFile(
    join(out, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
      .sort()
      .map((p) => `  <url><loc>${site}${p}</loc></url>`)
      .join('\n')}\n</urlset>\n`,
  )
  await writeFile(
    join(out, 'llms.txt'),
    `# ezacto developers\n\n> Guides, API reference and CLI for ezacto, the open-source time tracking and invoicing app (GNU AGPL v3, CONFLICT LLC).\n\n## Guides\n\n${GUIDES.map(
      ([slug, , title]) => `- [${title}](${site}/docs/${slug}/)`,
    ).join('\n')}\n\n## Reference\n\n- [API reference](${site}/api/): every v1 path, from the OpenAPI contract\n- [OpenAPI document](${site}/openapi/v1.json)\n- [ez CLI](${site}/cli/)\n\n## Source\n\n- [ezacto](https://github.com/ConflictHQ/ezacto-oss)\n- [ezacto-portal](https://github.com/ConflictHQ/ezacto-portal-oss)\n`,
  )
  console.log(`built ${pages.length} pages into ${out}`)
}

await build()
