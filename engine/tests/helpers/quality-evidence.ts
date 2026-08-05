import { verifyRun } from '../../src/ops/verify.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import type { Clock } from '../../src/store/state-store.js'

/**
 * Instant stand-ins for a project's suite and linter.
 *
 * Two slots, not one: a pinned quality plan asks `correctness` and `regression`
 * for `test` evidence and `security` for `command`, and only the `test` slot
 * resolves to the former. A fixture that pins one slot can satisfy three of the
 * four required dimensions and never the fourth.
 */
export const INSTANT_VERIFY = {
  test: "printf 'tests 1, pass 1, fail 0\\n'",
  lint: "printf 'lint clean\\n'",
} as const

/**
 * Pin both slots to commands that cost nothing to run.
 *
 * Must be called **before** `runStart`, which pins the verify block for the
 * whole run — a project edited afterwards is refused by its own pin.
 */
export async function pinInstantVerify(projectDir: string): Promise<void> {
  const config = await loadConfig(projectDir)
  config.verify.test = INSTANT_VERIFY.test
  config.verify.lint = INSTANT_VERIFY.lint
  await writeConfig(projectDir, config)
}

/**
 * Run both slots through the engine and return the evidence entries a dispatch
 * cites to close the pinned quality plan.
 *
 * The engine decides what a receipt *is*: these entries name commands the
 * engine actually ran this cycle, and `resolveQualityEvidenceReceipts` joins
 * them back to its own verify ledger. A fixture that merely claimed
 * `npm test` in an evidence entry proves nothing and leaves every dimension
 * pending — which is exactly what enforcement is for.
 *
 * Call it inside the cycle whose result will cite it: receipts are matched
 * against the current cycle's ledger.
 */
export async function qualityEvidence(
  projectDir: string,
  now?: Clock,
): Promise<Array<{ kind: 'test' | 'command'; ref: string; excerpt: string }>> {
  // Generous rather than tight: the commands are `printf` and finish instantly,
  // so this budget only ever absorbs scheduler contention from the rest of the
  // suite — a tight one turns a busy machine into a flaky verify receipt.
  const test = await verifyRun(projectDir, { slot: 'test', wait_ms: 30_000 }, now)
  const lint = await verifyRun(projectDir, { slot: 'lint', wait_ms: 30_000 }, now)
  if (test.exit_code !== 0 || lint.exit_code !== 0) {
    throw new Error(`instant verify did not exit 0: test=${String(test.exit_code)} lint=${String(lint.exit_code)}`)
  }
  return [
    { kind: 'test', ref: test.command as string, excerpt: 'tests 1, pass 1, fail 0' },
    { kind: 'command', ref: lint.command as string, excerpt: 'lint clean' },
  ]
}
