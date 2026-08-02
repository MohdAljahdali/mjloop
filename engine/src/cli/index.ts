#!/usr/bin/env node
import { spawn as nodeSpawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as z from 'zod'
import { renderSummaryLine, stateSummary, type StateSummary } from '../ops/summary.js'
import { discoverCandidates, SkillSourceDisabledError } from '../ops/skill-discovery.js'
import { computePackageDigest, inspectCandidate } from '../ops/skill-import.js'
import { detectSandboxBackend, runSkillSandbox, type DetectedSandbox, type SkillSandboxDeps } from '../ops/skill-sandbox.js'
import type { Orchestration, SkillSource, SkillUpdateMode } from '../schemas/config.js'
import { SkillSourceSchema, SkillUpdateModeSchema } from '../schemas/config.js'
import type { ProjectComponent, ProjectProfile, ProposedProfile } from '../schemas/project-profile.js'
import type { ProjectSkillAcceptance } from '../schemas/skill-acceptance.js'
import { ImportReportSchema, SkillCandidateSchema, type ImportReport, type SandboxResult, type SkillCandidate } from '../schemas/skill-import.js'
import { SkillPackageSchema, type SkillPackage } from '../schemas/skill-library.js'
import { ConfigChangeSchema, ConfigMutationError, configRevision, mutateConfig } from '../store/config-mutation.js'
import { ConfigMissingError, loadConfig } from '../store/config-store.js'
import { readServerMarker } from '../web/marker.js'
import { isPtyAvailable } from '../web/session.js'
import { parseFrontmatter } from '../store/frontmatter.js'
import { PROTECTED_BASENAMES, PROTECTED_DIRECTORIES, resolveLoopPaths } from '../store/paths.js'
import { StalePreconditionError } from '../store/precondition.js'
import {
  acceptProfile,
  listAcceptedRevisions,
  proposedProfileFile,
  readAcceptedProfile,
  readAcceptedRevision,
  readProposedProfile,
} from '../store/project-profile-store.js'
import {
  acceptSkill,
  listAcceptances,
  removeAcceptance,
  setAcceptanceStatus,
} from '../store/skill-acceptance-store.js'
import { listPackages, readPackage, writePackage, type SkillLibraryListing } from '../store/skill-library-store.js'
import { readBoundedText } from '../util/bounded-body.js'
import { isEntrypoint } from '../util/entrypoint.js'

/**
 * Everything the `skills search|inspect|import|check-updates` pipeline needs
 * that could otherwise reach the network or spawn a process — the same
 * injection seam `deps.fetch` is throughout `ops/skill-*.ts`, threaded down
 * to this CLI so `tests/cli/index.test.ts` can inject a fake `fetch` and a
 * fake sandbox backend/spawn and never touch the network or a real process
 * to exercise these commands. Every real caller gets `defaultCliDeps`.
 */
export interface CliDeps {
  fetch: typeof globalThis.fetch
  detectSandboxBackend: () => DetectedSandbox | null
  spawn: typeof nodeSpawn
}

const defaultCliDeps: CliDeps = {
  fetch: globalThis.fetch,
  detectSandboxBackend,
  spawn: nodeSpawn,
}

const USAGE = `usage: mjloop-cli <command>

  summary [--dir <path>] [--json]      print the current loop state
  config get [--dir <path>] [--json]   print the orchestration settings and the config revision
  config set <key> <value> [--dir <path>]
                                       change one orchestration setting through the guarded write
  profile show [--dir <path>] [--json] print the accepted component map, the proposal, and whether they differ
  profile accept [--dir <path>] [--expect <revision|none>] [--from <revision>]
                                       accept the current proposal as the next immutable revision;
                                       --from reselects an earlier accepted revision's map instead
  profile reject [--dir <path>]        discard the current proposal, leaving the accepted map active
  skills list [--dir <path>] [--json]  print this machine's skill library and this project's acceptances
  skills accept <packageDigest> [--dir <path>] [--components a,b] [--agents builder,critic] [--policy auto|review|pinned]
                                       accept one digest of a library package into this project
  skills disable <skillId> [--dir <path>]
                                       turn off an accepted skill without removing its acceptance
  skills enable <skillId> [--dir <path>]
                                       turn a disabled acceptance back on
  skills remove <skillId> [--dir <path>]
                                       remove this project's acceptance only — the package and every
                                       other project's acceptance are untouched
  skills search <query> [--source github|registry|web|skills-sh] [--dir <path>] [--json]
                                       metadata-only candidates from an allowed source — nothing is
                                       written, and no candidate becomes active on its own
  skills inspect <url> [--ref <ref>] [--dir <path>] [--json]
                                       pin, fetch, and sandbox one candidate; print its report; write nothing
  skills import <url> [--ref <ref>] [--dir <path>]
                                       inspect, sandbox, and on a passed audit write the package into
                                       this machine's library — this does not accept it into the project;
                                       accept the printed digest separately with skills accept
  skills check-updates [--dir <path>] [--json]
                                       report a new upstream revision as a candidate for each acceptance
                                       whose policy is not pinned — never imports, never moves a digest
  session-start                        SessionStart hook (reads hook JSON on stdin)
  state-guard                          PreToolUse hook (reads hook JSON on stdin)
  stop-guard                           Stop hook (reads hook JSON on stdin)
`

export interface CliResult {
  stdout: string
  exitCode: number
}

export async function runCli(argv: string[], stdin: string, deps: CliDeps = defaultCliDeps): Promise<CliResult> {
  const [command, ...rest] = argv
  switch (command) {
    case 'summary':
      return summaryCommand(rest)
    case 'config':
      return configCommand(rest)
    case 'profile':
      return profileCommand(rest)
    case 'skills':
      return skillsCommand(rest, deps)
    case 'session-start':
      return sessionStartCommand(stdin)
    case 'state-guard':
      return stateGuardCommand(stdin)
    case 'stop-guard':
      return stopGuardCommand(stdin)
    default:
      return { stdout: USAGE, exitCode: 1 }
  }
}

async function summaryCommand(args: string[]): Promise<CliResult> {
  const dirIndex = args.indexOf('--dir')
  const dir = dirIndex === -1 ? process.cwd() : args[dirIndex + 1] ?? process.cwd()
  const summary = await stateSummary(dir)
  const stdout = args.includes('--json') ? `${JSON.stringify(summary, null, 2)}\n` : `${renderSummaryLine(summary)}\n`
  return { stdout, exitCode: 0 }
}

/* ------------------------------------------------------------------ config */

/**
 * `config get` / `config set`: the concrete path for configuring a project from
 * a session, and the reason `/mjloop:config` exists.
 *
 * **Nothing here writes YAML.** Every change goes through `mutateConfig`, the
 * same guarded route the cockpit's `config.patch` takes, and that is the whole
 * point of the subcommand: the guarded write is the only thing that
 * compare-and-swaps on the file's sha256 revision, re-parses the *whole*
 * document afterwards, and refuses the write outright when the result would be
 * a config no op can load. A model editing `.mjloop/config.yaml` with `Edit`
 * gets none of the three — it can silently clobber a concurrent edit, and it
 * can leave behind a document that only fails the next time somebody starts a
 * run.
 */

/**
 * A value typed on a command line, once it is the JavaScript type its setting
 * is declared with.
 *
 * `reason` is what the person did wrong in their own terms. It exists because
 * `ConfigChangeSchema` cannot say "that is not a number" about the string
 * `"lots"` — by the time a schema sees a value, the shell's everything-is-text
 * has already been decided one way or the other, and deciding it wrongly here
 * would produce a bounds error about a value nobody typed.
 */
type ParsedValue = { ok: true; value: unknown } | { ok: false; reason: string }

interface ConfigSetting {
  /** Where the value lives in a loaded config, for `config get`. */
  read: (orchestration: Orchestration) => unknown
  /** The command-line word, as this setting's own JavaScript type. */
  parse: (raw: string) => ParsedValue
  /** The single `ConfigChange` this key becomes — built, never trusted. */
  change: (value: unknown) => unknown
}

function asBoolean(raw: string): ParsedValue {
  if (raw === 'true') return { ok: true, value: true }
  if (raw === 'false') return { ok: true, value: false }
  return { ok: false, reason: 'expects true or false' }
}

function asInteger(raw: string): ParsedValue {
  // Deliberately not `Number(raw)` on its own: that reads `''` as 0 and `'1e2'`
  // as 100, and a config setting arriving from a typo is worse than a refusal.
  if (!/^-?\d+$/.test(raw)) return { ok: false, reason: 'expects a whole number' }
  return { ok: true, value: Number(raw) }
}

/** A word, as typed. Which words are legal is `ConfigChangeSchema`'s to say. */
function asWord(raw: string): ParsedValue {
  return { ok: true, value: raw }
}

/**
 * A comma-separated list, where the empty string is the empty list.
 *
 * Both list settings treat empty as a real, meaningful value — no external
 * skill discovery at all, no trusted registry — so there has to be a way to
 * type it, and `config set orchestration.skills.sources ''` is it.
 */
function asList(raw: string): ParsedValue {
  return {
    ok: true,
    value: raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  }
}

/**
 * The dotted keys `config set` accepts, and the one `ConfigChange` each becomes.
 *
 * The only place in this file that knows a setting's name. The usage text, the
 * unknown-key message and `config get`'s output all read off it, so a key can
 * never be settable but unprintable, or offered but unsettable.
 *
 * `orchestration.quality.*` is the one place where two dotted keys collapse
 * into a single change kind carrying a `key`, because that is the shape
 * `config-mutation.ts` gives that section. The mapping is stated here rather
 * than derived from the dots for exactly that reason: the dotted key is what a
 * person types, and the change kind is what the wire schema discriminates on,
 * and they are not obliged to agree.
 */
const SETTINGS: Record<string, ConfigSetting> = {
  'orchestration.profile.auto_accept': {
    read: (orchestration) => orchestration.profile.auto_accept,
    parse: asBoolean,
    change: (value) => ({ kind: 'orchestration.profile.auto_accept', value }),
  },
  'orchestration.discovery.mode': {
    read: (orchestration) => orchestration.discovery.mode,
    parse: asWord,
    change: (value) => ({ kind: 'orchestration.discovery.mode', value }),
  },
  'orchestration.discovery.question_budget': {
    read: (orchestration) => orchestration.discovery.question_budget,
    parse: asInteger,
    change: (value) => ({ kind: 'orchestration.discovery.question_budget', value }),
  },
  'orchestration.discovery.completion': {
    read: (orchestration) => orchestration.discovery.completion,
    parse: asWord,
    change: (value) => ({ kind: 'orchestration.discovery.completion', value }),
  },
  'orchestration.execution.after_plan_approval': {
    read: (orchestration) => orchestration.execution.after_plan_approval,
    parse: asWord,
    change: (value) => ({ kind: 'orchestration.execution.after_plan_approval', value }),
  },
  'orchestration.execution.uncertain_concurrency': {
    read: (orchestration) => orchestration.execution.uncertain_concurrency,
    parse: asWord,
    change: (value) => ({ kind: 'orchestration.execution.uncertain_concurrency', value }),
  },
  'orchestration.execution.repair_attempts': {
    read: (orchestration) => orchestration.execution.repair_attempts,
    parse: asInteger,
    change: (value) => ({ kind: 'orchestration.execution.repair_attempts', value }),
  },
  'orchestration.quality.independent_plan_review': {
    read: (orchestration) => orchestration.quality.independent_plan_review,
    parse: asBoolean,
    change: (value) => ({ kind: 'orchestration.quality', key: 'independent_plan_review', value }),
  },
  'orchestration.quality.independent_verification': {
    read: (orchestration) => orchestration.quality.independent_verification,
    parse: asBoolean,
    change: (value) => ({ kind: 'orchestration.quality', key: 'independent_verification', value }),
  },
  'orchestration.skills.sources': {
    read: (orchestration) => orchestration.skills.sources,
    parse: asList,
    change: (value) => ({ kind: 'orchestration.skills.sources', value }),
  },
  'orchestration.skills.trusted_registries': {
    read: (orchestration) => orchestration.skills.trusted_registries,
    parse: asList,
    change: (value) => ({ kind: 'orchestration.skills.trusted_registries', value }),
  },
  'orchestration.skills.update_mode': {
    read: (orchestration) => orchestration.skills.update_mode,
    parse: asWord,
    change: (value) => ({ kind: 'orchestration.skills.update_mode', value }),
  },
}

async function configCommand(args: string[]): Promise<CliResult> {
  const [subcommand, ...rest] = args
  if (subcommand === 'get') return configGetCommand(rest)
  if (subcommand === 'set') return configSetCommand(rest)
  return { stdout: USAGE, exitCode: 1 }
}

async function configGetCommand(args: string[]): Promise<CliResult> {
  const { dir, json, empty } = parseArgs(args)
  const refusal = refuseEmptyFlag(empty)
  if (refusal !== null) return refusal

  const file = resolveLoopPaths(dir).config

  // The revision is the sha256 of the exact bytes on disk, because that is what
  // `mutateConfig` compares its patch against. Hashing a re-serialisation of
  // the parsed config would produce a revision for a document nobody wrote, and
  // every `config set` built on it would be refused as stale.
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return fail(`${file} not found — run /mjloop:init first`)
  }

  let orchestration: Orchestration
  try {
    orchestration = (await loadConfig(dir)).orchestration
  } catch (error) {
    // Reported rather than filled in from the schema's prefaults: a config that
    // does not parse is a project configured by nothing at all, and printing
    // the defaults would tell somebody their settings are in force when the
    // next op that loads config is about to fail.
    return fail(describe(error))
  }

  const revision = configRevision(raw)
  if (json) return { stdout: `${JSON.stringify({ revision, orchestration }, null, 2)}\n`, exitCode: 0 }
  return { stdout: renderOrchestration(revision, orchestration), exitCode: 0 }
}

async function configSetCommand(args: string[]): Promise<CliResult> {
  const { dir, positional, empty } = parseArgs(args)
  // Before the arity check below, not after: a line missing its `--dir` path is
  // also, usually, a line missing the words that were meant to follow it, and
  // "config set needs a key and a value" would send somebody looking at the
  // half of the line that is fine.
  const refusal = refuseEmptyFlag(empty)
  if (refusal !== null) return refusal

  const [key, raw] = positional
  if (key === undefined || raw === undefined) {
    return fail('config set needs a key and a value: mjloop-cli config set <key> <value> [--dir <path>]')
  }

  // Own-property lookup, for the reason `hasKey` in the detector uses one: a
  // plain `SETTINGS[key]` answers `toString` with a function and `__proto__`
  // with an object, so an `=== undefined` guard lets both past and the `.parse`
  // below throws a TypeError nothing in this file catches — the binary prints a
  // Node stack trace where the list of keys belongs.
  const setting = Object.hasOwn(SETTINGS, key) ? SETTINGS[key] : undefined
  if (setting === undefined) return fail(`${key} is not a setting. The keys config set accepts:\n${keyList()}`)

  const parsed = setting.parse(raw)
  if (!parsed.ok) return fail(`${key} ${parsed.reason} — got "${raw}"`)

  // Refused at the wire schema before the file is ever opened, so an
  // out-of-range value costs nothing and cannot half-apply.
  const change = ConfigChangeSchema.safeParse(setting.change(parsed.value))
  if (!change.success) return fail(`${key} does not accept "${raw}":\n${z.prettifyError(change.error)}`)

  const file = resolveLoopPaths(dir).config
  let current: string
  try {
    current = await fs.readFile(file, 'utf8')
  } catch {
    return fail(`${file} not found — run /mjloop:init first`)
  }

  try {
    const { revision } = await mutateConfig(dir, { revision: configRevision(current), changes: [change.data] })
    return { stdout: `${key} = ${renderValue(parsed.value)}\nrevision ${revision}\n`, exitCode: 0 }
  } catch (error) {
    if (!(error instanceof ConfigMutationError)) return fail(describe(error))
    if (error.kind === 'missing') return fail(`${file} not found — run /mjloop:init first`)
    if (error.kind === 'stale') {
      // The compare-and-swap earned its keep: somebody else wrote the file
      // between the read above and the locked read inside `mutateConfig`.
      // Re-running is safe and re-reads; retrying automatically would be
      // applying this change on top of an edit nobody has looked at.
      return fail(`${file} changed after this command read it — nothing was written. Run the command again.`)
    }
    const where = error.path.length === 0 ? '' : ` at ${error.path.join('.')}`
    return fail(`${key} = ${renderValue(parsed.value)} would make ${file} invalid${where} — nothing was written.`)
  }
}

function renderOrchestration(revision: string, orchestration: Orchestration): string {
  const entries = Object.entries(SETTINGS)
  const width = Math.max(...entries.map(([key]) => key.length))
  const lines = entries.map(([key, setting]) => `${key.padEnd(width)}  ${renderValue(setting.read(orchestration))}`)
  return `revision ${revision}\n${lines.join('\n')}\n`
}

function renderValue(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join(', ')
  return String(value)
}

function keyList(): string {
  return Object.keys(SETTINGS)
    .map((key) => `  ${key}`)
    .join('\n')
}

function fail(text: string): CliResult {
  return { stdout: `${text}\n`, exitCode: 1 }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface CliArgs {
  dir: string
  json: boolean
  /**
   * `--expect <value>`, exactly as typed.
   *
   * `undefined` — the flag was not given — is a different answer from the word
   * `none`, and the two must not collapse: `none` is an assertion that nothing
   * is accepted yet and is refused when something is, while an absent flag asks
   * this command to read the current revision for the caller.
   */
  expect: string | undefined
  /**
   * `--from <revision>`, exactly as typed.
   *
   * Absent means "accept the proposal", which is a different source of
   * components rather than a different way of reading the same one: with the
   * flag, `proposed.json` is not opened at all. That is what makes a rollback
   * reachable on a project whose last scan was discarded, or never ran.
   */
  from: string | undefined
  /** `--components <a,b>` for `skills accept`, exactly as typed — split into ids by the caller. */
  components: string | undefined
  /** `--agents <a,b>` for `skills accept`, exactly as typed — split into names by the caller. */
  agents: string | undefined
  /** `--policy <word>` for `skills accept`, exactly as typed — validated against `SkillUpdateModeSchema` by the caller. */
  policy: string | undefined
  /** `--source <word>` for `skills search`, exactly as typed — validated against `SkillSourceSchema` by the caller. */
  source: string | undefined
  /** `--ref <ref>` for `skills inspect`/`skills import`, exactly as typed — a branch, tag, or sha to pin. */
  ref: string | undefined
  positional: string[]
  /**
   * Flags typed with no word after them, in the order they appeared.
   *
   * Collected rather than ignored because "the flag was not given" and "the
   * flag was given and its value went missing" are different mistakes with
   * opposite safe answers, and only the parser can still tell them apart. Every
   * subcommand refuses on a non-empty list — see `refuseEmptyFlag`.
   */
  empty: string[]
}

/**
 * What each value-consuming flag takes, in the words a refusal uses.
 *
 * The `--expect` wording is the same sentence `profile accept` uses when the
 * value is present but nonsense, on purpose: a person who typed the flag wrong
 * and a person whose shell ate the value have made the same mistake about the
 * same flag, and telling them two different things about it helps neither.
 */
const FLAG_VALUES: Record<string, string> = {
  '--dir': 'the path of the project to act on',
  '--expect': 'a revision number or the word none',
  '--from': 'the number of the accepted revision whose component map to reselect',
  '--components': 'a comma-separated list of component ids from the accepted map',
  '--agents': 'a comma-separated list of agent roles (planner, builder, critic, verifier)',
  '--policy': 'auto, review or pinned',
  '--source': 'github, registry, web or skills-sh',
  '--ref': 'a branch, tag, or commit sha to pin',
}

/**
 * A flag whose value went missing, as a refusal rather than a default.
 *
 * Falling back is the dangerous reading of an empty flag in every case this
 * file has. An unquoted `--expect $REV` with `REV` unset leaves a bare
 * `--expect` on the line; read as absent, it silently becomes the auto-read
 * path, and the acceptance the flag was typed to guard proceeds at exit 0 — the
 * one thing `--expect` exists to prevent. A bare `--from` is worse still: read
 * as absent it is not a rollback that failed but an ordinary acceptance of
 * whatever the tree last scanned to, which is the exact map the rollback was
 * typed to get away from. A bare `--dir` falls back to
 * `process.cwd()`, which is not this project but some other one, and `config
 * set`, `profile accept` and `profile reject` all write. Neither miss is
 * something the caller can see afterwards, so it is refused before anything is
 * read or written.
 */
function refuseEmptyFlag(empty: string[]): CliResult | null {
  const flag = empty[0]
  if (flag === undefined) return null
  return fail(`${flag} was given with nothing after it — it takes ${FLAG_VALUES[flag] ?? 'a value'}`)
}

/**
 * Flags anywhere, positionals in order.
 *
 * The positionals cannot simply be "every word that does not start with a
 * dash": `--dir` consumes the word after it, and without that rule
 * `config set <key> <value> --dir <path>` would read the project path as a
 * third positional — or, with the flag in front, read it as the value. The same
 * is true of `--expect` and `--from`, which is why they are handled here rather
 * than fished out of the positionals by the one subcommand that takes them.
 */
function parseArgs(args: string[]): CliArgs {
  let dir = process.cwd()
  let json = false
  let expected: string | undefined
  let from: string | undefined
  let components: string | undefined
  let agents: string | undefined
  let policy: string | undefined
  let source: string | undefined
  let ref: string | undefined
  const positional: string[] = []
  const empty: string[] = []
  // One flag name to the local it fills — every entry here takes a value and
  // is refused rather than defaulted when that value is missing, for the
  // reason `refuseEmptyFlag` gives: a shell variable that expanded to nothing
  // must not silently read as "the flag was never given".
  const valueFlags: Record<string, (value: string) => void> = {
    '--dir': (value) => { dir = value },
    '--expect': (value) => { expected = value },
    '--from': (value) => { from = value },
    '--components': (value) => { components = value },
    '--agents': (value) => { agents = value },
    '--policy': (value) => { policy = value },
    '--source': (value) => { source = value },
    '--ref': (value) => { ref = value },
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg !== undefined && Object.hasOwn(valueFlags, arg)) {
      const value = args[index + 1]
      if (value === undefined) {
        empty.push(arg)
        continue
      }
      valueFlags[arg]?.(value)
      index += 1
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg !== undefined) positional.push(arg)
  }
  return { dir, json, expect: expected, from, components, agents, policy, source, ref, positional, empty }
}

/* ----------------------------------------------------------------- profile */

/**
 * `profile show` / `profile accept` / `profile reject`: the only way a person
 * decides what this project is made of.
 *
 * Without them the component map is unreachable. The auto-accept setting
 * defaults to `false`, and the one other caller of `acceptProfile` — `initLoop`
 * — fires only when that setting is `true` *and* only while nothing is accepted
 * yet. So a project on the defaults could never obtain a component map at all,
 * and no project could ever supersede one: the store's `expectRevision` and
 * `supersedes` would be machinery nothing could reach. The plan this implements
 * requires the opposite on both counts — routing waits for a person to accept,
 * and accepting a replacement keeps the prior revision for audit and rollback.
 *
 * **These are deliberately not offered to the browser.** Accepting a component
 * map activates routing for every later run, which is the class of write
 * `web/writes.ts` permanently denies; the cockpit shows the map and the
 * difference and stops there. The decision lives here, where a person types it.
 */

async function profileCommand(args: string[]): Promise<CliResult> {
  const [subcommand, ...rest] = args
  if (subcommand === 'show') return profileShowCommand(rest)
  if (subcommand === 'accept') return profileAcceptCommand(rest)
  if (subcommand === 'reject') return profileRejectCommand(rest)
  return { stdout: USAGE, exitCode: 1 }
}

async function profileShowCommand(args: string[]): Promise<CliResult> {
  const { dir, json, empty } = parseArgs(args)
  const refusal = refuseEmptyFlag(empty)
  if (refusal !== null) return refusal

  let accepted: ProjectProfile | null
  let proposed: ProposedProfile | null
  try {
    accepted = await readAcceptedProfile(dir)
    proposed = await readProposedProfile(dir)
  } catch (error) {
    // An accepted revision that exists and no longer parses. The store throws
    // for that rather than answering null, and this command must not soften it
    // back into "nothing is accepted": that reads as a project nobody has
    // mapped, while the record is sitting on disk being unreadable.
    return fail(describe(error))
  }

  // Exit 0 either way. "No component map is accepted" is the state every
  // project starts in and the state `auto_accept: false` leaves it in — a
  // non-zero exit would make the ordinary case look like a failure to whatever
  // reads this next.
  const differs = proposed !== null && (accepted === null || !sameComponents(accepted.components, proposed.components))
  if (json) return { stdout: `${JSON.stringify({ accepted, proposed, differs }, null, 2)}\n`, exitCode: 0 }
  return { stdout: renderProfile(accepted, proposed, differs), exitCode: 0 }
}

/**
 * Where an acceptance takes its component map from, once that is settled.
 *
 * A refusal travels as a value rather than as a throw because deciding the
 * source is the first thing this command does and the last thing it can do
 * without touching `accepted/`: both ways of failing to obtain a map must leave
 * the tree byte-identical, and a `CliResult` in hand is the plainest way to see
 * that nothing between here and the refusal writes.
 */
type ProfileSource =
  | { ok: true; components: ProjectComponent[]; generatedAt: string; reselected: number | null }
  | { ok: false; refusal: CliResult }

/** The current proposal — the source `accept` has always had. */
async function proposalSource(dir: string): Promise<ProfileSource> {
  const proposed = await readProposedProfile(dir)
  if (proposed === null) {
    return {
      ok: false,
      refusal: fail(
        `there is no proposal to accept in ${resolveLoopPaths(dir).profile} — run mjloop init to scan the project first`,
      ),
    }
  }
  return { ok: true, components: proposed.components, generatedAt: proposed.generatedAt, reselected: null }
}

/**
 * An earlier accepted revision's map — `--from`, and the only reachable
 * rollback.
 *
 * Without it the accepted map can only ever become whatever the tree currently
 * scans to, because `proposed.json` is written by one production caller and it
 * always writes a fresh `detectComponents`. Reselecting revision 1 after
 * revision 2 would then require the tree to happen to scan back to revision 1 —
 * which is exactly the case where nobody needed to roll back — and the escape
 * hatch of hand-editing the proposal is denied by `PROTECTED_DIRECTORIES`.
 *
 * `--from` naming the revision that is *already current* is allowed rather than
 * refused, and deliberately. The sibling case already behaves this way — an
 * `accept` of an unchanged proposal writes a new revision — and a refusal here
 * would be a rule about revision numbers wearing the costume of a rule about
 * component maps: `--from 2` while 2 is current and `--from 1` while revisions
 * 1 and 2 hold identical components are the same request in everything routing
 * can see, and only the first is detectable. Refusing it would also make the
 * exit code depend on state the caller may not have read, so every scripted
 * rollback would have to branch on it.
 */
async function revisionSource(dir: string, raw: string): Promise<ProfileSource> {
  // Listed before the value is even judged, so that *every* refusal below can
  // name the revisions that do exist. A malformed number is the refusal that
  // needs the roster most, not least: `--from 01` is the likely typo, because
  // the files on disk are named `rev-001.json`, and a bare "that is not a
  // number" leaves the one person who already knows they mistyped it with
  // nothing to retype.
  const revisions = await listAcceptedRevisions(dir)

  if (!/^[1-9]\d*$/.test(raw)) {
    // Refused rather than coerced, which is `--expect`'s reasoning one step
    // worse: a revision number *is* a filename here, so `Number('previous')`
    // would go looking for `rev-NaN.json` and come back reporting a missing
    // revision — telling somebody their history is gone when what went wrong is
    // the word they typed.
    return {
      ok: false,
      refusal: fail(`--from takes the number of an accepted revision — got "${raw}" — ${onRecord(revisions)}`),
    }
  }
  const wanted = Number(raw)

  // Membership decided against the listing before anything is opened. It keeps
  // a number no revision file could ever be named by from reaching the store at
  // all.
  if (!revisions.includes(wanted)) {
    return { ok: false, refusal: fail(`there is no accepted revision ${wanted} to reselect — ${onRecord(revisions)}`) }
  }

  let source: ProjectProfile | null
  try {
    source = await readAcceptedRevision(dir, wanted)
  } catch (error) {
    // On record and no longer parsing. The roster goes out beside the error
    // rather than the error alone, because the next thing this person does is
    // choose a different revision and nothing else on the line tells them which
    // ones they have.
    return { ok: false, refusal: fail(`${describe(error)}\n${onRecord(revisions)}`) }
  }
  if (source === null) {
    // Listed a moment ago and gone now. Nothing in the engine deletes an
    // accepted revision, so this is a hand outside it, and continuing would
    // accept a map read from a file that no longer exists.
    return {
      ok: false,
      refusal: fail(`revision ${wanted} was on record a moment ago and is gone now — ${onRecord(revisions)}`),
    }
  }

  // The revision's own components and its own `generatedAt`. The timestamp is
  // carried rather than refreshed because it records when the scan behind this
  // map ran, and no scan ran here: stamping the present moment on a map nobody
  // re-scanned would be a small lie told inside an audit record.
  return { ok: true, components: source.components, generatedAt: source.generatedAt, reselected: wanted }
}

/** The revisions a refusal can offer instead, or the plain fact that there are none. */
function onRecord(revisions: number[]): string {
  if (revisions.length === 0) return 'no component map has ever been accepted in this project'
  return `the revisions on record are ${revisions.join(', ')}`
}

async function profileAcceptCommand(args: string[]): Promise<CliResult> {
  const { dir, expect: expected, from, empty } = parseArgs(args)
  const refusal = refuseEmptyFlag(empty)
  if (refusal !== null) return refusal

  // Which source, decided first and exclusively. With `--from` the proposal is
  // not read at all — not read and then ignored, not read as a fallback — so
  // whether one exists is irrelevant to a rollback, and a project that has just
  // rejected its last scan can still reselect any map in its history.
  const source = from === undefined ? await proposalSource(dir) : await revisionSource(dir, from)
  if (!source.ok) return source.refusal

  let expectRevision: number | null
  if (expected === undefined) {
    // Read for the caller, and a convenience rather than a bypass: the value
    // still travels into the store's compare-and-swap, so an acceptance that
    // lands between this read and the locked read inside `acceptProfile` is
    // still refused. What passing it cannot do is notice a revision that landed
    // *before* this command ran — which is exactly what `--expect` is for, and
    // why a person acting on something they read earlier should pass it.
    expectRevision = (await listAcceptedRevisions(dir)).at(-1) ?? null
  } else if (expected === 'none') {
    expectRevision = null
  } else if (/^[1-9]\d*$/.test(expected)) {
    expectRevision = Number(expected)
  } else {
    // Refused rather than coerced: `Number('latest')` is NaN, and a NaN
    // expectation compares unequal to every revision including the right one,
    // so the person would be told their revision had moved when it had not.
    return fail(`--expect takes a revision number or the word none — got "${expected}"`)
  }

  try {
    // `supersedes` is the store's to compute, and it computes it as the
    // revision that was current when the acceptance landed — never as the
    // revision `--from` named. Reselecting an earlier map is a forward move in
    // the audit chain: revision 3 replaces revision 2 whatever map it carries,
    // and a `supersedes` pointing backwards at 1 would leave revision 2 with
    // nothing recording that it stopped being current, so the history could no
    // longer be read as the sequence it is.
    const accepted = await acceptProfile(dir, {
      components: source.components,
      by: acceptedBy(),
      generatedAt: source.generatedAt,
      expectRevision,
    })
    const ids = accepted.components.map((component) => component.id)
    // Two clauses answering two questions that a rollback pulls apart: where
    // this map came from, and what it replaced. On an ordinary acceptance the
    // first is empty; on a rollback they are different numbers, and printing
    // only one of them would hide the move that was just made.
    const reselected = source.reselected === null ? '' : `, reselecting revision ${source.reselected}'s component map`
    const supersedes = accepted.supersedes === null ? '' : `, superseding revision ${accepted.supersedes}`
    return {
      stdout: `revision ${accepted.revision} accepted${reselected}${supersedes}\nactivated ${renderValue(ids)}\n`,
      exitCode: 0,
    }
  } catch (error) {
    if (error instanceof StalePreconditionError) {
      // The closing sentence names the thing to look at again, and after a
      // `--from` that is not the proposal: `profile show` prints the accepted
      // map, the proposal was never read, and telling somebody to go and check
      // a proposal they did not accept sends them to the wrong screen.
      const again =
        source.reselected === null
          ? 'then accept again if the proposal is still what you want.'
          : `then reselect revision ${source.reselected} again if its map is still the one you want.`
      return fail(
        `another acceptance landed first — nothing was written. ${error.message}. ` +
          `Re-read the project with mjloop-cli profile show, ${again}`,
      )
    }
    return fail(describe(error))
  }
}

async function profileRejectCommand(args: string[]): Promise<CliResult> {
  const { dir, empty } = parseArgs(args)
  const refusal = refuseEmptyFlag(empty)
  if (refusal !== null) return refusal

  if ((await readProposedProfile(dir)) === null) {
    return fail(`there is no proposal to discard in ${resolveLoopPaths(dir).profile}`)
  }

  const active = (await listAcceptedRevisions(dir)).at(-1) ?? null
  const file = proposedProfileFile(dir)
  // The `.bak` goes too, and that is not tidiness. `readProposedProfile` falls
  // back to it, and the atomic write leaves one behind on every scan after the
  // first, so removing only the primary would look like a rejection and then
  // hand the next reader the scan *before* the one just discarded.
  await fs.rm(file, { force: true })
  await fs.rm(`${file}.bak`, { force: true })

  // Nothing under `accepted/` is touched by any path through this command:
  // rejecting a proposal leaves the last accepted revision active, which is the
  // other half of the model whose first half is that accepting one keeps the
  // revision it replaced.
  const remains =
    active === null
      ? 'No component map is accepted.'
      : `Revision ${active} is still the accepted component map.`
  return { stdout: `proposal discarded. ${remains}\n`, exitCode: 0 }
}

/**
 * Who accepted it, computed here and never typed on the command line.
 *
 * The reasoning is `decidedBy`'s in `web/writes.ts`, and it transfers whole:
 * `acceptedBy` is the only record of why a revision exists, the engine cannot
 * verify a name, and a name the caller could supply would be a *forgeable*
 * audit record — worse than an unverified one. The prefix is the honest part
 * twice over: it survives a container with no passwd entry, and it says which
 * door the acceptance came through, so a revision somebody accepted from a
 * session is never confused with one `orchestration.profile.auto_accept` let
 * through unread.
 */
function acceptedBy(): string {
  let who = 'unknown'
  try {
    who = os.userInfo().username
  } catch {
    // No passwd entry — a container, usually.
  }
  return `cli:${who}`
}

/**
 * Do two component maps route work the same way?
 *
 * Field by field rather than by serialising both and comparing the strings: a
 * proposal and an accepted revision are built by different code paths, JSON key
 * order follows insertion order, and two records that mean exactly the same
 * thing could then be reported as different — asking somebody to accept a
 * change nobody made. `generatedAt` is deliberately not part of the comparison
 * for the same reason: a fresh scan of an unchanged tree is not a change.
 */
function sameComponents(left: ProjectComponent[], right: ProjectComponent[]): boolean {
  if (left.length !== right.length) return false
  // Positional, which is safe rather than lucky: the schema refuses any
  // component array that is not sorted by unique id, so two maps holding the
  // same components hold them in the same order.
  return left.every((one, index) => {
    const other = right[index]
    return (
      other !== undefined &&
      one.id === other.id &&
      one.root === other.root &&
      one.technology === other.technology &&
      one.verification.test === other.verification.test &&
      one.verification.lint === other.verification.lint &&
      one.verification.build === other.verification.build &&
      one.skillTags.length === other.skillTags.length &&
      one.skillTags.every((tag, tagIndex) => tag === other.skillTags[tagIndex])
    )
  })
}

function renderProfile(accepted: ProjectProfile | null, proposed: ProposedProfile | null, differs: boolean): string {
  const lines: string[] = []

  if (accepted === null) {
    lines.push('no component map is accepted — nothing is routed by component until one is')
  } else {
    const supersedes = accepted.supersedes === null ? '' : ` (supersedes revision ${accepted.supersedes})`
    lines.push(`revision ${accepted.revision} accepted ${accepted.acceptedAt} by ${accepted.acceptedBy}${supersedes}`)
    lines.push(`  scanned ${accepted.generatedAt}`)
    lines.push(...renderComponents(accepted.components))
  }

  lines.push('')
  if (proposed === null) {
    lines.push('no proposal on record — run mjloop init to scan the project')
  } else {
    lines.push(`proposal scanned ${proposed.generatedAt}`)
    lines.push(...renderComponents(proposed.components))
    lines.push('')
    // The line the whole subcommand exists for: a person deciding whether to
    // accept needs the comparison made for them, not two lists to diff by eye.
    if (!differs) {
      lines.push('the proposal matches the accepted component map — there is nothing to accept')
    } else if (accepted === null) {
      lines.push('the proposal has never been accepted — accept it with: mjloop-cli profile accept')
    } else {
      lines.push(
        'the proposal differs from the accepted component map — accept it with: mjloop-cli profile accept',
        'or discard it and keep the accepted map with: mjloop-cli profile reject',
      )
    }
  }

  return `${lines.join('\n')}\n`
}

function renderComponents(components: ProjectComponent[]): string[] {
  if (components.length === 0) return ['  (no components)']
  return components.flatMap((component) => [
    `  ${component.id}  root ${component.root}  technology ${component.technology}  tags ${renderValue(component.skillTags)}`,
    `    test   ${renderSlot(component.verification.test)}`,
    `    lint   ${renderSlot(component.verification.lint)}`,
    `    build  ${renderSlot(component.verification.build)}`,
  ])
}

/** A verify slot with nothing declared behind it, said rather than left blank. */
function renderSlot(command: string | null): string {
  return command ?? '(none)'
}

/* ------------------------------------------------------------------ skills */

/**
 * `skills list` / `skills accept` / `skills disable` / `skills enable` /
 * `skills remove`: the only user-reachable route into the shared, user-local
 * skill library and this project's acceptances of it.
 *
 * Without a command here, the library and the acceptance store built by S06
 * are both fully-formed capabilities with no way for a person to ever call
 * them — the exact lesson this plan has already paid for three times.
 *
 * **These are deliberately not offered to the browser.** Accepting a skill
 * activates it for every later dispatch, which is the class of write
 * `web/writes.ts` permanently denies; the cockpit's `/api/skills` reports the
 * library and this project's acceptances and stops there. The decision lives
 * here, where a person types it.
 */

async function skillsCommand(args: string[], deps: CliDeps): Promise<CliResult> {
  const [subcommand, ...rest] = args
  if (subcommand === 'list') return skillsListCommand(rest)
  if (subcommand === 'accept') return skillsAcceptCommand(rest)
  if (subcommand === 'disable') return skillsSetStatusCommand(rest, 'disabled')
  if (subcommand === 'enable') return skillsSetStatusCommand(rest, 'active')
  if (subcommand === 'remove') return skillsRemoveCommand(rest)
  if (subcommand === 'search') return skillsSearchCommand(rest, deps)
  if (subcommand === 'inspect') return skillsInspectCommand(rest, deps)
  if (subcommand === 'import') return skillsImportCommand(rest, deps)
  if (subcommand === 'check-updates') return skillsCheckUpdatesCommand(rest, deps)
  return { stdout: USAGE, exitCode: 1 }
}

async function skillsListCommand(args: string[]): Promise<CliResult> {
  const { dir, json, empty } = parseArgs(args)
  const refusal = refuseEmptyFlag(empty)
  if (refusal !== null) return refusal

  // Exit 0 on an empty library and on a project with no acceptances: both are
  // the state every machine and every project start in, not a failure.
  let library: SkillLibraryListing
  let acceptances: ProjectSkillAcceptance[]
  try {
    ;[library, acceptances] = await Promise.all([listPackages(dir), listAcceptances(dir)])
  } catch (error) {
    // An acceptance record that exists and no longer parses, or a
    // `MJLOOP_DATA_HOME` that resolves somewhere the library may not live.
    // `profileShowCommand` relays exactly this class of throw and says why:
    // the store must not soften it, and this command must not let it escape
    // `runCli` either — an unhandled rejection is a stack trace on stderr and
    // nothing on stdout, so `--json` would produce no parseable output at all.
    return fail(describe(error))
  }

  if (json) {
    // `packageHeld` is computed rather than left to the reader for the reason
    // the rendered view marks it: a script joining two 64-character hex strings
    // to discover that an acceptance resolves to nothing is a join every
    // consumer would have to get right separately.
    const held = new Set(library.packages.map((pkg) => pkg.digest))
    const annotated = acceptances.map((acceptance) => ({ ...acceptance, packageHeld: held.has(acceptance.digest) }))
    return { stdout: `${JSON.stringify({ ...library, acceptances: annotated }, null, 2)}\n`, exitCode: 0 }
  }
  return { stdout: renderSkills(library, acceptances), exitCode: 0 }
}

function renderSkills(library: SkillLibraryListing, acceptances: ProjectSkillAcceptance[]): string {
  const { packages, unreadable } = library
  const lines: string[] = ['this machine\'s skill library:']
  if (packages.length === 0) {
    lines.push('  (none) — nothing has been imported into this machine\'s skill library yet')
  } else {
    for (const pkg of packages) {
      lines.push(`  ${pkg.digest}  ${pkg.skillName}  package ${pkg.packageId}`)
      lines.push(`    source ${pkg.source.kind}  ${pkg.source.url}  revision ${pkg.source.revision}`)
      lines.push(`    license ${pkg.license.spdx ?? '(none)'}  audit ${pkg.audit.state}`)
    }
  }

  // Said rather than skipped silently. `listPackages` walks a machine-wide
  // directory, so an entry it could not read may well belong to another
  // project — but this is the only place on the machine that would ever
  // mention it, and a person here is the only one who can clear it.
  for (const entry of unreadable) {
    lines.push(`  ${entry.digest}  (unreadable) ${entry.reason.split('\n')[0] ?? ''}`)
  }

  lines.push('')
  lines.push('this project\'s acceptances:')
  if (acceptances.length === 0) {
    lines.push('  (none)')
  } else {
    // Which digests this machine can actually resolve. An acceptance record
    // travels in the repository and a library package does not, so a teammate
    // on a fresh clone has every acceptance and no packages — the ordinary
    // case, not an exotic one. Left unmarked, such a row reads `status active`
    // while `resolveSkillManifest` silently drops it, and the only way to
    // notice would be to compare two 64-character hex strings by eye.
    const held = new Set(packages.map((pkg) => pkg.digest))
    for (const acceptance of acceptances) {
      const absent = held.has(acceptance.digest) ? '' : '  (package not in this machine\'s library)'
      lines.push(
        `  ${acceptance.skillId}  digest ${acceptance.digest}  status ${acceptance.status}  policy ${acceptance.updatePolicy}${absent}`,
      )
      lines.push(`    components ${renderValue(acceptance.components)}  agents ${renderValue(acceptance.agents)}`)
    }
  }

  return `${lines.join('\n')}\n`
}

async function skillsAcceptCommand(args: string[]): Promise<CliResult> {
  const { dir, positional, components, agents, policy, empty } = parseArgs(args)
  const refusal = refuseEmptyFlag(empty)
  if (refusal !== null) return refusal

  const [digest] = positional
  if (digest === undefined) {
    return fail('skills accept needs a package digest: mjloop-cli skills accept <packageDigest> [--dir <path>]')
  }

  let updatePolicy: SkillUpdateMode
  if (policy === undefined) {
    // Offered as a default from this project's own configured update_mode,
    // and never consulted again after this acceptance is written —
    // `ProjectSkillAcceptanceSchema.updatePolicy`'s comment says why: a
    // global policy that could keep changing an already-accepted skill's
    // behaviour is exactly the stop condition this field exists to forbid.
    //
    // A project with no config yet gets `ConfigSchema`'s own default
    // (`'review'`) rather than a refusal to run `mjloop init` first: nothing
    // about accepting a skill requires a provisioned `.mjloop/`, and a
    // config that fails to *parse* is the only config problem worth
    // refusing over here.
    updatePolicy = 'review'
    try {
      updatePolicy = (await loadConfig(dir)).orchestration.skills.update_mode
    } catch (error) {
      if (!(error instanceof ConfigMissingError)) return fail(describe(error))
    }
  } else {
    const parsedPolicy = SkillUpdateModeSchema.safeParse(policy)
    if (!parsedPolicy.success) return fail(`--policy takes auto, review or pinned — got "${policy}"`)
    updatePolicy = parsedPolicy.data
  }

  try {
    const accepted = await acceptSkill(dir, {
      packageDigest: digest,
      components: components === undefined ? [] : splitList(components),
      agents: agents === undefined ? [] : splitList(agents),
      updatePolicy,
      acceptedBy: acceptedBy(),
    })
    return {
      stdout:
        `accepted "${accepted.skillId}" at digest ${accepted.digest}\n` +
        `components ${renderValue(accepted.components)}\n` +
        `agents ${renderValue(accepted.agents)}\n` +
        `policy ${accepted.updatePolicy}\n`,
      exitCode: 0,
    }
  } catch (error) {
    // Every refusal `acceptSkill` can throw already names what to do instead
    // — an unknown digest, an unaudited package, an unknown component, an
    // unknown agent, or a source already accepted — so this command adds
    // nothing to the message and simply relays it.
    return fail(describe(error))
  }
}

async function skillsSetStatusCommand(args: string[], status: ProjectSkillAcceptance['status']): Promise<CliResult> {
  const { dir, positional, empty } = parseArgs(args)
  const refusal = refuseEmptyFlag(empty)
  if (refusal !== null) return refusal

  const [skillId] = positional
  if (skillId === undefined) {
    const verb = status === 'disabled' ? 'disable' : 'enable'
    return fail(`skills ${verb} needs a skill id: mjloop-cli skills ${verb} <skillId> [--dir <path>]`)
  }

  try {
    const updated = await setAcceptanceStatus(dir, skillId, status)
    return { stdout: `"${updated.skillId}" is now ${updated.status}\n`, exitCode: 0 }
  } catch (error) {
    return fail(describe(error))
  }
}

async function skillsRemoveCommand(args: string[]): Promise<CliResult> {
  const { dir, positional, empty } = parseArgs(args)
  const refusal = refuseEmptyFlag(empty)
  if (refusal !== null) return refusal

  const [skillId] = positional
  if (skillId === undefined) {
    return fail('skills remove needs a skill id: mjloop-cli skills remove <skillId> [--dir <path>]')
  }

  try {
    await removeAcceptance(dir, skillId)
  } catch (error) {
    return fail(describe(error))
  }

  // Named explicitly, because it is the story's central isolation claim:
  // this command touches exactly one file under this project's own
  // .mjloop/skills/, and nothing else.
  return {
    stdout: `removed this project's acceptance of "${skillId}" — the package itself and every other project's acceptance are untouched\n`,
    exitCode: 0,
  }
}

/* --------------------------------------------------- external discovery/import */

/**
 * `skills search` / `skills inspect` / `skills import` / `skills check-updates`:
 * the CLI pipeline over S07's discovery/inspection/sandbox ops.
 *
 * Three things are load-bearing here, mirroring the ops modules underneath:
 *
 *  - `search` returns metadata-only candidates and writes nothing. A
 *    candidate is a search result, never a package, and never reaches skill
 *    selection — see `SkillCandidateSchema`'s own comment.
 *  - `import` writes a package into this machine's shared library on a
 *    passed audit. It does **not** accept it into this project — that stays
 *    the separate, explicit `skills accept <digest>` decision, and every
 *    success message says so.
 *  - A failed inspection or import prints its reason and the one thing a
 *    person may do next — search a different candidate — and never searches
 *    again on its own; the story's stop condition forbids exactly that.
 */

const GITHUB_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/

/** Build a metadata-only candidate from a bare GitHub repository url, for `inspect`/`import`. */
function candidateFromUrl(url: string, ref: string): SkillCandidate | null {
  const match = GITHUB_URL.exec(url)
  if (match === null) return null
  const [, owner, name] = match
  const repository = `${owner}/${name}`
  const parsed = SkillCandidateSchema.safeParse({
    source: 'github',
    url,
    repository,
    ref,
    skillName: name,
    description: `candidate discovered at ${repository}`,
  })
  return parsed.success ? parsed.data : null
}

function isRecordCli(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The same two rules every fetch in this pipeline shares: never follow a cross-host redirect, never accept an unbounded body. */
async function fetchJsonBounded(url: string, deps: CliDeps): Promise<unknown> {
  const requestedHost = new URL(url).host
  // `redirect: 'manual'`, so a redirect is refused rather than performed and
  // then regretted; and the body is read under the cap rather than buffered
  // whole and measured afterwards.
  const response = await deps.fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mjloop-skill-import' },
    redirect: 'manual',
    signal: AbortSignal.timeout(STAGING_REQUEST_TIMEOUT_MS),
  })
  const actualHost = new URL(response.url || url).host
  if (actualHost !== requestedHost) {
    throw new Error(`refused a redirect from "${requestedHost}" to "${actualHost}" while staging package content`)
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`refused a redirect from "${requestedHost}" while staging package content — a redirect is never followed here`)
  }
  if (!response.ok) throw new Error(`request to "${url}" failed: ${response.status} ${response.statusText}`)
  const text = await readBoundedText(
    response,
    STAGING_RESPONSE_CAP,
    () => new Error(`response from "${url}" exceeded the ${STAGING_RESPONSE_CAP}-byte staging response cap — refused, not truncated`),
  )
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`response from "${url}" is not valid JSON`)
  }
}

/** No staging request may hang forever, for the same reason none may be unbounded in size. */
const STAGING_REQUEST_TIMEOUT_MS = 30_000
const STAGING_RESPONSE_CAP = 2_000_000
const STAGING_TREE_ENTRY_CAP = 500
const STAGING_FILE_BYTES_CAP = 200_000
const STAGING_TOTAL_BYTES_CAP = 5_000_000

interface StagedFile {
  path: string
  buffer: Buffer
}

/**
 * Refetch a pinned revision's file content for staging, given the sha
 * `inspectCandidate` already resolved and validated.
 *
 * Duplicated from `ops/skill-import.ts`'s own tree/blob fetch rather than
 * imported: that module returns only an `ImportReport` (metadata), never the
 * raw bytes it inspected, because inspection and staging are different
 * concerns — one produces evidence, the other produces a directory
 * `writePackage` can copy.
 *
 * A second fetch is *not* self-evidently the same content as the first. A git
 * blob is addressed by the hash of its own content, but nothing here verifies
 * the endpoint's answer against that hash, and the tree listing that decides
 * which files exist at all is not content-addressed in any sense. So the
 * caller re-hashes what comes back and refuses unless it equals the digest
 * inspection computed — see `runInspectionPipeline`.
 */
async function fetchGithubPackageFiles(repository: string, sha: string, deps: CliDeps): Promise<StagedFile[]> {
  const treeUrl = `https://api.github.com/repos/${repository}/git/trees/${sha}?recursive=1`
  const treeBody = await fetchJsonBounded(treeUrl, deps)
  if (!isRecordCli(treeBody) || !Array.isArray(treeBody.tree)) {
    throw new Error(`tree response for "${repository}"@"${sha}" is malformed: expected a "tree" array`)
  }
  if (treeBody.truncated === true) throw new Error(`the package tree exceeded the ${STAGING_TREE_ENTRY_CAP}-entry staging cap`)

  const files: StagedFile[] = []
  let total = 0
  for (const raw of treeBody.tree) {
    if (!isRecordCli(raw)) continue
    const entryPath = typeof raw.path === 'string' ? raw.path : null
    const type = typeof raw.type === 'string' ? raw.type : null
    const entrySha = typeof raw.sha === 'string' ? raw.sha : null
    if (entryPath === null || type === null || entrySha === null || type !== 'blob') continue

    // A hostile path was already refused during inspection; refused again
    // here rather than trusted, because this is the function that is about
    // to join the name into a real filesystem path under a temp directory.
    if (path.isAbsolute(entryPath) || entryPath.split('/').includes('..')) {
      throw new Error(`refused entry "${entryPath}" while staging package content: an absolute or traversing path is never legitimate`)
    }
    if (files.length >= STAGING_TREE_ENTRY_CAP) throw new Error(`the package tree exceeded the ${STAGING_TREE_ENTRY_CAP}-entry staging cap`)

    const blobUrl = `https://api.github.com/repos/${repository}/git/blobs/${entrySha}`
    const blobBody = await fetchJsonBounded(blobUrl, deps)
    if (!isRecordCli(blobBody) || typeof blobBody.content !== 'string') {
      throw new Error(`blob response for "${entryPath}" is malformed: expected a "content" string`)
    }
    const encoding = typeof blobBody.encoding === 'string' ? blobBody.encoding : 'base64'
    const buffer = encoding === 'base64' ? Buffer.from(blobBody.content, 'base64') : Buffer.from(blobBody.content, 'utf8')

    if (buffer.byteLength > STAGING_FILE_BYTES_CAP) throw new Error(`file "${entryPath}" exceeded the ${STAGING_FILE_BYTES_CAP}-byte staging cap`)
    total += buffer.byteLength
    if (total > STAGING_TOTAL_BYTES_CAP) throw new Error(`the package's total staged content exceeded the ${STAGING_TOTAL_BYTES_CAP}-byte cap`)

    files.push({ path: entryPath, buffer })
  }
  return files
}

/** The raw `mjloop.smoke` frontmatter value from a fetched `SKILL.md`, unvalidated until `runSkillSandbox` parses it. */
function extractSmokeChecks(files: StagedFile[]): unknown {
  const skillMd = files.find((file) => file.path === 'SKILL.md')
  if (skillMd === undefined) return undefined
  try {
    const { data } = parseFrontmatter(skillMd.buffer.toString('utf8'))
    if (!isRecordCli(data)) return undefined
    if ('mjloop.smoke' in data) return data['mjloop.smoke']
    return isRecordCli(data.mjloop) ? data.mjloop.smoke : undefined
  } catch {
    return undefined
  }
}

/** `auditState` becomes `'passed'` only when inspection found nothing blocking AND the sandbox is `'passed'` or `'skipped'` — never on `'unavailable'`. */
function finalizeReport(report: ImportReport, sandbox: SandboxResult): ImportReport {
  const passed = !report.blocking && (sandbox.state === 'passed' || sandbox.state === 'skipped')
  return ImportReportSchema.parse({
    ...report,
    sandbox,
    auditState: passed ? 'passed' : 'failed',
    nextAction: passed ? null : { action: 'search-alternative' as const, query: report.candidate.skillName },
  })
}

/** One sentence recording what the sandbox phase found, folded into the persisted package's audit findings. */
function sandboxFinding(sandbox: SandboxResult): string {
  switch (sandbox.state) {
    case 'skipped':
      return `sandbox skipped: ${sandbox.reason}`
    case 'unavailable':
      return `sandbox unavailable: ${sandbox.reason}`
    case 'passed':
      return `sandbox passed: ${sandbox.checks.length} declared check(s) ran clean`
    case 'failed':
      return `sandbox failed: ${sandbox.checks.length} declared check(s) attempted`
  }
}

interface InspectionOutcome {
  report: ImportReport
  files: StagedFile[]
}

/**
 * `orchestration.skills.sources` gates the whole pipeline, not just `search`.
 *
 * Enforcing it only in `discoverCandidates` left the allowlist controlling the
 * one command that writes nothing while `inspect`, `import` and
 * `check-updates` — the commands that actually fetch package content and put
 * it in this machine's shared library — ignored it entirely. `config set
 * orchestration.skills.sources ''` is documented as "no external skill
 * discovery at all", and this is what makes that true. Refused before the
 * first request, exactly as discovery refuses.
 */
async function refuseDisabledSource(dir: string, source: SkillSource): Promise<void> {
  const config = await loadConfig(dir)
  if (!config.orchestration.skills.sources.includes(source)) throw new SkillSourceDisabledError(source)
}

/**
 * Pin, fetch, and — unless inspection already refused the candidate — stage
 * its content and run the sandbox phase. Shared by `inspect` (which discards
 * `files`) and `import` (which stages them into the library on a passed
 * audit).
 *
 * A blocking inspection (missing `SKILL.md`, missing license, ...) skips
 * staging and the sandbox entirely: `inspectCandidate` already returned a
 * failed audit and a next action, and there is nothing a sandbox run could
 * add to "this is not a skill" or "this has no license".
 */
async function runInspectionPipeline(dir: string, candidate: SkillCandidate, deps: CliDeps): Promise<InspectionOutcome> {
  await refuseDisabledSource(dir, candidate.source)
  const report = await inspectCandidate(dir, candidate, { fetch: deps.fetch })
  if (report.blocking) return { report, files: [] }

  // A non-blocking report always carries the pinned revision `inspectCandidate`
  // resolved before it fetched anything else — `null` there only ever
  // accompanies a blocking report, which returned above.
  if (report.revision === null) throw new Error('inspection produced no blocking finding but also no pinned revision — refusing to stage unpinned content')
  const files = await fetchGithubPackageFiles(candidate.repository, report.revision, deps)

  // The staged bytes must be *the* bytes that were inspected, and the only way
  // to know that is to hash them with the same function `inspectCandidate`
  // used. The refetch below is a second answer from the same endpoint; nothing
  // about a sha the endpoint itself chose proves the second answer matches the
  // first. Without this check a source can serve a benign tree to inspection
  // and a hostile one to staging, and the library ends up holding content the
  // audit never saw, under a digest that does not describe it — and since the
  // digest covers every path and every byte, verifying it is also what
  // guarantees `report.executableFiles` still describes what is on disk.
  const stagedDigest = computePackageDigest(files)
  if (stagedDigest !== report.digest) {
    throw new Error(
      `the content fetched for staging does not match the content that was inspected: audited digest ${report.digest}, ` +
        `staged digest ${stagedDigest} — refused, and nothing was written; the source answered two different things for ` +
        `one pinned revision, so nothing it says about this package can be trusted`,
    )
  }

  const sandboxDeps: SkillSandboxDeps = { detectBackend: deps.detectSandboxBackend, spawn: deps.spawn }
  const sandbox: SandboxResult =
    report.executableFiles.length === 0
      ? { state: 'skipped', reason: 'no executable content' }
      : await runSkillSandbox(
          { files: files.map((file) => ({ path: file.path, content: file.buffer })), executableFiles: report.executableFiles, smokeChecks: extractSmokeChecks(files) },
          sandboxDeps,
        )

  return { report: finalizeReport(report, sandbox), files }
}

function renderReport(report: ImportReport): string {
  const lines = [
    `candidate  ${report.candidate.source} ${report.candidate.repository} (ref ${report.candidate.ref})`,
    `revision   ${report.revision ?? '(unpinned)'}`,
    `digest     ${report.digest ?? '(none)'}`,
    `license    ${report.license?.spdx ?? report.license?.file ?? '(none)'}`,
    `audit      ${report.auditState}`,
  ]
  if (report.findings.length > 0) {
    lines.push('findings:')
    for (const finding of report.findings) lines.push(`  - ${finding}`)
  }
  // The sandbox's own sentence, not just its state: "unavailable" on its own
  // tells a reader neither why this machine could not verify the package nor
  // which backend would let it.
  if (report.sandbox !== null) lines.push(`sandbox    ${sandboxFinding(report.sandbox)}`)
  if (report.nextAction !== null) {
    lines.push(`this candidate did not pass — search alternative is a user-initiated action for "${report.nextAction.query}"; nothing searches again on its own`)
  }
  return `${lines.join('\n')}\n`
}

async function skillsSearchCommand(args: string[], deps: CliDeps): Promise<CliResult> {
  const { dir, json, positional, source, empty } = parseArgs(args)
  const refusal = refuseEmptyFlag(empty)
  if (refusal !== null) return refusal

  const [query] = positional
  if (query === undefined) {
    return fail('skills search needs a query: mjloop-cli skills search <query> [--source github|registry|web|skills-sh] [--dir <path>]')
  }

  let parsedSource: SkillSource = 'github'
  if (source !== undefined) {
    const result = SkillSourceSchema.safeParse(source)
    if (!result.success) return fail(`--source takes github, registry, web or skills-sh — got "${source}"`)
    parsedSource = result.data
  }

  try {
    const candidates = await discoverCandidates(dir, { query, source: parsedSource }, { fetch: deps.fetch })
    if (json) return { stdout: `${JSON.stringify(candidates, null, 2)}\n`, exitCode: 0 }
    if (candidates.length === 0) return { stdout: `no candidates found for "${query}" on source "${parsedSource}"\n`, exitCode: 0 }
    const lines = candidates.map(
      (candidate) =>
        `  ${candidate.repository}  ref ${candidate.ref}  ${candidate.url}${candidate.stars !== undefined ? `  stars ${candidate.stars}` : ''}\n    ${candidate.description}`,
    )
    return {
      stdout:
        `candidates for "${query}" (${parsedSource}) — metadata only; nothing is written and none of these is active:\n` +
        `${lines.join('\n')}\n` +
        'inspect one before importing: mjloop-cli skills inspect <url>\n',
      exitCode: 0,
    }
  } catch (error) {
    // `SkillSourceDisabledError` already names the setting and the command
    // that changes it; every other refusal here is relayed the same way
    // every other `skills` subcommand relays a store error.
    return fail(describe(error))
  }
}

async function skillsInspectCommand(args: string[], deps: CliDeps): Promise<CliResult> {
  const { dir, json, positional, ref, empty } = parseArgs(args)
  const refusal = refuseEmptyFlag(empty)
  if (refusal !== null) return refusal

  const [url] = positional
  if (url === undefined) {
    return fail('skills inspect needs a candidate url: mjloop-cli skills inspect <url> [--ref <ref>] [--dir <path>]')
  }
  const candidate = candidateFromUrl(url, ref ?? 'HEAD')
  if (candidate === null) {
    return fail(`"${url}" is not a github.com repository url this command can parse — expected https://github.com/<owner>/<repo>`)
  }

  try {
    const { report } = await runInspectionPipeline(dir, candidate, deps)
    if (json) return { stdout: `${JSON.stringify(report, null, 2)}\n`, exitCode: 0 }
    return { stdout: renderReport(report), exitCode: report.auditState === 'passed' ? 0 : 1 }
  } catch (error) {
    return fail(describe(error))
  }
}

async function skillsImportCommand(args: string[], deps: CliDeps): Promise<CliResult> {
  const { dir, positional, ref, empty } = parseArgs(args)
  const refusal = refuseEmptyFlag(empty)
  if (refusal !== null) return refusal

  const [url] = positional
  if (url === undefined) {
    return fail('skills import needs a candidate url: mjloop-cli skills import <url> [--ref <ref>] [--dir <path>]')
  }
  const candidate = candidateFromUrl(url, ref ?? 'HEAD')
  if (candidate === null) {
    return fail(`"${url}" is not a github.com repository url this command can parse — expected https://github.com/<owner>/<repo>`)
  }

  try {
    const { report, files } = await runInspectionPipeline(dir, candidate, deps)
    if (report.auditState !== 'passed') {
      return { stdout: renderReport(report), exitCode: 1 }
    }

    const pkg = buildSkillPackage(report)
    const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mjloop-skill-import-'))
    try {
      for (const file of files) {
        const dest = path.join(stageDir, file.path)
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.writeFile(dest, file.buffer)
      }
      await writePackage(dir, pkg, stageDir)
    } finally {
      await fs.rm(stageDir, { recursive: true, force: true })
    }

    return {
      stdout:
        `imported "${pkg.skillName}" at digest ${pkg.digest}\n` +
        `source ${pkg.source.kind} ${pkg.source.url} revision ${pkg.source.revision}\n` +
        'this writes the package into this machine\'s library only — it is not yet accepted into this project.\n' +
        `accept it with: mjloop-cli skills accept ${pkg.digest}\n`,
      exitCode: 0,
    }
  } catch (error) {
    return fail(describe(error))
  }
}

/** Stable across revisions of one source — see `SkillPackageSchema.packageId`'s own comment. */
function derivePackageId(candidate: SkillCandidate): string {
  const sanitized = candidate.repository.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${candidate.source}-${sanitized}`
}

/** Assemble the `SkillPackage` a passed `ImportReport` earns — S06's own shape, filled in from S07's evidence. */
function buildSkillPackage(report: ImportReport, now: () => Date = () => new Date()): SkillPackage {
  const skillName = report.skillName ?? report.candidate.skillName
  const description = report.description ?? report.candidate.description
  return SkillPackageSchema.parse({
    schema: 1,
    packageId: derivePackageId(report.candidate),
    digest: report.digest,
    source: { kind: report.candidate.source, url: report.candidate.url, revision: report.revision },
    license: report.license ?? { spdx: null, file: null },
    skillName,
    description,
    tags: [],
    dependencies: report.dependencies ?? { executables: [], packages: [] },
    audit: {
      state: report.auditState,
      findings: report.sandbox === null ? report.findings : [...report.findings, sandboxFinding(report.sandbox)],
      at: now().toISOString(),
    },
    guidance: description,
    importedAt: now().toISOString(),
  })
}

/** `<owner>/<name>` out of a `https://github.com/<owner>/<name>` url, or `null` for anything else. */
function repositoryFromGithubUrl(url: string): string | null {
  const match = GITHUB_URL.exec(url)
  if (match === null) return null
  const [, owner, name] = match
  return `${owner}/${name}`
}

async function skillsCheckUpdatesCommand(args: string[], deps: CliDeps): Promise<CliResult> {
  const { dir, json, empty } = parseArgs(args)
  const refusal = refuseEmptyFlag(empty)
  if (refusal !== null) return refusal

  const acceptances = await listAcceptances(dir)
  const reports: Array<{
    skillId: string
    digest: string
    status: 'pinned' | 'up-to-date' | 'new-candidate' | 'package-missing' | 'unsupported-source' | 'check-failed'
    currentRevision: string | null
    candidateRevision: string | null
    detail: string | null
  }> = []

  for (const acceptance of acceptances) {
    // `pinned` is not even checked — the story is explicit that this policy
    // never moves, so there is nothing here worth spending a network call on.
    if (acceptance.updatePolicy === 'pinned') {
      reports.push({ skillId: acceptance.skillId, digest: acceptance.digest, status: 'pinned', currentRevision: null, candidateRevision: null, detail: null })
      continue
    }

    const pkg = await readPackage(dir, acceptance.digest)
    if (pkg === null) {
      reports.push({ skillId: acceptance.skillId, digest: acceptance.digest, status: 'package-missing', currentRevision: null, candidateRevision: null, detail: null })
      continue
    }
    if (pkg.source.kind !== 'github') {
      reports.push({ skillId: acceptance.skillId, digest: acceptance.digest, status: 'unsupported-source', currentRevision: pkg.source.revision, candidateRevision: null, detail: null })
      continue
    }
    const repository = repositoryFromGithubUrl(pkg.source.url)
    if (repository === null) {
      reports.push({ skillId: acceptance.skillId, digest: acceptance.digest, status: 'check-failed', currentRevision: pkg.source.revision, candidateRevision: null, detail: 'could not parse a repository out of the recorded source url' })
      continue
    }

    try {
      // The same allowlist that gates `search`, `inspect` and `import`: a
      // project that has turned github off is not quietly polled for it either.
      await refuseDisabledSource(dir, 'github')
      const candidateRevision = await resolveGithubHeadSha(repository, deps)
      const changed = candidateRevision !== pkg.source.revision
      reports.push({
        skillId: acceptance.skillId,
        digest: acceptance.digest,
        status: changed ? 'new-candidate' : 'up-to-date',
        currentRevision: pkg.source.revision,
        candidateRevision,
        detail: null,
      })
    } catch (error) {
      reports.push({ skillId: acceptance.skillId, digest: acceptance.digest, status: 'check-failed', currentRevision: pkg.source.revision, candidateRevision: null, detail: describe(error) })
    }
  }

  if (json) return { stdout: `${JSON.stringify(reports, null, 2)}\n`, exitCode: 0 }

  if (reports.length === 0) return { stdout: '(no acceptances to check)\n', exitCode: 0 }
  const lines = reports.map((entry) => {
    if (entry.status === 'pinned') return `  ${entry.skillId}  pinned — not checked`
    if (entry.status === 'up-to-date') return `  ${entry.skillId}  up to date at ${entry.currentRevision}`
    if (entry.status === 'new-candidate') {
      return (
        `  ${entry.skillId}  new revision available: ${entry.candidateRevision} (currently accepted at ${entry.currentRevision})\n` +
        `    this is a new candidate, not applied — import it explicitly, then accept the new digest separately`
      )
    }
    if (entry.status === 'package-missing') return `  ${entry.skillId}  package not held in this machine's library — cannot check`
    if (entry.status === 'unsupported-source') return `  ${entry.skillId}  source has no update check defined yet`
    return `  ${entry.skillId}  could not check: ${entry.detail}`
  })
  return { stdout: `${lines.join('\n')}\n`, exitCode: 0 }
}

/** The candidate's current upstream revision, resolved the same way `inspectCandidate` pins one — never applied, only reported. */
async function resolveGithubHeadSha(repository: string, deps: CliDeps): Promise<string> {
  const repoBody = await fetchJsonBounded(`https://api.github.com/repos/${repository}`, deps)
  const defaultBranch = isRecordCli(repoBody) && typeof repoBody.default_branch === 'string' ? repoBody.default_branch : 'HEAD'
  const commitBody = await fetchJsonBounded(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(defaultBranch)}`, deps)
  const sha = isRecordCli(commitBody) && typeof commitBody.sha === 'string' ? commitBody.sha : null
  if (sha === null) throw new Error(`could not resolve the current revision for "${repository}"`)
  return sha
}

/** A comma-separated list, where the empty string is the empty list — mirrors `asList` above. */
function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

async function sessionStartCommand(stdin: string): Promise<CliResult> {
  const cwd = readCwd(stdin)
  const summary = await stateSummary(cwd)
  // Say nothing in projects that do not use mjloop — silence beats noise.
  if (!summary.initialised) return { stdout: '', exitCode: 0 }

  const lines = [renderSummaryLine(summary)]
  const cockpit = await autostartCockpit(cwd, readSource(stdin))
  if (cockpit !== null) lines.push(cockpit)

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n'),
    },
  }
  return { stdout: `${JSON.stringify(payload)}\n`, exitCode: 0 }
}

/**
 * Put the cockpit on screen when a session opens in a project that uses it.
 *
 * Returns a line for the session's context, or null when it did nothing.
 *
 * Four gates, and each one is a way this feature becomes unwelcome if it is
 * missing:
 *
 *  1. `startup` only. `SessionStart` also fires on `/clear` and on a resume,
 *     which happen many times a day; a browser tab per `/clear` is the version
 *     of this people turn off within the hour.
 *  2. `web.autostart`, which a project can set to false.
 *  3. A server already serving this project is reused, not raced. Two servers
 *     on one project would collide on the port anyway — the default is fixed at
 *     4177 — and the second would die with `EADDRINUSE` in a detached process
 *     nobody is watching.
 *  4. `node-pty`. The first dashboard run installs it, and a hook is not the
 *     place to start an `npm install` nobody asked for: it would run
 *     unattended, on every clone, before the session has drawn its first
 *     prompt. So this says how to do it once, by hand, and starts nothing.
 *
 * Every failure below is silent. A hook that cannot open a browser has cost
 * the reader nothing; a hook that writes an error into the session's opening
 * context has.
 */
async function autostartCockpit(cwd: string, source: string): Promise<string | null> {
  if (source !== 'startup') return null

  const config = await loadConfig(cwd).catch(() => null)
  if (config === null || !config.web.autostart) return null

  const running = await readServerMarker(cwd)
  if (running !== null) {
    openUrl(running.url)
    return `The cockpit is already running: ${running.url}`
  }

  if (!isPtyAvailable()) {
    return 'Run /mjloop:web once to set the cockpit up — it installs node-pty, which a session hook will not do unasked.'
  }

  try {
    // Detached, unref'd, output discarded: this outlives the hook by design, and
    // a hook that waited on it would hold the session's first prompt behind a
    // server start.
    nodeSpawn(process.execPath, [webCliPath(), '--dir', cwd], {
      detached: true,
      stdio: 'ignore',
    }).unref()
  } catch {
    return null
  }
  return 'Starting the cockpit — it opens in your browser in a moment.'
}

/**
 * `startup`, `resume` or `clear`. Absent means a caller that is not Claude
 * Code, which is every test and every hand-run of this command, so it reads as
 * the one that starts nothing.
 */
/**
 * The shipped `dist/web/cli.js`, from wherever this file is running.
 *
 * `dist/cli/index.js` and `src/cli/index.ts` are both two directories under the
 * engine root, which is the same expression `web/cli.ts` uses to find the
 * engine — so one form serves the bundle and a dev checkout. In a checkout it
 * resolves to `dist/web/cli.js`, which is committed, so it exists either way.
 */
function webCliPath(): string {
  return path.join(fileURLToPath(new URL('../../', import.meta.url)), 'dist', 'web', 'cli.js')
}

/**
 * The browser, the way `web/cli.ts` opens it — no shell, on any platform.
 *
 * `start` is a `cmd.exe` builtin rather than an executable, which is the reason
 * a shell was reached for on Windows in the first place; `cmd.exe` gets a fixed
 * argv instead, and the empty string after `start` is its title argument. The
 * url is already provably free of metacharacters — `ServerMarkerSchema` pins
 * the token to 64 hex characters and the port to a number — so this is the
 * second of two locks on the same door, not the only one.
 */
function openUrl(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd.exe', ['/d', '/s', '/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    nodeSpawn(command as string, args as string[], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    /* the url is in the session's context either way */
  }
}

function readSource(stdin: string): string {
  try {
    const parsed = JSON.parse(stdin) as { source?: unknown }
    return typeof parsed.source === 'string' ? parsed.source : ''
  } catch {
    return ''
  }
}

async function stateGuardCommand(stdin: string): Promise<CliResult> {
  let input: unknown
  try {
    input = JSON.parse(stdin) as unknown
  } catch {
    return { stdout: '', exitCode: 0 }
  }
  const verdict = evaluateStateGuard(input)
  if (!verdict.deny) return { stdout: '', exitCode: 0 }

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: verdict.reason,
    },
  }
  return { stdout: `${JSON.stringify(payload)}\n`, exitCode: 0 }
}

export interface GuardVerdict {
  deny: boolean
  reason: string
}

/**
 * Loop state is owned by the MCP server. A model editing it by hand is the
 * fastest way to lose a run, so the write is denied outright.
 */
export function evaluateStateGuard(input: unknown): GuardVerdict {
  const filePath = extractFilePath(input)
  if (filePath === null) return { deny: false, reason: '' }

  // Normalised once, and both rules below read the result rather than the
  // string the hook handed over. A path that reaches here through ordinary
  // joining can carry `//`, a `.`, or an interior `..`, and every one of those
  // puts a segment between `.mjloop` and the directory name the rule is looking
  // for: `.mjloop/plans/../profile/accepted/rev-001.json` names the immutable
  // revision, but its second segment is `plans`, so an un-normalised split
  // reads it as a write under `plans/` and allows it. The basename rule was
  // never exposed to this — `path.basename` throws away the dirname where all
  // three shapes live — which is exactly why the directory rule needs the line
  // and the one above it does not.
  const normalised = path.normalize(filePath)
  // Compared case-folded, because macOS and Windows volumes are case-insensitive
  // by default: `.mjloop/State.json` and `.mjloop/Profile/proposed.json` name
  // *exactly the files this guard exists to protect* on the machine most of this
  // plugin's users are on, and a case-sensitive comparison hands both back with
  // a permission to write. Every name being matched here — `.mjloop` itself, the
  // three basenames, the protected directories — is a literal the engine writes
  // in lowercase and nobody types, so folding can only ever catch a spelling of
  // the engine's own file. On a case-sensitive volume it costs a user who
  // deliberately put an unrelated `.mjloop/Profile/` beside the engine's own
  // records, which is a directory nobody has, and the denial says which record
  // it thought they meant.
  const segments = normalised.split(path.sep).map((segment) => segment.toLowerCase())
  if (!segments.includes('.mjloop')) return { deny: false, reason: '' }

  const basename = path.basename(normalised).toLowerCase()
  if (PROTECTED_BASENAMES.includes(basename as (typeof PROTECTED_BASENAMES)[number])) {
    return {
      deny: true,
      reason: `${basename} is owned by the mjloop MCP server. Use the mjloop_* tools (mjloop_run_start, mjloop_cycle_advance, mjloop_run_log, ...) instead of editing it directly.`,
    }
  }

  const directory = protectedDirectory(segments)
  if (directory !== null) return { deny: true, reason: PROTECTED_DIRECTORY_REASONS[directory] }

  return { deny: false, reason: '' }
}

/**
 * Why each protected directory is closed, and the route back in that replaces
 * the edit.
 *
 * One sentence per directory rather than one shared sentence, because a denial
 * that names the wrong record is worse than a terse one: telling somebody who
 * was editing a feature brief to run `mjloop-cli profile accept` sends them to
 * a different record with a different lifecycle, and they will do it.
 *
 * `satisfies` rather than a plain annotation, so that adding a name to
 * `PROTECTED_DIRECTORIES` and forgetting to say what to do instead is a
 * compile error rather than a guard that denies without guidance.
 */
const PROTECTED_DIRECTORY_REASONS = {
  profile:
    '.mjloop/profile/ is owned by the mjloop engine: an accepted revision is immutable, and the proposal is what an acceptance reads. Use mjloop-cli profile accept and mjloop-cli profile reject (mjloop-cli profile show first) instead of editing these files directly.',
  features:
    '.mjloop/features/ is owned by the mjloop engine: an approved feature brief is what a later plan is built on, and a revision is never rewritten once it is approved. Use the mjloop_feature_* tools (mjloop_feature_create, mjloop_feature_update, mjloop_feature_approve) instead of editing these files directly.',
  skills:
    '.mjloop/skills/ is owned by the mjloop engine: an acceptance names the exact digest, components and agents this project pinned, and a hand edit could silently change what a run treats as accepted without anybody having decided so. Use mjloop-cli skills accept, mjloop-cli skills disable, mjloop-cli skills enable and mjloop-cli skills remove (mjloop-cli skills list first) instead of editing these files directly.',
} as const satisfies Record<(typeof PROTECTED_DIRECTORIES)[number], string>

/**
 * The protected directory this path lies inside, or null.
 *
 * Segments, exactly as the `.mjloop` check above is, and the difference is not
 * cosmetic: a substring rule would deny `.mjloop/profiles/` and
 * `.mjloop/profile-old.md`, neither of which the engine owns, while claiming to
 * be a rule about one directory. Every `.mjloop` in the path is considered
 * rather than the first, because a path may hold more than one and only the one
 * the protected directory actually sits under decides anything.
 */
function protectedDirectory(segments: string[]): (typeof PROTECTED_DIRECTORIES)[number] | null {
  for (const [index, segment] of segments.entries()) {
    if (segment !== '.mjloop') continue
    const child = segments[index + 1] as (typeof PROTECTED_DIRECTORIES)[number] | undefined
    if (child !== undefined && PROTECTED_DIRECTORIES.includes(child)) return child
  }
  return null
}

export interface StopVerdict {
  block: boolean
  reason: string
}

/**
 * Decide whether an autonomous run should keep going when Claude Code is about
 * to end the turn.
 *
 * Every branch that is not "a running loop in a project that opted in" allows
 * the stop. That includes anything this function could not make sense of: a
 * guard that blocks on its own confusion traps the session, and there is no
 * way out from inside it.
 */
export function evaluateStopGuard(input: unknown, summary: StateSummary, autonomous: boolean): StopVerdict {
  if (typeof input !== 'object' || input === null) return { block: false, reason: '' }

  // Claude Code sets this once a Stop hook has already caused a continuation
  // this turn. Re-blocking is how a hook loops forever; its own cap on
  // consecutive blocks is a backstop, not a design.
  if ((input as { stop_hook_active?: unknown }).stop_hook_active === true) return { block: false, reason: '' }

  if (!autonomous) return { block: false, reason: '' }
  if (!summary.initialised) return { block: false, reason: '' }

  // `state.json` was unreadable and this summary came from `.bak`, so it is the
  // previous write — a run recorded as `running` here may already be done. The
  // store itself could not trust the primary; blocking is the one decision that
  // must never be made on state that stale.
  if (summary.recovered) return { block: false, reason: '' }

  if (summary.status !== 'running') return { block: false, reason: '' }

  // No cap means the running track is not in config — renamed, removed, or on
  // another branch. `cycleAdvance` throws before any status transition in that
  // state, so none of the guards named below can ever end this run: blocking
  // would promise an ending that cannot arrive, once per turn, forever. An
  // uncapped run is also exactly the run that should not continue unattended.
  if (summary.max_cycles === null) return { block: false, reason: '' }

  const open = summary.findings.high + summary.findings.medium + summary.findings.low
  // The open cycle's, not the previous one's: `cycleAdvance` clears findings
  // before it increments the cycle, so a non-zero count here was logged by
  // this cycle's own agents.
  const findings =
    open === 0
      ? 'There are no open findings in this cycle.'
      : `${open} open findings in this cycle (${summary.findings.high} high, ${summary.findings.medium} medium, ${summary.findings.low} low).`

  return {
    block: true,
    reason: [
      `Loop is running autonomously: track ${summary.track}, cycle ${summary.cycle} of ${summary.max_cycles}, stage ${summary.stage}.`,
      `Goal: ${summary.goal ?? 'not set'}.`,
      findings,
      'Continue the cycle with the mjloop-leader skill. Do not stop until the run reaches done or halted —',
      "the engine's guards end it: the cycle cap, the stagnation guard, and the repeated-error guard.",
    ].join('\n'),
  }
}

async function stopGuardCommand(stdin: string): Promise<CliResult> {
  let input: unknown
  try {
    input = JSON.parse(stdin) as unknown
  } catch {
    return { stdout: '', exitCode: 0 }
  }

  const cwd = readCwd(stdin)
  const summary = await stateSummary(cwd)

  let autonomous = false
  try {
    autonomous = (await loadConfig(cwd)).autonomous
  } catch {
    // Every way of failing to read the config means the same thing: nothing
    // opted in. A project with no config never did, and a malformed or
    // unreadable one cannot be read as having done so. Assigned rather than
    // left to the initialiser above, so the fail-safe survives a refactor that
    // seeds `autonomous` from a cached value or a default object.
    autonomous = false
  }

  const verdict = evaluateStopGuard(input, summary, autonomous)
  if (!verdict.block) return { stdout: '', exitCode: 0 }

  // A top-level decision object. This is NOT the hookSpecificOutput shape the
  // SessionStart and PreToolUse hooks use — the Stop event has its own.
  return { stdout: `${JSON.stringify({ decision: 'block', reason: verdict.reason })}\n`, exitCode: 0 }
}

function extractFilePath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const toolInput = (input as { tool_input?: unknown }).tool_input
  if (typeof toolInput !== 'object' || toolInput === null) return null
  const filePath = (toolInput as { file_path?: unknown }).file_path
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : null
}

function readCwd(stdin: string): string {
  try {
    const parsed = JSON.parse(stdin) as { cwd?: unknown }
    return typeof parsed.cwd === 'string' && parsed.cwd.length > 0 ? parsed.cwd : process.cwd()
  } catch {
    return process.cwd()
  }
}

if (await isEntrypoint(import.meta.url)) {
  const stdin = process.stdin.isTTY === true ? '' : await readAll()
  const result = await runCli(process.argv.slice(2), stdin)
  if (result.stdout.length > 0) process.stdout.write(result.stdout)
  process.exitCode = result.exitCode
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
