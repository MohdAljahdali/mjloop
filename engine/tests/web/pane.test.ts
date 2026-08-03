// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `usePane.ts`'s module body runs `ref(prefs().pane)` at import time, so each
 * test needs its own module graph — `vi.resetModules()`.
 *
 * Import order matters and must match production: `main.ts` imports `App.vue`
 * — and with it `usePane.ts` — *before* `installStorage()` runs, so the
 * module-load read always sees no storage installed yet. `bootPane()` is the
 * only thing that is supposed to see a reader's remembered mode; it must
 * re-read storage itself rather than trust `mode`'s module-load value. Each
 * test below imports `usePane.ts` first and installs storage after, the
 * inverse of the previous version of this file — which installed storage
 * before importing and so could not have caught this.
 */
beforeEach(() => {
  vi.resetModules()
  document.body.dataset['pane'] = 'collapsed'
})

describe('usePane', () => {
  it('boots by re-reading storage, not by trusting the mode read at module load', async () => {
    // `ui/pane.js`'s `mountPane()` opens with `setPane(prefs().pane)`. Without
    // `bootPane()` re-reading storage, a reader who left the pane docked
    // reloads to a page whose static markup still says `data-pane="docked"`
    // (the boot default) but whose in-memory `mode` was pinned to
    // `'collapsed'` at module load, before storage existed.
    const { bootPane } = await import('../../src/web/app/composables/usePane.ts')
    const local = await import('../../src/web/app/lib/local.ts')
    local.installStorage({ getItem: () => JSON.stringify({ pane: 'docked' }), setItem: () => {} })
    bootPane()
    expect(document.body.dataset['pane']).toBe('docked')
  })

  it('cycles collapsed -> docked -> full -> collapsed', async () => {
    const { usePane } = await import('../../src/web/app/composables/usePane.ts')
    const local = await import('../../src/web/app/lib/local.ts')
    local.installStorage({ getItem: () => null, setItem: () => {} })
    const pane = usePane()
    expect(pane.mode.value).toBe('collapsed')
    pane.cycle()
    expect(pane.mode.value).toBe('docked')
    pane.cycle()
    expect(pane.mode.value).toBe('full')
    pane.cycle()
    expect(pane.mode.value).toBe('collapsed')
  })

  it('follow opens a collapsed pane, but never once the reader has chosen a height', async () => {
    const { usePane } = await import('../../src/web/app/composables/usePane.ts')
    const local = await import('../../src/web/app/lib/local.ts')
    local.installStorage({ getItem: () => null, setItem: () => {} })
    const pane = usePane()

    pane.follow()
    expect(pane.mode.value).toBe('docked')

    // The reader collapses it back deliberately.
    pane.set('collapsed')
    // A second job starting must not reopen it — the reader has chosen.
    pane.follow()
    expect(pane.mode.value).toBe('collapsed')
  })

  it('reveal sets `chosen`, the same as set() and cycle() — a later follow() must not override it', async () => {
    // `ui/pane.js`'s `reveal()`: "chosen is set here too, on the same logic
    // cycle() and toggleFull() already follow — an explicit action, not a
    // side effect for a later automatic one to override." My brief's
    // `reveal()` skipped that line; fidelity to the old page means it must
    // set `chosen` exactly like `set()` and `cycle()` do.
    //
    // The previous version of this test called `set('collapsed')` right
    // after `reveal()`, which sets `chosen` on its own — so the assertion
    // passed even with `usePane.ts:64`'s `chosen = true` deleted from
    // `reveal()`. This version never calls `set()`, so only `reveal()` itself
    // can be the one setting `chosen`.
    const { usePane } = await import('../../src/web/app/composables/usePane.ts')
    const local = await import('../../src/web/app/lib/local.ts')
    local.installStorage({ getItem: () => null, setItem: () => {} })
    const pane = usePane()

    pane.reveal()
    expect(pane.mode.value).toBe('docked')

    // Force it back to collapsed without going through `set()` or `cycle()`
    // — both of those also set `chosen`, which would mask whether `reveal()`
    // itself did. `follow()`'s gate is `!chosen && mode.value === 'collapsed'`,
    // so this isolates `reveal()`'s own effect on `chosen`.
    pane.mode.value = 'collapsed'
    pane.follow()
    expect(pane.mode.value).toBe('collapsed')
  })
})
