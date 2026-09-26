export const meta = {
  name: 'load-ms-phase',
  description: 'Load MS roadmap phase: implementation tracks, two adversarial review rounds with cheaper refuters, fixes, browser smoke, completeness gate',
  phases: [
    { title: 'Logic tracks', detail: 'independent src/lib tracks in parallel (session model)' },
    { title: 'UI integration', detail: 'App.jsx track fed with the lib reports (session model)' },
    { title: 'Review', detail: 'adversarial reviewers on Opus + browser smoke on Sonnet', model: 'opus' },
    { title: 'Verify', detail: '2 refuters per finding on Sonnet', model: 'sonnet' },
    { title: 'Fix', detail: 'one fixer per round (session model)' },
    { title: 'Gate', detail: 'completeness critic (session model)' },
  ],
}

// Reusable phase workflow for Load MS. Run with:
//   Workflow({ scriptPath: '.claude/workflows/load-ms-phase.js', args: { ... } })
// args is a JSON object (never a string):
// {
//   phase: 'H2',
//   branch: 'claude/h2-...',                 // already checked out
//   handoffSections: '3, 6, 9, 15 and 16 (Phase H2)',
//   logicTracks: [                            // run in parallel, each owns disjoint files under src/lib + scripts
//     { key: 'A', label: 'engine', prompt: 'Files you own: ... Implement, each with a fixture: 1. ... 2. ...' },
//   ],
//   uiTrack: { label: 'app', prompt: 'Files you own: src/App.jsx ... Implement: 1. ...' },   // optional
//   lenses: [ { title: 'progression correctness', detail: 'Focus: ...' }, ... ],           // reviewers
//   smokeSteps: [ '1. Dashboard loads, no console errors.', '2. ...' ],                     // browser script
//   gate: 'Compare the tree against handoff section 16 (H2) deliverables, scenarios ..., every docs/decisions.md row.',
//   rounds: 2                                                                               // review rounds (default 2)
// }
//
// Model policy (cost): tracks, fixer and critic inherit the session model (Fable);
// reviewers run on Opus (round 1 high effort, round 2 medium); refuters and the
// browser smoke tester run on Sonnet. Change MODELS below to adjust.
const MODELS = { reviewer: 'opus', refuter: 'sonnet', smoke: 'sonnet' }

if (!args || !Array.isArray(args.logicTracks) || !args.phase || !args.branch) {
  throw new Error('args required: { phase, branch, logicTracks[], uiTrack?, lenses[], smokeSteps[], gate, handoffSections, rounds? }')
}

const CWD = 'C:\\Users\\rares\\OneDrive\\Documents\\siteuri\\load ms'
const ROUNDS = args.rounds || 2

const COMMON = `
Project: Load MS / RPE Tracker at ${CWD} (Windows; use the Bash tool with forward-slash paths under /c/Users/rares/OneDrive/Documents/siteuri/load\\ ms, or PowerShell). Branch: ${args.branch} (already checked out). React 19 + Vite 8 + Tailwind 4 PWA, plain JavaScript/JSX, localStorage only, no backend.

MUST READ FIRST (in this order): CLAUDE.md, docs/decisions.md, then LOAD_MS_CLAUDE_HANDOFF.md sections ${args.handoffSections || '3, 6, 15 and 16'}. docs/decisions.md wins over the handoff where they differ.

Git rules: NEVER run git commit, checkout, stash, reset, clean or switch. Other agents are editing other files in the same working tree at the same time, so only touch the files you own (listed below). If you believe a change is needed in a file you do not own, describe it precisely in your report instead of editing it.

Verification: \`npm test\` runs every scripts/verify-*.mjs. \`npm run build\` must stay green. Verification scripts are deterministic Node scripts using node:assert/strict and in-memory stubs (see scripts/verify-storage-safety.mjs for the MemoryLocalStorage pattern). Every behaviour you change or add needs a fixture that fails before and passes after. If a script owned by another track fails because of their in-progress work, report it, do not fix it.

Your final message IS the return value: return only the structured report requested, no prose for a human.
`

const TRACK_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    apiChanges: { type: 'array', items: { type: 'string' }, description: 'Every new/changed export with signature and semantics, so the UI track can use it' },
    behaviourChanges: { type: 'array', items: { type: 'string' } },
    testsRun: { type: 'array', items: { type: 'string' }, description: 'commands actually run and their result' },
    unverified: { type: 'array', items: { type: 'string' } },
    requestsForOtherFiles: { type: 'array', items: { type: 'string' }, description: 'changes needed in files you do not own' },
  },
  required: ['summary', 'filesChanged', 'apiChanges', 'behaviourChanges', 'testsRun', 'unverified', 'requestsForOtherFiles'],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          description: { type: 'string' },
          repro: { type: 'string', description: 'concrete input/state -> wrong output; or the exact command/steps' },
        },
        required: ['title', 'file', 'line', 'severity', 'description', 'repro'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['refuted', 'reason'],
}

const GATE_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    missing: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, detail: { type: 'string' }, file: { type: 'string' } }, required: ['item', 'detail'] } },
    notes: { type: 'string' },
  },
  required: ['passed', 'missing', 'notes'],
}

const SMOKE_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    steps: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['name', 'ok', 'detail'] } },
    consoleErrors: { type: 'array', items: { type: 'string' } },
  },
  required: ['passed', 'steps', 'consoleErrors'],
}

// ---------------------------------------------------------------- prompts
function logicTrackPrompt(track) {
  return `${COMMON}
You are TRACK ${track.key}: ${track.label}. ${track.prompt}

Then: run npm test and npm run build. Update existing fixtures only where the old expectation is now wrong by decision (say which in the report). Report with the schema; apiChanges must list every new export with exact signature and return shape.`
}

function uiTrackPrompt(ui, reports) {
  const context = reports.map((r) => `TRACK ${r.key} (${r.label}): ${JSON.stringify(r.report)}`).join('\n')
  return `${COMMON}
You are the UI TRACK: ${ui.label}. ${ui.prompt}

The logic tracks already finished. Their reports (use these APIs, do not reinvent):
${context}

Keep the UI broadly intact (fix affected surfaces only; same dark zinc/lime style, same component patterns as neighbours). All copy in English.

Run npm test and npm run build; both must pass. Then do a quick manual check in the in-app browser (ToolSearch "browser" tools; the preview server is already running at http://localhost:5173; the pane viewport is tiny, so drive with javascript_tool clicks and assert with get_page_text). Report what you actually saw. Report with the schema.`
}

function reviewerPrompt(lens, reports, round, fixReports) {
  const roundNote = round > 1 ? `
This is review round ${round}. A fixer already addressed the round-${round - 1} findings; its report: ${JSON.stringify(fixReports)}. Focus on regressions introduced by those fixes and on anything still open; do not re-report items the fixer marked fixed unless you reproduce them again on the current tree.
` : ''
  const context = reports.map((r) => `TRACK ${r.key} (${r.label}): ${JSON.stringify(r.report)}`).join('\n')
  return `${COMMON}${roundNote}
You are an adversarial REVIEWER with the lens: ${lens.title}. Do not edit any file. Read the current code (git diff main...HEAD plus the files touched) and the implementation reports:
${context}

${lens.detail}

Actively try to break it: write throwaway Node probes (in the scratch dir C:\\Users\\rares\\AppData\\Local\\Temp\\claude, not in the repo) that import the modules and feed edge cases; run npm test and npm run build yourself (each Bash command with a timeout under 120 s; npm test at most once). Every finding needs a concrete repro. Report only real defects, regressions or unmet phase ${args.phase} gate items, ranked by severity. Zero findings is a valid answer.`
}

function refuterPrompt(f, i) {
  return `${COMMON}
You are REFUTER #${i + 1}. Another reviewer claims this defect exists in the current working tree:
${JSON.stringify(f)}

Try hard to REFUTE it: read the code, run a probe from the scratch dir, run the relevant verify script. Refute if the repro does not reproduce, if the behaviour is actually intended by docs/decisions.md or the handoff, or if it is purely stylistic. Default to refuted=true if you cannot reproduce it. Do not edit repo files.`
}

function fixerPrompt(findings, reports, round) {
  const context = reports.map((r) => `TRACK ${r.key}: ${JSON.stringify(r.report.summary)}`).join(' / ')
  return `${COMMON}
You are the FIXER (round ${round}). You own every source file in this repo for this task. Confirmed defects to fix, each verified by independent reviewers:
${JSON.stringify(findings, null, 2)}

Implementation context: ${context}.

For each: fix the root cause, add or extend a verify fixture so it cannot regress, keep decisions.md rules, and record any new product decision as a new row in docs/decisions.md. If a finding is wrong after all, say so with evidence and skip it. Finish with npm test and npm run build green. Report with the schema (behaviourChanges = one line per finding: fixed/skipped + why).`
}

function criticPrompt(reports, fixes) {
  const context = reports.map((r) => `TRACK ${r.key}: ${JSON.stringify(r.report)}`).join('; ')
  return `${COMMON}
You are the COMPLETENESS CRITIC. Do not edit files. ${args.gate || `Compare the current working tree against the Phase ${args.phase} deliverables and gate in LOAD_MS_CLAUDE_HANDOFF.md section 16 and every row of docs/decisions.md.`}
Implementation reports: ${context}; fixes ${JSON.stringify(fixes)}.
For each deliverable/scenario/decision say whether it is implemented AND covered by a verify fixture. List what is missing or only partially done with the file that should change. Run npm test and npm run build and include the result in notes. passed=true only if nothing material is missing.`
}

function smokePrompt(round) {
  const roundNote = round > 1 ? `
This is smoke round ${round}, after a fix round; the tree has changed since round 1.
` : ''
  const steps = (args.smokeSteps || []).join('\n')
  return `${COMMON}${roundNote}
You are the BROWSER SMOKE tester. Do not edit repo files. Use the in-app browser tools (load them with ToolSearch: mcp__Claude_Browser__navigate, javascript_tool, get_page_text, find, read_console_messages, computer). The Vite dev server is already running at http://localhost:5173 (if navigate fails, start it with preview_start name "dev"). The pane viewport is tiny, so click via javascript_tool (document.querySelector / find buttons by textContent then .click()) and assert with get_page_text; screenshots are optional.

Start clean: run localStorage.clear() via javascript_tool and reload. Then walk this script and record each step:
${steps}
Report every step with what you actually observed and all console errors.`
}

// ================================================================= RUN
log(`Phase ${args.phase}: ${args.logicTracks.length} logic track(s) in parallel`)
const logicResults = await parallel(args.logicTracks.map((track) => () =>
  agent(logicTrackPrompt(track), { label: `track:${track.key} ${track.label}`, phase: 'Logic tracks', schema: TRACK_SCHEMA, effort: 'high' })
    .then((report) => report && { key: track.key, label: track.label, report })))
const reports = logicResults.filter(Boolean)
if (reports.length !== args.logicTracks.length) throw new Error('A logic track failed: ' + JSON.stringify(logicResults.map(Boolean)))

if (args.uiTrack) {
  log('UI integration track')
  phase('UI integration')
  const ui = await agent(uiTrackPrompt(args.uiTrack, reports), { label: `track:UI ${args.uiTrack.label}`, phase: 'UI integration', schema: TRACK_SCHEMA, effort: 'high' })
  if (!ui) throw new Error('UI track failed')
  reports.push({ key: 'UI', label: args.uiTrack.label, report: ui })
}

const fixReports = []
let confirmedAll = []
for (let round = 1; round <= ROUNDS; round++) {
  log(`Round ${round}: review (Opus) + smoke (Sonnet)`)
  const reviewResults = await parallel([
    ...(args.lenses || []).map((lens) => () => agent(reviewerPrompt(lens, reports, round, fixReports), { label: `review:${lens.title}`, phase: 'Review', schema: FINDINGS_SCHEMA, model: MODELS.reviewer, effort: round === 1 ? 'high' : 'medium' })),
    () => agent(smokePrompt(round), { label: 'smoke:browser', phase: 'Review', schema: SMOKE_SCHEMA, model: MODELS.smoke, effort: 'medium' }),
  ])
  const smoke = reviewResults[reviewResults.length - 1]
  const found = reviewResults.slice(0, -1).filter(Boolean).flatMap((r) => r.findings)
  const smokeFindings = smoke ? smoke.steps.filter((s) => !s.ok).map((s) => ({ title: `Smoke: ${s.name}`, file: 'src/App.jsx', line: 1, severity: 'high', description: s.detail, repro: `Browser step "${s.name}" at http://localhost:5173` })) : []
  if (smoke && smoke.consoleErrors.length) smokeFindings.push({ title: 'Smoke: console errors', file: 'src/App.jsx', line: 1, severity: 'medium', description: smoke.consoleErrors.join('\n'), repro: 'Open http://localhost:5173 and run the smoke script' })
  if (!smoke) log(`Round ${round}: smoke tester returned nothing (skipped or failed); no smoke findings recorded`)
  log(`Round ${round}: ${found.length} review findings, ${smokeFindings.length} smoke findings`)

  const verified = await pipeline(found, (f, _item, i) =>
    parallel([0, 1].map((k) => () => agent(refuterPrompt(f, k), { label: `refute:${round}.${i}.${k}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: MODELS.refuter, effort: 'medium' })))
      .then((votes) => ({ ...f, votes: votes.filter(Boolean), survives: votes.filter(Boolean).filter((v) => !v.refuted).length >= 1 })))
  const confirmed = [...verified.filter(Boolean).filter((f) => f.survives), ...smokeFindings]
  log(`Round ${round}: ${confirmed.length} confirmed findings`)
  confirmedAll = confirmedAll.concat(confirmed)
  if (!confirmed.length) break

  const fix = await agent(fixerPrompt(confirmed, reports, round), { label: `fix:round${round}`, phase: 'Fix', schema: TRACK_SCHEMA, effort: 'high' })
  fixReports.push(fix)
}

log('Gate: completeness critic')
let gate = await agent(criticPrompt(reports, fixReports), { label: 'gate:critic', phase: 'Gate', schema: GATE_SCHEMA, effort: 'high' })
if (gate && !gate.passed && gate.missing.length) {
  log(`Gate found ${gate.missing.length} gaps; one closing fix round`)
  const gapFindings = gate.missing.map((m) => ({ title: m.item, file: m.file || 'src/App.jsx', line: 1, severity: 'medium', description: m.detail, repro: `See phase ${args.phase} gate in handoff section 16` }))
  const fix = await agent(fixerPrompt(gapFindings, reports, ROUNDS + 1), { label: 'fix:gate', phase: 'Fix', schema: TRACK_SCHEMA, effort: 'high' })
  fixReports.push(fix)
  gate = await agent(criticPrompt(reports, fixReports), { label: 'gate:critic-2', phase: 'Gate', schema: GATE_SCHEMA, effort: 'high' })
}

return { reports, confirmedAll, fixReports, gate }
