import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import { rosterSet } from '../../src/ops/roster.js'
import { cycleAdvance, runDirPath, runStart } from '../../src/ops/run.js'
import { stateSummary } from '../../src/ops/summary.js'
import { readVerifyLedger, verifyRun } from '../../src/ops/verify.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-26T10:36:00.000Z')
const clock = () => NOW
const FIXTURE = path.resolve(fileURLToPath(import.meta.url), '../../../../tests/fixtures/tiny-app')

let project: TmpProject

beforeEach(async () => {
  project = await makeTmpProject()
  await fs.cp(FIXTURE, project.dir, { recursive: true })
  await initLoop(project.dir, clock)
})
afterEach(async () => { await project.cleanup() })

/**
 * A verifier result carrying exactly the given claims as high findings.
 *
 * The excerpt names them by default, so a cycle whose remaining work changed
 * reports a changed verification failure too: the repeated-error guard halts on
 * a failure that recurs verbatim, and it fires a cycle earlier than stagnation.
 * A cycle that must repeat its findings without repeating its failure passes an
 * excerpt of its own.
 */
function verifierFail(claims: string[], excerpt = `${claims.length} failing: ${claims.join('; ')}`) {
  return {
    status: 'fail' as const,
    summary: 'the suite is still red',
    evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt }],
    findings: claims.map((claim, index) => ({
      severity: 'high' as const,
      file: 'src/button.js',
      line: index + 1,
      claim,
    })),
    files_touched: [],
    next_hint: null,
  }
}

/**
 * A roster owes a reason for every *available* agent it drops. This suite is
 * about the cycle, so it states them once.
 *
 * `docs` is deliberately absent: it closes the build track rather than joining
 * a cycle, so a working cycle owes nothing for leaving it out — the reason it
 * owes is written once, into `closing/roster.json`, by the pass at the bottom
 * of this file.
 */
const SPECIALISTS_SKIPPED = {
  'ui-designer': 'no user-facing surface',
  'ui-critic': 'no user-facing surface',
  security: 'no untrusted input',
  perf: 'not a hot path',
}

const VERIFIER_PASS = {
  status: 'pass' as const,
  summary: 'Lint and the affected test both exit 0.',
  evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: 'tests 1, pass 1, fail 0' }],
  findings: [],
  files_touched: [],
  next_hint: null,
}

describe('a multi-cycle build run', () => {
  it('carries findings forward and lands on done', async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add a Send button' }, clock)

    await rosterSet(project.dir, { cycle: 1, selected: ['builder', 'verifier'], skipped: { ...SPECIALISTS_SKIPPED, scout: 'goal names the file', critic: 'single-file change' } })
    await runLog(project.dir, { agent: 'verifier', result: verifierFail(['label is wrong', 'no test covers it']) }, clock)
    const first = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    expect(first.state.status).toBe('running')
    expect(first.state.cycle).toBe(2)
    expect(first.carried_findings).toHaveLength(2)
    expect(first.strikes).toBe(0)

    // Cycle 2 works the carried list and closes one of the two findings.
    await rosterSet(project.dir, { cycle: 2, selected: ['builder', 'verifier'], skipped: { ...SPECIALISTS_SKIPPED, scout: 'area already mapped', critic: 'no new interface' } })
    await runLog(project.dir, { agent: 'verifier', result: verifierFail(['no test covers it']) }, clock)
    const second = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    expect(second.carried_findings).toHaveLength(1)
    expect(second.strikes).toBe(0) // the remaining work changed, so no strike
    expect(second.state.cycle).toBe(3)

    await rosterSet(project.dir, { cycle: 3, selected: ['builder', 'verifier'], skipped: { ...SPECIALISTS_SKIPPED, scout: 'area already mapped', critic: 'no new interface' } })
    await runLog(project.dir, { agent: 'verifier', result: VERIFIER_PASS }, clock)
    const third = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'pass' }, clock)

    expect(third.state.status).toBe('done')
    expect(third.fingerprint).toBeNull()

    const summary = await stateSummary(project.dir)
    expect(summary.status).toBe('done')
    expect(summary.max_cycles).toBe(5)
    expect(summary.findings).toEqual({ high: 0, medium: 0, low: 0 })

    // Every cycle left its own archive behind.
    const dir = runDirPath(project.dir, third.state)
    for (const cycle of ['cycle-01', 'cycle-02', 'cycle-03']) {
      const archived = JSON.parse(await fs.readFile(path.join(dir, cycle, 'findings.json'), 'utf8'))
      expect(Array.isArray(archived)).toBe(true)
    }
  })

  it('halts a stuck run before the cap and says why', async () => {
    await runStart(project.dir, { track: 'build', goal: 'Add a Send button' }, clock)

    let closed = await runCycle(1)
    closed = await runCycle(2)
    closed = await runCycle(3)

    async function runCycle(cycle: number) {
      await rosterSet(project.dir, { cycle, selected: ['builder', 'verifier'], skipped: { ...SPECIALISTS_SKIPPED, scout: 'area already mapped', critic: 'no new interface' } })
      // The same defect every cycle, reported by a differently worded failure:
      // this run is stuck on its findings, which is what stagnation names.
      const excerpt = `1 failing at step ${String.fromCharCode(96 + cycle)}`
      await runLog(project.dir, { agent: 'verifier', result: verifierFail(['label is wrong'], excerpt) }, clock)
      return cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    }

    // The cap is 5. The guard stopped it at 3, saving two cycles.
    expect(closed.state.status).toBe('halted')
    expect(closed.state.cycle).toBe(3)
    expect(closed.state.halt_reason).toBe('no progress for 2 consecutive cycles on track build')

    const report = await fs.readFile(path.join(runDirPath(project.dir, closed.state), 'HALT.md'), 'utf8')
    expect(report).toContain('no progress for 2 consecutive cycles')
    expect(report).toContain('label is wrong')

    // The summary a resumed session reads agrees with the report it points at.
    const summary = await stateSummary(project.dir)
    expect(summary.findings).toEqual({ high: 1, medium: 0, low: 0 })

    // Each cycle kept its own roster, so which agents were skipped and why is
    // still readable for all three.
    for (const cycle of ['cycle-01', 'cycle-02', 'cycle-03']) {
      const file = path.join(runDirPath(project.dir, closed.state), cycle, 'roster.json')
      expect(JSON.parse(await fs.readFile(file, 'utf8')).skipped.scout).toBe('area already mapped')
    }
  })

  it('still honours the cap when the work keeps changing', async () => {
    const config = await loadConfig(project.dir)
    config.tracks.build = { required: ['builder', 'verifier'], available: [], max_cycles: 2 }
    await writeConfig(project.dir, config)

    await runStart(project.dir, { track: 'build', goal: 'Add a Send button' }, clock)
    await runLog(project.dir, { agent: 'verifier', result: verifierFail(['first defect']) }, clock)
    await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    await runLog(project.dir, { agent: 'verifier', result: verifierFail(['a different defect']) }, clock)
    const second = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    expect(second.state.status).toBe('halted')
    expect(second.state.halt_reason).toBe('cycle cap 2 reached for track build')
  })
})

/**
 * A green suite, instant, phrased the way a project's own would be.
 *
 * It is executed twice in one test — once inside the cycle and once by the
 * closing agent — so it is a `printf` rather than the fixture's `npm test`:
 * this test is about where the second run's receipt lands, not about node.
 */
const VERIFY_TEST = "printf 'tests 1, pass 1, fail 0\\n'"

/**
 * `runStart` pins the verify block, so the command has to be in `config.yaml`
 * before the run opens — a run started first would pin `npm test` and then
 * refuse to obey the edit, which is exactly what the pin is for.
 */
async function pinVerify(command: string): Promise<void> {
  const config = await loadConfig(project.dir)
  config.verify.test = command
  await writeConfig(project.dir, config)
}

/**
 * What the leader stages when it commits: every path the run's agents reported
 * in `files_touched`, read back off the results they left behind.
 *
 * The engine never commits — `skills/mjloop-leader/SKILL.md` step 8 does, from
 * the results it is holding — so this walk stands in for it, and it walks
 * `closing/` alongside the cycles for the same reason step 8 commits *after*
 * the closing pass. `cyclesOnly` is the stage a leader would have taken before
 * it, which is the thing this test needs to be able to name.
 */
async function stagedFiles(runDir: string, options: { cyclesOnly?: boolean } = {}): Promise<string[]> {
  const entries = await fs.readdir(runDir, { withFileTypes: true })
  const staged = new Set<string>()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const isCycle = /^cycle-\d+$/.test(entry.name)
    if (!isCycle && (entry.name !== 'closing' || options.cyclesOnly === true)) continue
    const dir = path.join(runDir, entry.name)
    for (const file of await fs.readdir(dir)) {
      // The two aggregates are not agent results, and `roster` and `findings`
      // are reserved agent names so nothing else can be writing them.
      if (!file.endsWith('.json') || file === 'roster.json' || file === 'findings.json') continue
      const result = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))
      for (const touched of result.files_touched) staged.add(touched)
    }
  }
  return [...staged].sort()
}

describe('the pass that ends a build run', () => {
  it('closes with docs, which re-verifies and lands in the commit without moving the verdict', async () => {
    await pinVerify(VERIFY_TEST)
    await runStart(project.dir, { track: 'build', goal: 'Add a Send button' }, clock)

    await rosterSet(project.dir, {
      cycle: 1,
      selected: ['builder', 'verifier'],
      skipped: { ...SPECIALISTS_SKIPPED, scout: 'goal names the file', critic: 'single-file change' },
    })
    await runLog(
      project.dir,
      {
        agent: 'builder',
        result: {
          status: 'pass',
          summary: 'Added the button and a test for it.',
          evidence: [{ kind: 'file', ref: 'src/button.js', excerpt: "return 'Send'" }],
          findings: [],
          files_touched: ['src/button.js', 'test/button.test.js'],
          next_hint: null,
        },
      },
      clock,
    )

    // Run through the engine, so the cycle carries a ledger of its own for the
    // closing pass to be compared against.
    const inCycle = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)
    expect(inCycle.exit_code).toBe(0)
    await runLog(
      project.dir,
      {
        agent: 'verifier',
        result: {
          status: 'pass',
          summary: 'The suite the engine ran exits 0.',
          evidence: [{ kind: 'command', ref: inCycle.command, excerpt: 'tests 1, pass 1, fail 0' }],
          findings: [],
          files_touched: [],
          next_hint: null,
        },
      },
      clock,
    )

    const closed = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'pass' }, clock)
    expect(closed.state.status).toBe('done')
    // Reported at the one moment the leader can act on it, and from the
    // track's own data — the engine knows no agent names.
    expect(closed.closing_agents).toEqual(['docs'])

    const dir = runDirPath(project.dir, closed.state)

    // 1. The closing roster. It is refused until the run has passed, so this
    //    call is itself the assertion that the run really is closed.
    await rosterSet(project.dir, { closing: true, selected: ['docs'], skipped: {} })

    // 2. docs writes the documentation and re-runs the suite against the tree
    //    as it now stands. This is the widened precondition: the run is already
    //    `done`, and the alternative is a commit resting on a green result
    //    taken before the documentation landed.
    await fs.mkdir(path.join(project.dir, 'docs'), { recursive: true })
    await fs.writeFile(path.join(project.dir, 'docs', 'buttons.md'), '# Buttons\n\nSend submits the form.\n', 'utf8')
    const reverified = await verifyRun(project.dir, { slot: 'test', wait_ms: 4000 }, clock)
    expect(reverified.phase).toBe('complete')
    expect(reverified.exit_code).toBe(0)
    // Outside every cycle directory. The cycle's own ledger is the record of
    // what that cycle verified and the closing pass must not append to it — a
    // reader of `cycle-01` would otherwise see a row for a command run after
    // the cycle closed.
    expect(path.dirname(reverified.log)).toBe(path.relative(project.dir, path.join(dir, 'closing', 'verify')))
    expect(await readVerifyLedger(path.join(dir, 'cycle-01'))).toHaveLength(1)
    expect(await readVerifyLedger(path.join(dir, 'closing'))).toHaveLength(1)

    // 3. docs logs, carrying the run it was dispatched under. Its finding is
    //    the interesting part: a closing agent cannot reopen a verdict nobody
    //    can revisit, so the finding is recorded in its own result file and
    //    nowhere else.
    const logged = await runLog(
      project.dir,
      {
        agent: 'docs',
        run_id: closed.state.run_id,
        result: {
          status: 'pass',
          summary: 'Documented the Send button against the code as it finally stands.',
          evidence: [{ kind: 'command', ref: reverified.command, excerpt: 'tests 1, pass 1, fail 0' }],
          findings: [{ severity: 'low', file: 'docs/buttons.md', line: 3, claim: 'the keyboard shortcut is undocumented' }],
          files_touched: ['docs/buttons.md'],
          next_hint: null,
        },
      },
      clock,
    )
    expect(logged.findingsAdded).toBe(0)
    expect(logged.gateOpened).toBe(false)

    // The verdict is exactly where the pass left it, findings and all.
    const summary = await stateSummary(project.dir)
    expect(summary.status).toBe('done')
    expect(summary.cycle).toBe(1)
    expect(summary.findings).toEqual({ high: 0, medium: 0, low: 0 })

    // Both closing artefacts are in `closing/` and neither is in the cycle.
    expect((await fs.readdir(path.join(dir, 'closing'))).sort()).toEqual(['docs.json', 'roster.json', 'verify'])
    const roster = JSON.parse(await fs.readFile(path.join(dir, 'closing', 'roster.json'), 'utf8'))
    expect(roster).toEqual({ closing: true, selected: ['docs'], skipped: {} })
    expect(await fs.readdir(path.join(dir, 'cycle-01'))).not.toContain('docs.json')

    // 4. And the commit. Staged from `files_touched`, so the documentation
    //    ships with the code it describes — the defect idea 9 removes is a
    //    commit taken one step earlier, which is what the second walk is.
    expect(await stagedFiles(dir)).toEqual(['docs/buttons.md', 'src/button.js', 'test/button.test.js'])
    expect(await stagedFiles(dir, { cyclesOnly: true })).toEqual(['src/button.js', 'test/button.test.js'])
  })
})
