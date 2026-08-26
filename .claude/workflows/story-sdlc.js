export const meta = {
  name: 'story-sdlc',
  description: 'One groomed story end-to-end: triage, research, plan, build, test, adversary, review, ship (PR), optional merge+validate+close',
  whenToUse: 'Invoked per story by build-wave.js, or standalone with args {storyPath, autoMerge?, issue?}',
  phases: [
    { title: 'Triage' }, { title: 'Research' }, { title: 'Plan' },
    { title: 'Build' }, { title: 'Test' }, { title: 'Adversary' },
    { title: 'Review' }, { title: 'Ship' }, { title: 'Wrap' },
  ],
}

// ---- routing (knowledge/docs/agentic-sdlc.md is the contract) ----
const MENIAL = { model: 'haiku', effort: 'low' }
const STANDARD = { model: 'sonnet', effort: 'medium' }
const HARD = { model: 'opus', effort: 'high' }
const CRITICAL = { model: 'opus', effort: 'xhigh' }
const CRITICAL_LABELS = ['money', 'auth', 'migration', 'invariants']
const buildTier = (est) => (est === 'L' || est === 'XL' || est === 'XXL') ? HARD : STANDARD
const upTier = (t) => t === MENIAL ? STANDARD : t === STANDARD ? HARD : CRITICAL
const guard = (need) => { if (budget.total && budget.remaining() < need) throw new Error(`budget guard: <${need} tokens left`) }

// ---- schemas ----
const TRIAGE = { type:'object', required:['ready','estimate','labels','summary'], properties:{
  ready:{type:'boolean'}, estimate:{type:'string'}, labels:{type:'array',items:{type:'string'}},
  blockers:{type:'array',items:{type:'string'}}, issue:{type:'string'}, summary:{type:'string'}, story_id:{type:'string'} } }
const PACK = { type:'object', required:['context_summary','files','constraints'], properties:{
  context_summary:{type:'string'}, files:{type:'array',items:{type:'string'}},
  constraints:{type:'array',items:{type:'string'}}, prior_art:{type:'array',items:{type:'string'}} } }
const PLAN = { type:'object', required:['steps','test_plan'], properties:{
  steps:{type:'array',items:{type:'string'}}, test_plan:{type:'array',items:{type:'string'}}, risks:{type:'array',items:{type:'string'}} } }
const BUILT = { type:'object', required:['ok','worktree','branch','files_changed','gates'], properties:{
  ok:{type:'boolean'}, worktree:{type:'string'}, branch:{type:'string'},
  files_changed:{type:'array',items:{type:'string'}}, gates:{type:'object'}, notes:{type:'string'} } }
const TESTED = { type:'object', required:['pass','ac_coverage'], properties:{
  pass:{type:'boolean'}, ac_coverage:{type:'array',items:{type:'string'}}, failures:{type:'array',items:{type:'string'}} } }
const FINDINGS = { type:'object', required:['findings'], properties:{
  findings:{type:'array',items:{type:'object',required:['severity','desc'],properties:{
    severity:{type:'string'}, desc:{type:'string'}, repro:{type:'string'} }}} } }
const VERDICT = { type:'object', required:['verdict'], properties:{
  verdict:{type:'string'}, items:{type:'array',items:{type:'string'}} } }
const SHIPPED = { type:'object', required:['pr_url'], properties:{ pr_url:{type:'string'}, ci:{type:'string'} } }

const storyPath = args && args.storyPath
if (!storyPath) return { error: 'args.storyPath required (path to the story .md, repo-relative or absolute)' }
const autoMerge = !!(args && args.autoMerge)
const RULES = 'Standing rules: no rebases; no AI attribution in commits/PRs; surgical diffs; no stubs — a story is done when it is real; a red gate is fixed, never bypassed; secrets never in git.'

// 1 — Triage (MENIAL)
phase('Triage')
const tri = await agent(
  `You are a triage clerk. Read the story file at ${storyPath}. Verify it conforms to the story standard: has '## Acceptance' checkboxes, an 'estimate' in frontmatter, and its depends_on entries are status done/absent (check specs/manifest.json if present). Extract labels + estimate for routing, and the tracker issue number if referenced. Do NOT judge the design. ready=false with blockers[] if anything is missing.`,
  { ...MENIAL, phase: 'Triage', label: 'triage', schema: TRIAGE })
if (!tri || !tri.ready) return { status: 'blocked-at-triage', story: storyPath, blockers: tri ? tri.blockers : ['triage agent failed'] }
const critical = (tri.labels || []).some(l => CRITICAL_LABELS.includes(l))
const tier = buildTier(tri.estimate)
log(`triage ok: ${tri.story_id || storyPath} [${tri.estimate}] labels=${(tri.labels||[]).join(',')} critical=${critical}`)

// 2 — Research (STANDARD low)
phase('Research')
const pack = await agent(
  `You are a researcher assembling a context pack for an implementer. Story: ${storyPath} (summary: ${tri.summary}). Read the story's References/depends_on, the relevant sections of docs/domain-model.md, docs/migration-spec.md, docs/architecture.md and existing code in this repo. Output: what exists already, the exact files to touch or imitate, and hard constraints (deviations DV-1..13, invariants touched, theme slot rules). NO code.`,
  { model: 'sonnet', effort: 'low', phase: 'Research', label: 'research', schema: PACK })

// 3 — Plan (by estimate)
phase('Plan')
const plan = await agent(
  `You are a software architect. Write a file-level implementation plan for story ${storyPath}.\nContext pack: ${JSON.stringify(pack)}\nEvery '## Acceptance' checkbox must map to at least one test in test_plan. Prefer reuse named in prior_art. Plan the SMALLEST diff that makes every AC true. ${RULES}`,
  { ...tier, phase: 'Plan', label: 'plan', schema: PLAN })

// 4..7 — Build / Test / Adversary / Review with fix-loops in ONE shared worktree
guard(60000)
phase('Build')
let built = await agent(
  `You are a senior implementer. Execute this plan for story ${storyPath}:\n${JSON.stringify(plan)}\nContext: ${JSON.stringify(pack)}\nFirst create a shared workspace: git worktree add ../ez-wt-${tri.story_id || 'story'} -b feat/${tri.story_id || 'story'} (reuse if it exists). Do ALL work inside that worktree. Implement fully (no stubs), run lint+typecheck until green, commit surgically with plain messages. Return the worktree path, branch, files, gate results. ${RULES}`,
  { ...tier, phase: 'Build', label: 'build', schema: BUILT })
if (!built || !built.ok) return { status: 'blocked-at-build', story: storyPath, notes: built && built.notes }

let fixTier = tier
for (let round = 0; round < 3; round++) {
  guard(40000)
  phase('Test')
  const tested = await agent(
    `You are a QA engineer in worktree ${built.worktree} (branch ${built.branch}). For story ${storyPath}: ensure EVERY '## Acceptance' checkbox has at least one automated test (write missing ones), then run the suite. Report ac_coverage as 'AC text -> test name'. ${RULES}`,
    { ...STANDARD, phase: 'Test', label: `test r${round}`, schema: TESTED })
  let problems = (tested && !tested.pass) ? [`tests failing: ${(tested.failures||[]).join('; ')}`] : []

  if (problems.length === 0) {
    phase('Adversary')
    const lenses = ['correctness (wrong output, state machines, rounding)', 'security (authz, tenancy, injection, secrets)', 'edge cases + domain invariants 1-14']
    const adv = await Promise.all(lenses.map((lens, i) => agent(
      `You are a skeptic. Try to BREAK the changes on branch ${built.branch} in worktree ${built.worktree} through the lens of ${lens}. Story: ${storyPath}. Read the diff and tests; attempt concrete refutations. Report only real findings with severity blocker|major|minor and repro.`,
      { ...(critical ? CRITICAL : HARD), phase: 'Adversary', label: `adv:${i}`, schema: FINDINGS })))
    const blockers = adv.filter(Boolean).flatMap(a => a.findings).filter(f => f.severity === 'blocker' || f.severity === 'major')
    if (blockers.length) problems = blockers.map(b => `${b.severity}: ${b.desc}`)
  }

  if (problems.length === 0) {
    phase('Review')
    const rev = await agent(
      `You are a code reviewer. In worktree ${built.worktree}, review branch ${built.branch} against story ${storyPath}: (1) every AC objectively satisfied, (2) every changed line traces to the story, (3) reuse/simplicity, (4) tests are real. Verdict approve|request_changes with items. ${RULES}`,
      { ...(critical ? CRITICAL : HARD), phase: 'Review', label: `review r${round}`, schema: VERDICT })
    if (rev && rev.verdict === 'approve') { problems = [] ; break }
    problems = (rev && rev.items) || ['review failed with no items']
  }

  if (round === 2) return { status: 'parked', story: storyPath, worktree: built.worktree, problems,
    action: 'open question filed by wave report; worktree left for a human' }
  fixTier = upTier(fixTier)
  phase('Build')
  built = await agent(
    `You are a senior implementer FIXING findings in worktree ${built.worktree} (branch ${built.branch}), story ${storyPath}. Findings to resolve:\n- ${problems.join('\n- ')}\nSmallest honest fix for each; lint+typecheck green; commit. ${RULES}`,
    { ...fixTier, phase: 'Build', label: `fix r${round}`, schema: BUILT }) || built
}

// 8/9 — Ship (+ optional merge), 10/11 — validate + close
phase('Ship')
const shipped = await agent(
  `You are release ceremony. From worktree ${built.worktree}: push branch ${built.branch}; open ONE PR for the whole story ${storyPath} with gh — title from the story title, body: what/why/how-verified + 'Closes #${tri.issue || ''}'. NO AI attribution, no Co-Authored-By. Report pr_url and CI status if visible.`,
  { ...MENIAL, phase: 'Ship', label: 'pr', schema: SHIPPED })
if (!autoMerge) return { status: 'pr-ready', story: storyPath, pr: shipped && shipped.pr_url, branch: built.branch, worktree: built.worktree }

phase('Wrap')
const wrap = await agent(
  `Merge-and-close ceremony for ${shipped && shipped.pr_url} (story ${storyPath}). Preconditions you MUST verify: CI green + review approved. Then: merge with a merge commit or squash (NEVER rebase), remove worktree ${built.worktree}, run the test suite on main (report result), close issue #${tri.issue || '?'} with a what/why/verified summary. If any precondition fails, do nothing and report why.`,
  { ...STANDARD, phase: 'Wrap', label: 'merge+validate+close' })
return { status: 'done', story: storyPath, pr: shipped && shipped.pr_url, wrap }
