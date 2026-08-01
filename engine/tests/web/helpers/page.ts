import fs from 'node:fs/promises'
import path from 'node:path'
import type { Snapshot } from '../../../src/web/protocol.js'

/**
 * The tests load the **real** `index.html`, not a fixture.
 *
 * A fixture is a second copy of the templates that drifts from the shipped one,
 * and every guarantee in this suite — that a row's node survives a tick, that a
 * status transition leaves one class — is a guarantee about the markup the user
 * actually gets.
 */
/**
 * Resolved from the working directory rather than from `import.meta.url`: under
 * `happy-dom` the global `URL` is the DOM one and resolves a module specifier
 * against `http://localhost/`, so `fileURLToPath` throws. vitest runs from the
 * engine root.
 */
export const PUBLIC_DIR = path.resolve(process.cwd(), 'src', 'web', 'public')

export async function loadPage(): Promise<void> {
  const html = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
  const inner = html
    .replace(/^[\s\S]*?<html[^>]*>/, '')
    .replace(/<\/html>[\s\S]*$/, '')
    // Stylesheets and vendor scripts are dropped: happy-dom would go and fetch
    // them over the network, and none of the guarantees under test are about
    // paint. The structure — templates, slots, ids, `hidden` — is the subject.
    .replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/g, '')
  document.documentElement.innerHTML = inner
}

export async function readLocale(code: string): Promise<Record<string, string>> {
  return JSON.parse(await fs.readFile(path.join(PUBLIC_DIR, 'locales', `${code}.json`), 'utf8')) as Record<
    string,
    string
  >
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
      plans: '',
      runs: '',
      cycle: 'idle',
      memory: '',
      profile: '-',
      features: '',
      skills: '',
    },
    ...patch,
  }
}
