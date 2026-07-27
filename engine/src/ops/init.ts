import fs from 'node:fs/promises'
import path from 'node:path'
import { defaultConfig, type Verify } from '../schemas/config.js'
import { initialState } from '../schemas/state.js'
import { writeJsonAtomic } from '../store/atomic.js'
import { writeConfig } from '../store/config-store.js'
import { resolveLoopPaths } from '../store/paths.js'
import type { Clock } from '../store/state-store.js'

export const CLAUDE_MD_SECTION = '## Loop'

const CLAUDE_MD_BLOCK = `${CLAUDE_MD_SECTION}

This project uses the \`loop\` plugin. Execution state lives in \`.loop/\`.

- \`/loop:edit <request>\` — small, well-scoped change (one cycle)
- \`/loop:plan <idea>\` — turn an idea into an approved plan broken into stories
- \`/loop:build <what to build | P001-S02 | --next>\` — multi-cycle build, optionally against a story
- \`/loop:fix <problem>\` — reproduce a defect, find the root cause, fix it
- \`/loop:status\` — current track, cycle, and latest evidence
- \`/loop:stop [reason]\` — halt the run and write a report
- \`/loop:resume\` — continue a run that was interrupted
- \`/loop:design-sync\` — extract the project's design system for the UI agents
- \`/loop:add agent|skill|track <name>\` — scaffold a new element

\`.loop/state.json\` is owned by the loop MCP server. Never edit it by hand.
`

export interface InitResult {
  /** Paths created by this call, relative to the project root. */
  created: string[]
  verify: Verify
  alreadyInitialised: boolean
}

/** Read verify commands off package.json scripts. Absent script -> null. */
export async function detectVerifyCommands(projectDir: string): Promise<Verify> {
  const empty: Verify = { test: null, lint: null, build: null }
  let scripts: Record<string, unknown>
  try {
    const raw = await fs.readFile(path.join(projectDir, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> }
    scripts = parsed.scripts ?? {}
  } catch {
    return empty
  }
  return {
    test: typeof scripts.test === 'string' ? 'npm test' : null,
    lint: typeof scripts.lint === 'string' ? 'npm run lint' : null,
    build: typeof scripts.build === 'string' ? 'npm run build' : null,
  }
}

export async function initLoop(projectDir: string, now: Clock = () => new Date()): Promise<InitResult> {
  const paths = resolveLoopPaths(projectDir)
  const verify = await detectVerifyCommands(projectDir)

  if (await exists(paths.state)) {
    await ensureClaudeMdSection(projectDir)
    return { created: [], verify, alreadyInitialised: true }
  }

  const created: string[] = []
  for (const dir of [paths.root, paths.plans, paths.runs, paths.memory]) {
    await fs.mkdir(dir, { recursive: true })
    created.push(path.relative(projectDir, dir))
  }

  await writeJsonAtomic(paths.state, initialState(now()))
  created.push(path.relative(projectDir, paths.state))

  await writeConfig(projectDir, defaultConfig(verify))
  created.push(path.relative(projectDir, paths.config))

  if (await ensureClaudeMdSection(projectDir)) created.push('CLAUDE.md')

  return { created, verify, alreadyInitialised: false }
}

/** Append the loop section to CLAUDE.md unless it is already there. */
export async function ensureClaudeMdSection(projectDir: string): Promise<boolean> {
  const file = path.join(projectDir, 'CLAUDE.md')
  let existing = ''
  try {
    existing = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing.includes(CLAUDE_MD_SECTION)) return false

  const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  await fs.writeFile(file, `${existing}${separator}${CLAUDE_MD_BLOCK}`, 'utf8')
  return true
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
