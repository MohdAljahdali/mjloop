import fs from 'node:fs/promises'
import path from 'node:path'
import { RosterSchema, type Roster } from '../schemas/contract.js'
import { loadConfig } from '../store/config-store.js'
import { StateStore } from '../store/state-store.js'
import { NoActiveRunError, UnknownTrackError, cycleDirPath } from './run.js'

export class RosterViolationError extends Error {
  constructor(violations: string[]) {
    super(`roster rejected:\n${violations.map((v) => `- ${v}`).join('\n')}`)
    this.name = 'RosterViolationError'
  }
}

/**
 * Persist the leader's declared cycle composition. This is the enforcement
 * point for the system's hard invariant: a track's `required` agents —
 * `verifier` above all — cannot be dropped, and every omission must carry a
 * stated reason.
 */
export async function rosterSet(projectDir: string, roster: Roster): Promise<{ path: string }> {
  const parsed = RosterSchema.parse(roster)
  const state = await new StateStore(projectDir).get()
  if (state.status !== 'running' || state.track === null) throw new NoActiveRunError()

  const config = await loadConfig(projectDir)
  const track = config.tracks[state.track]
  if (track === undefined) throw new UnknownTrackError(state.track, Object.keys(config.tracks))

  const forced = Object.entries(config.specialists)
    .filter(([, mode]) => mode === 'always')
    .map(([name]) => name)
  const permitted = new Set([...track.required, ...track.available, ...forced])
  const selected = new Set(parsed.selected)

  const violations: string[] = []

  if (parsed.cycle !== state.cycle) {
    violations.push(`roster is for cycle ${parsed.cycle} but state is at cycle ${state.cycle}`)
  }

  for (const agent of track.required) {
    if (!selected.has(agent)) {
      violations.push(`"${agent}" is required by track "${state.track}" and cannot be dropped`)
    }
  }

  for (const agent of forced) {
    if (!selected.has(agent)) {
      violations.push(`"${agent}" is configured as specialists.${agent}=always and cannot be dropped`)
    }
  }

  for (const agent of parsed.selected) {
    if (!permitted.has(agent)) {
      violations.push(`"${agent}" is not in track "${state.track}" — add it to required or available first`)
    }
  }

  // Every optional agent is either drafted or explained. Silence is not an answer.
  for (const agent of track.available) {
    if (!selected.has(agent) && parsed.skipped[agent] === undefined) {
      violations.push(`"${agent}" was omitted without a reason — add it to skipped`)
    }
  }

  if (violations.length > 0) throw new RosterViolationError(violations)

  // Per cycle, alongside that cycle's agent results: a roster is validated
  // against `state.cycle`, so one file per run would leave a multi-cycle run
  // holding only its last composition — and the stated reason for each
  // omission, which is the whole product of the invariant, is not recoverable
  // from anywhere else.
  const file = path.join(cycleDirPath(projectDir, state), 'roster.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return { path: file }
}
