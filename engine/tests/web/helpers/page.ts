import fs from 'node:fs/promises'
import path from 'node:path'
import type { Snapshot } from '../../../src/web/protocol.js'

/**
 * Resolved from the working directory rather than from `import.meta.url`: under
 * `happy-dom` the global `URL` is the DOM one and resolves a module specifier
 * against `http://localhost/`, so `fileURLToPath` throws. vitest runs from the
 * engine root.
 *
 * Task 12 deleted `src/web/public/` — the old page's hand-written tree this
 * used to point at — along with the tests (`render`, `list`, `bus`, `panels`,
 * `boot`, `notifications`, `toasts`) that mounted `loadPage()`'s real
 * `index.html`. What is left reads locales only, which the Vue app still ships
 * from `src/web/app/locales/`.
 */
export const APP_LOCALES_DIR = path.resolve(process.cwd(), 'src', 'web', 'app', 'locales')

export async function readLocale(code: string): Promise<Record<string, string>> {
  return JSON.parse(await fs.readFile(path.join(APP_LOCALES_DIR, `${code}.json`), 'utf8')) as Record<string, string>
}

/** A snapshot with everything at its zero value; tests override what they mean. */
export function emptySnapshot(patch: Partial<Snapshot> = {}): Snapshot {
  return {
    project: '/tmp/project',
    state: {
      initialised: true,
      recovered: false,
      status: 'idle',
      track: null,
      run_id: null,
      cycle: 0,
      max_cycles: null,
      plan: null,
      story: null,
      stage: 'idle',
      goal: null,
      findings: { high: 0, medium: 0, low: 0 },
      last_cycle: null,
      halt_reason: null,
      reproduction: null,
      design_system: true,
      map: null,
      config_error: null,
    },
    plans: [],
    runs: [],
    queue: [],
    session: { jobId: null, blocked: false, pausedBy: null, closing: false, stalledSince: null },
    guards: null,
    roster: null,
    revisions: {
      state: '-',
      config: '-',
      // Derived from the plans the caller passed, so a test that opens a plan
      // gets a key for it without naming one. A test about re-fetching passes
      // `revisions` itself, which replaces this wholesale.
      plans: Object.fromEntries((patch.plans ?? []).map((plan) => [plan.id, 'r1'])),
      runs: '',
      cycle: 'idle',
      memory: '',
      profile: '-',
      features: '',
      skills: '',
      agents: '-',
    },
    ...patch,
  }
}
