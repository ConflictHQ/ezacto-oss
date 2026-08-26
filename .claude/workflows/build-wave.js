export const meta = {
  name: 'build-wave',
  description: 'Fleet dispatcher: run N groomed stories through story-sdlc.js as a pipeline (shared budget, per-story worktrees)',
  whenToUse: 'Invoke with args {stories: ["specs/.../01-story.md", ...], autoMerge?: false}',
  phases: [{ title: 'Wave' }],
}
const stories = (args && args.stories) || []
if (!stories.length) return { error: 'args.stories required: list of story .md paths' }
const autoMerge = !!(args && args.autoMerge)
phase('Wave')
log(`wave: ${stories.length} stories, autoMerge=${autoMerge}`)
const results = await pipeline(stories, (s) =>
  workflow({ scriptPath: '.claude/workflows/story-sdlc.js' }, { storyPath: s, autoMerge }))
const rows = results.map((r, i) => ({ story: stories[i], ...(r || { status: 'skipped-or-failed' }) }))
const done = rows.filter(r => r.status === 'done').length
const ready = rows.filter(r => r.status === 'pr-ready').length
const parked = rows.filter(r => r.status === 'parked' || String(r.status).startsWith('blocked'))
if (parked.length) log(`ATTENTION: ${parked.length} stories parked/blocked — file open questions, do not retry blindly`)
return { done, pr_ready: ready, parked: parked, rows }
