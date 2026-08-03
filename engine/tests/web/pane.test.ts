// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `usePane.ts` reads storage at module load (`const mode = ref(prefs().pane)`),
 * so each test needs its own module graph — `vi.resetModules()` — with
 * storage installed before `usePane.ts` is imported, the same seam
 * `lib.test.ts` uses for `local.ts` directly.
 */
beforeEach(() => {
  vi.resetModules()
  document.body.dataset['pane'] = 'collapsed'
})

describe('usePane', () => {
  it('boots by stamping body.dataset.pane with the mode already in storage', async () => {
    // `ui/pane.js`'s `mountPane()` opens with `setPane(prefs().pane)`. Without
    // `bootPane()`, a reader who left the pane docked reloads to a page whose
    // static markup still says `data-pane="collapsed"`.
    const local = await import('../../src/web/app/lib/local.ts')
    local.installStorage({ getItem: () => JSON.stringify({ pane: 'docked' }), setItem: () => {} })
    const { bootPane } = await import('../../src/web/app/composables/usePane.ts')
    bootPane()
    expect(document.body.dataset['pane']).toBe('docked')
  })

  it('cycles collapsed -> docked -> full -> collapsed', async () => {
    const local = await import('../../src/web/app/lib/local.ts')
    local.installStorage({ getItem: () => null, setItem: () => {} })
    const { usePane } = await import('../../src/web/app/composables/usePane.ts')
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
    const local = await import('../../src/web/app/lib/local.ts')
    local.installStorage({ getItem: () => null, setItem: () => {} })
    const { usePane } = await import('../../src/web/app/composables/usePane.ts')
    const pane = usePane()

    pane.follow()
    expect(pane.mode.value).toBe('docked')

    // The reader collapses it back deliberately.
    pane.set('collapsed')
    // A second job starting must not reopen it — the reader has chosen.
    pane.follow()
    expect(pane.mode.value).toBe('collapsed')
  })

  it('reveal opens a collapsed pane and counts as the reader choosing a height, same as cycle', async () => {
    // `ui/pane.js`'s `reveal()`: "chosen is set here too, on the same logic
    // cycle() and toggleFull() already follow — an explicit action, not a
    // side effect for a later automatic one to override." My brief's
    // `reveal()` skipped that line; fidelity to the old page means it must
    // set `chosen` exactly like `set()` and `cycle()` do.
    const local = await import('../../src/web/app/lib/local.ts')
    local.installStorage({ getItem: () => null, setItem: () => {} })
    const { usePane } = await import('../../src/web/app/composables/usePane.ts')
    const pane = usePane()

    pane.reveal()
    expect(pane.mode.value).toBe('docked')

    pane.set('collapsed')
    pane.follow()
    expect(pane.mode.value).toBe('collapsed')
  })
})
