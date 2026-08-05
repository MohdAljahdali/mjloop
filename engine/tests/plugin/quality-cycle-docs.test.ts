import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { QualityModeSchema } from '../../src/schemas/config.js'
import { StatusSchema } from '../../src/schemas/state.js'

/**
 * The operator-facing protocol for quality cycle modes, asserted against the
 * engine that implements it.
 *
 * Every other suite in this directory checks a document against something the
 * engine would notice — a tool name, a frontmatter key, an agent's granted
 * tools. This one checks the sentences an operator acts on, which the engine
 * never reads: a skill that told the leader to decide a destructive request
 * itself, or a README that promised an automatic merge, would be refused by the
 * engine at the moment it mattered and believed by every person until then.
 *
 * Deliberately structural. It asserts that a concept is still named — the three
 * closed modes, the pinned policy, the two resumable statuses — and that the
 * four forbidden claims are absent. It does not assert the prose still reads
 * well, which is not a fact a regular expression knows.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

const FILES = {
  leader: 'skills/mjloop-leader/SKILL.md',
  state: 'skills/mjloop-state/SKILL.md',
  config: 'commands/config.md',
  run: 'commands/run.md',
  resume: 'commands/resume.md',
  status: 'commands/status.md',
  readme: 'README.md',
  readmeAr: 'README.ar.md',
  // The configuration reference both READMEs send an operator to. Here for the
  // forbidden claims rather than the positive ones: it is where the two-boolean
  // shape this key replaced was documented, and a stale row there is a key the
  // guarded write refuses, printed as though it were settable.
  usage: 'docs/usage.md',
  usageAr: 'docs/usage.ar.md',
} as const

type DocName = keyof typeof FILES

const docs = new Map<DocName, string>()
for (const [name, file] of Object.entries(FILES) as Array<[DocName, string]>) {
  docs.set(name, await fs.readFile(path.join(REPO, file), 'utf8'))
}

const read = (name: DocName): string => docs.get(name) ?? ''
const every = (...names: DocName[]): Array<[DocName, string]> => names.map((name) => [name, read(name)])

/** The two run statuses a decision or an amendment lifts, named by the engine rather than retyped. */
const RESUMABLE = ['waiting_for_user', 'budget_exhausted'] as const

describe('the quality mode protocol', () => {
  it('names exactly the three closed modes wherever it names one', () => {
    // Imported from the schema rather than retyped, the way `commands.test.ts`
    // reads its discovery modes: a fourth mode in `config.ts` fails here rather
    // than shipping undocumented, and a mode the schema dropped fails here too.
    for (const [name, source] of every('leader', 'state', 'config', 'readme', 'readmeAr')) {
      for (const mode of QualityModeSchema.options) {
        expect(source, `${name} does not name the "${mode}" mode`).toContain(`\`${mode}\``)
      }
    }
  })

  it('states the comparison order tokens, then cost, then time', () => {
    // `compareQualityCandidates` breaks a tie between two ways of closing the
    // same dimensions in exactly this order. An operator reading a different
    // order would choose a mode expecting it to be optimised for something the
    // engine does not optimise for. Asserted as one sentence naming the three
    // in sequence, rather than as the first three occurrences in the document,
    // because "one decision at a time" is not a statement about priority.
    expect(read('readme'), 'the README states a different priority order').toMatch(
      /tokens[^.\n]+cost[^.\n]+time/i,
    )
    expect(read('readmeAr'), 'the Arabic README states a different priority order').toMatch(
      /الرموز[^.\n]+التكلفة[^.\n]+الوقت/,
    )
  })

  it('says a run works against its pinned policy and not the live config', () => {
    for (const [name, source] of every('leader', 'state', 'config', 'run', 'status', 'readme', 'readmeAr')) {
      expect(source, `${name} does not mention the run's pin`).toMatch(/pinn?ed|مثبّت/i)
    }
    expect(read('config'), 'the config command does not say a change spares an open run').toMatch(/open run|تشغيل قائم/i)
  })

  it('names both resumable statuses and the operator action each one needs', () => {
    for (const status of RESUMABLE) {
      expect(StatusSchema.options, `${status} is no longer a run status`).toContain(status)
      for (const [name, source] of every('state', 'resume', 'status', 'leader')) {
        expect(source, `${name} does not name "${status}"`).toContain(`\`${status}\``)
      }
    }
    expect(read('resume'), 'resume does not name the budget amendment').toMatch(/amendment/i)
    expect(read('resume'), 'resume does not name the destructive decision').toMatch(/destructive/i)
  })

  it('says a suspended run spends nothing while it waits', () => {
    // §7.2 of the design: neither resumable status runs polling, an agent, or a
    // periodic summary. It is the reason a suspension is safe to leave open,
    // and the one property of it an operator cannot verify by looking.
    for (const [name, source] of every('resume', 'leader', 'readme', 'readmeAr')) {
      expect(source, `${name} does not say a suspended run costs nothing`).toMatch(
        /no (agent|dispatch|polling|token)|بلا استهلاك|لا تستهلك|دون استهلاك/i,
      )
    }
  })

  it('points every reader at /mjloop:resume once a decision is made', () => {
    for (const [name, source] of every('resume', 'status', 'leader', 'readme', 'readmeAr')) {
      expect(source, `${name} does not name /mjloop:resume`).toContain('/mjloop:resume')
    }
  })

  it('keeps destructive approval away from the agents', () => {
    // The gate's whole value is that no agent and no MCP tool can open it. A
    // skill that told the leader to decide one itself would be asking for
    // exactly the call the engine refuses.
    expect(read('leader')).toMatch(/[Nn]ever (decide|approve)[^\n]*destructive/)
    for (const [name, source] of every('leader', 'readme', 'readmeAr')) {
      expect(source, `${name} does not say who decides`).toMatch(/operator|cockpit|المشغّل|لوحة التحكم/i)
    }
  })
})

describe('the quality mode protocol never claims', () => {
  const ALL = [...docs.entries()]

  it('a legacy quality setting', () => {
    for (const [name, source] of ALL) {
      expect(source, `${name} names a legacy quality key`).not.toMatch(/independent_plan_review|independent_verification/)
    }
  })

  it('an automatic merge or deploy', () => {
    // Neither is in this design's authority at all, and a document that said
    // otherwise would be describing a capability the engine does not have.
    for (const [name, source] of ALL) {
      expect(source, `${name} claims an automatic merge or deploy`).not.toMatch(
        /auto(matic(ally)?)?[- ]?(merge|deploy)|(merges|deploys|merging|deploying)\s+(it\s+)?automatically|دمج تلقائي|نشر تلقائي/i,
      )
    }
    for (const [name, source] of every('readme', 'readmeAr')) {
      expect(source, `${name} does not say merge and deploy stay human`).toMatch(/merge|دمج/i)
    }
  })

  it('a quality agent role that does not exist', async () => {
    // A dimension's review is routed to a role the track already grants, or to
    // a named `verifier` instance. A documented `quality-reviewer` would be the
    // one thing that quietly turned a routing rule into a new agent.
    const files = (await fs.readdir(path.join(REPO, 'agents'))).filter((file) => file.endsWith('.md'))
    const agents = new Set(files.map((file) => path.basename(file, '.md')))
    expect([...agents].filter((agent) => agent.startsWith('quality'))).toEqual([])
    // Asserted in the direction that can actually fail. The line above already
    // guarantees no shipped agent is named `quality…`, so requiring such a
    // token to be *absent* from `agents/` is a tautology and would let the
    // violation this test is named for through: a doc that says "dispatch the
    // `quality-reviewer` agent" would pass. Requiring it to be *present* is the
    // real guard — every token of that shape now has to name a file, and while
    // no agent may start with `quality`, none can.
    for (const [name, source] of ALL) {
      for (const invented of [...source.matchAll(/`(quality-[a-z-]+|[a-z-]+-quality)`/g)]) {
        expect(agents.has(invented[1] ?? ''), `${name} names "${invented[1]}" as an agent`).toBe(true)
      }
    }
  })

  it('a monetary figure it cannot measure', () => {
    for (const [name, source] of ALL) {
      expect(source, `${name} prints a currency figure`).not.toMatch(/[$€£]\s?\d|\d+(\.\d+)?\s?(USD|EUR|SAR)/)
    }
    // The honesty discipline instead: every number the run reports carries the
    // label the engine gave it.
    for (const [name, source] of every('readme', 'readmeAr', 'status')) {
      for (const label of ['measured', 'estimated', 'unavailable']) {
        expect(source, `${name} does not carry the "${label}" label`).toContain(label)
      }
    }
  })

  it('anything still unfinished', () => {
    for (const [name, source] of ALL) {
      expect(source, `${name} carries an unfinished marker`).not.toMatch(/\bTODO\b|\bTBD\b|\bFIXME\b/)
    }
  })
})
