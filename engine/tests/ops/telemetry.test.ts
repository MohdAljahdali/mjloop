import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { TELEMETRY_FLAG_DRAFTS, TELEMETRY_MAX_ROWS, readTelemetry } from '../../src/ops/telemetry.js'
import type { AgentResult } from '../../src/schemas/contract.js'
import type { Finding } from '../../src/schemas/state.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

/**
 * The report answers "what did this specialist actually return?", so every test
 * here seeds the artefacts a run leaves behind rather than a config: the whole
 * point of the table is that it describes what happened, including for an agent
 * since removed from a track — because removing it is often the decision this
 * report informs.
 */

const NOW = new Date('2026-07-28T09:00:00.000Z')
const clock = (): Date => NOW

let project: TmpProject
beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
})
afterEach(async () => {
  await project.cleanup()
})

function cycleDir(run: string, cycle: number): string {
  return path.join(project.dir, '.mjloop', 'runs', run, `cycle-${String(cycle).padStart(2, '0')}`)
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function result(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    status: 'pass',
    summary: 'did the thing',
    evidence: [],
    findings: [],
    files_touched: [],
    next_hint: null,
    ...overrides,
  }
}

function finding(severity: Finding['severity']): Finding {
  return { severity, file: 'src/a.ts', line: 12, claim: `a ${severity} problem` }
}

interface CycleSpec {
  selected: string[]
  skipped?: Record<string, string>
  /** File basename (without `.json`) -> that agent's result. */
  landed?: Record<string, AgentResult>
}

async function seedCycle(run: string, cycle: number, spec: CycleSpec): Promise<void> {
  await writeJson(path.join(cycleDir(run, cycle), 'roster.json'), {
    cycle,
    selected: spec.selected,
    skipped: spec.skipped ?? {},
  })
  for (const [file, value] of Object.entries(spec.landed ?? {})) {
    await writeJson(path.join(cycleDir(run, cycle), `${file}.json`), value)
  }
}

function row(telemetry: Awaited<ReturnType<typeof readTelemetry>>, agent: string) {
  return telemetry.specialists.find((entry) => entry.agent === agent)
}

describe('readTelemetry', () => {
  it('separates drafted from landed', async () => {
    await seedCycle('2026-07-27-001--adhoc--build', 1, {
      selected: ['builder', 'critic'],
      landed: { builder: result() },
    })

    const telemetry = await readTelemetry(project.dir)

    expect(row(telemetry, 'builder')).toMatchObject({ drafted: 1, landed: 1 })
    // The gap is the point: a cycle the leader planned and the agent never
    // returned from is not visible anywhere else.
    expect(row(telemetry, 'critic')).toMatchObject({ drafted: 1, landed: 0 })
  })

  it('counts a stated omission as skipped, not as drafted', async () => {
    await seedCycle('2026-07-27-001--adhoc--build', 1, {
      selected: ['builder'],
      skipped: { security: 'no auth surface touched' },
      landed: { builder: result() },
    })

    const telemetry = await readTelemetry(project.dir)

    expect(row(telemetry, 'security')).toMatchObject({ drafted: 0, skipped: 1, landed: 0 })
  })

  it('attributes findings to the agent that filed them', async () => {
    const run = '2026-07-27-001--adhoc--build'
    await seedCycle(run, 1, {
      selected: ['builder', 'critic'],
      landed: {
        builder: result(),
        critic: result({ status: 'fail', findings: [finding('high'), finding('low')] }),
      },
    })
    // The cycle aggregate carries no attribution, so it must contribute nothing.
    await writeJson(path.join(cycleDir(run, 1), 'findings.json'), [finding('high'), finding('low')])

    const telemetry = await readTelemetry(project.dir)

    expect(row(telemetry, 'critic')?.findings).toEqual({ high: 1, medium: 0, low: 1 })
    expect(row(telemetry, 'builder')?.findings).toEqual({ high: 0, medium: 0, low: 0 })
    expect(row(telemetry, 'findings')).toBeUndefined()
  })

  it('counts an instance beside the agent that ran it', async () => {
    await seedCycle('2026-07-27-001--adhoc--build', 1, {
      selected: ['critic'],
      landed: {
        critic: result(),
        'critic--api': result({ status: 'fail', findings: [finding('medium')] }),
      },
    })

    const telemetry = await readTelemetry(project.dir)

    // Two files, one cycle: `results` counts what returned and `landed` counts
    // cycles, so the two are deliberately different numbers.
    expect(row(telemetry, 'critic')).toMatchObject({
      drafted: 1,
      landed: 1,
      results: { pass: 1, fail: 1, blocked: 0 },
      findings: { high: 0, medium: 1, low: 0 },
    })
  })

  it('reports an agent no track offers any more', async () => {
    await seedCycle('2026-07-27-001--adhoc--build', 1, {
      selected: ['builder', 'archaeologist'],
      landed: { archaeologist: result({ status: 'blocked' }) },
    })

    const telemetry = await readTelemetry(project.dir)

    // Nothing in `config.tracks` mentions this name. Asking the config instead
    // of the history would answer a question nobody asked — the report exists
    // to inform the decision to remove an agent, and would go blank the moment
    // it was acted on.
    expect(row(telemetry, 'archaeologist')).toMatchObject({
      drafted: 1,
      landed: 1,
      mode: null,
      results: { pass: 0, fail: 0, blocked: 1 },
    })
  })

  it('reports a closing agent that appears in no roster', async () => {
    // The idea-9 regression: `docs` moved out of `available` and into the build
    // track's `closing` set, so no cycle roster will ever mention it again.
    await seedCycle('2026-07-27-001--adhoc--build', 1, { selected: ['builder'], landed: { builder: result() } })

    const telemetry = await readTelemetry(project.dir)

    expect(row(telemetry, 'docs')).toMatchObject({ drafted: 0, skipped: 0, landed: 0, runs: 0 })
  })

  it('counts a closing roster as a dispatch', async () => {
    const run = '2026-07-27-001--adhoc--build'
    await seedCycle(run, 1, { selected: ['builder'], landed: { builder: result() } })
    const closing = path.join(project.dir, '.mjloop', 'runs', run, 'closing')
    await writeJson(path.join(closing, 'roster.json'), { cycle: 1, selected: ['docs'], skipped: {} })
    await writeJson(path.join(closing, 'docs.json'), result({ files_touched: ['README.md'] }))

    const telemetry = await readTelemetry(project.dir)

    expect(row(telemetry, 'docs')).toMatchObject({ drafted: 1, landed: 1, runs: 1, last_seen: '2026-07-27-001' })
    // The closing pass is not a cycle, so it does not lengthen the run.
    expect(telemetry.cycles).toBe(1)
  })

  it('reports the configured mode beside the observed rate', async () => {
    const config = await loadConfig(project.dir)
    config.specialists = { critic: 'always', security: 'never' }
    await writeConfig(project.dir, config)
    await seedCycle('2026-07-27-001--adhoc--build', 1, {
      selected: ['builder', 'critic'],
      landed: { critic: result() },
    })

    const telemetry = await readTelemetry(project.dir)

    expect(row(telemetry, 'critic')?.mode).toBe('always')
    expect(row(telemetry, 'builder')?.mode).toBeNull()
  })

  it('flags a specialist drafted five times with nothing to show', async () => {
    for (let cycle = 1; cycle <= TELEMETRY_FLAG_DRAFTS; cycle += 1) {
      await seedCycle('2026-07-27-001--adhoc--build', cycle, {
        selected: ['security', 'critic'],
        landed: {
          security: result({ findings: [finding('low')] }),
          critic: result({ status: 'fail', findings: [finding('medium')] }),
        },
      })
    }

    const telemetry = await readTelemetry(project.dir)

    // A `low` is not an argument. The line exists to surface a specialist whose
    // every dispatch has been decorative, and the decision it informs — a
    // stated `skipped` reason, or a `never` — belongs to a person.
    expect(telemetry.flagged).toEqual(['security'])
  })

  it('never flags an agent the track requires, however quiet it is', async () => {
    // `rosterSet` forces every one of a track's `required` names into
    // `selected`, so `builder` and `verifier` accrue a draft every cycle — and
    // a builder that passes files no findings by design. Both cross the
    // threshold after five green cycles, and both remedies the line prescribes
    // are wrong for them: `specialists.builder: never` makes `config.yaml` stop
    // parsing for an agent its own track requires, and neither name is in any
    // `available` set to trim.
    for (let cycle = 1; cycle <= TELEMETRY_FLAG_DRAFTS; cycle += 1) {
      await seedCycle('2026-07-27-001--adhoc--build', cycle, {
        selected: ['builder', 'verifier', 'security'],
        landed: {
          builder: result(),
          verifier: result(),
          security: result(),
        },
      })
    }

    expect((await readTelemetry(project.dir)).flagged).toEqual(['security'])
  })

  it('never flags an agent the track pins some other way — a map drafter or a closing agent', async () => {
    // The remedies the line prescribes are `specialists.<agent>: never` and
    // trimming the track's `available`, and `ConfigSchema` refuses `never` for
    // four categories of name, not one: `required`, `closing`, `map.drafted_by`
    // and `gate.proven_by`. On the stock config `scout` drafts `build`'s map
    // and `docs` closes it, and neither is in any track's `required` — so an
    // exclusion built from `required` alone flags both, and an operator who
    // follows the advice for either writes a `config.yaml` that stops parsing.
    // The assertion below is that they are `pinnedAgents`, not `required`.
    for (let cycle = 1; cycle <= TELEMETRY_FLAG_DRAFTS; cycle += 1) {
      await seedCycle('2026-07-27-001--adhoc--build', cycle, {
        selected: ['scout', 'security'],
        landed: { scout: result(), security: result() },
      })
    }
    // `closingRosterSet` demands every `closing` name be selected or skipped
    // with a reason, so `docs` is drafted by every passing build run.
    for (let run = 1; run <= TELEMETRY_FLAG_DRAFTS; run += 1) {
      const dir = path.join(project.dir, '.mjloop', 'runs', `2026-07-2${String(run)}-002--adhoc--build`, 'closing')
      await writeJson(path.join(dir, 'roster.json'), { cycle: 0, selected: ['docs'], skipped: {} })
      await writeJson(path.join(dir, 'docs.json'), result())
    }

    const telemetry = await readTelemetry(project.dir)

    expect(row(telemetry, 'scout')?.drafted).toBe(TELEMETRY_FLAG_DRAFTS)
    expect(row(telemetry, 'docs')?.drafted).toBe(TELEMETRY_FLAG_DRAFTS)
    expect(telemetry.flagged).toEqual(['security'])
  })

  it('does not flag a specialist drafted fewer than five times', async () => {
    for (let cycle = 1; cycle < TELEMETRY_FLAG_DRAFTS; cycle += 1) {
      await seedCycle('2026-07-27-001--adhoc--build', cycle, { selected: ['security'], landed: { security: result() } })
    }

    expect((await readTelemetry(project.dir)).flagged).toEqual([])
  })

  it('caps the rows and says how many it dropped', async () => {
    const agents = Array.from({ length: 45 }, (_, index) => `agent-${String(index).padStart(2, '0')}`)
    await seedCycle('2026-07-27-001--adhoc--build', 1, { selected: agents })

    const telemetry = await readTelemetry(project.dir)

    expect(telemetry.specialists).toHaveLength(TELEMETRY_MAX_ROWS)
    // 45 names from the roster plus `docs` from the build track's closing set.
    expect(telemetry.truncated).toBe(46 - TELEMETRY_MAX_ROWS)
  })

  it('orders the rows by drafted, so the cap drops the least-used', async () => {
    await seedCycle('2026-07-27-001--adhoc--build', 1, { selected: ['builder', 'critic'] })
    await seedCycle('2026-07-27-001--adhoc--build', 2, { selected: ['builder'] })

    const telemetry = await readTelemetry(project.dir)

    expect(telemetry.specialists.map((entry) => entry.agent)).toEqual(['builder', 'critic', 'docs'])
  })

  it('counts runs and cycles, and names the run each agent was last seen in', async () => {
    await seedCycle('2026-07-26-001--adhoc--build', 1, { selected: ['builder', 'scout'] })
    await seedCycle('2026-07-27-001--adhoc--build', 1, { selected: ['builder'] })
    await seedCycle('2026-07-27-001--adhoc--build', 2, { selected: ['builder'] })

    const telemetry = await readTelemetry(project.dir)

    expect(telemetry).toMatchObject({ runs: 2, cycles: 3 })
    expect(row(telemetry, 'builder')).toMatchObject({ drafted: 3, runs: 2, last_seen: '2026-07-27-001' })
    expect(row(telemetry, 'scout')).toMatchObject({ drafted: 1, runs: 1, last_seen: '2026-07-26-001' })
  })

  it('returns an empty report for a project that has never run', async () => {
    expect(await readTelemetry(project.dir)).toEqual({
      runs: 0,
      cycles: 0,
      specialists: [],
      truncated: 0,
      flagged: [],
    })
  })
})
