import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import { rosterSet } from '../../src/ops/roster.js'
import { cycleAdvance, runDirPath, runStart } from '../../src/ops/run.js'
import { stateSummary } from '../../src/ops/summary.js'
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

/** A verifier result carrying exactly the given claims as high findings. */
function verifierFail(claims: string[]) {
  return {
    status: 'fail' as const,
    summary: 'the suite is still red',
    evidence: [{ kind: 'command' as const, ref: 'npm test', excerpt: `${claims.length} failing` }],
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

    await rosterSet(project.dir, { cycle: 1, selected: ['builder', 'verifier'], skipped: { scout: 'goal names the file', critic: 'single-file change' } })
    await runLog(project.dir, { agent: 'verifier', result: verifierFail(['label is wrong', 'no test covers it']) }, clock)
    const first = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    expect(first.state.status).toBe('running')
    expect(first.state.cycle).toBe(2)
    expect(first.carried_findings).toHaveLength(2)
    expect(first.strikes).toBe(0)

    // Cycle 2 works the carried list and closes one of the two findings.
    await rosterSet(project.dir, { cycle: 2, selected: ['builder', 'verifier'], skipped: { scout: 'area already mapped', critic: 'no new interface' } })
    await runLog(project.dir, { agent: 'verifier', result: verifierFail(['no test covers it']) }, clock)
    const second = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)

    expect(second.carried_findings).toHaveLength(1)
    expect(second.strikes).toBe(0) // the remaining work changed, so no strike
    expect(second.state.cycle).toBe(3)

    await rosterSet(project.dir, { cycle: 3, selected: ['builder', 'verifier'], skipped: { scout: 'area already mapped', critic: 'no new interface' } })
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
      await rosterSet(project.dir, { cycle, selected: ['builder', 'verifier'], skipped: { scout: 'area already mapped', critic: 'no new interface' } })
      await runLog(project.dir, { agent: 'verifier', result: verifierFail(['label is wrong']) }, clock)
      return cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'fail' }, clock)
    }

    // The cap is 5. The guard stopped it at 3, saving two cycles.
    expect(closed.state.status).toBe('halted')
    expect(closed.state.cycle).toBe(3)
    expect(closed.state.halt_reason).toBe('no progress for 2 consecutive cycles on track build')

    const report = await fs.readFile(path.join(runDirPath(project.dir, closed.state), 'HALT.md'), 'utf8')
    expect(report).toContain('no progress for 2 consecutive cycles')
    expect(report).toContain('label is wrong')
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
