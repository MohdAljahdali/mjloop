import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `body` is the page's grid (`app/styles/app.css:101`, areas at `:129`), and
 * every `grid-area` rule — `.top`, `.tabs`, `main`, `.pane` — keys off being a
 * direct child of `body`. Vue mounts onto `#app`, which sits between them, so
 * without `display: contents` here `#app` alone is the grid item and every
 * `grid-area` rule is inert. The concrete break this caused:
 * `body[data-pane="full"] { grid-template-rows: auto auto 0 1fr }`
 * (`css/40-terminal.css:175,193`) had nothing to act on, so full mode could
 * not work at all — docked survived only because it happens to be a plain
 * height.
 *
 * Asserted against the *built* stylesheet, not the source: nothing else in
 * the suite renders the real page, so a one-line CSS rule going missing from
 * `dist/` — the thing actually shipped — would otherwise be invisible.
 */
describe('shipped layout', () => {
  it('ships #app as display:contents so body\'s grid areas reach its Vue-mounted children', async () => {
    const assetsDir = path.resolve(process.cwd(), 'dist/web/public/assets')
    const files = await fs.readdir(assetsDir)
    const cssFile = files.find((name) => name.startsWith('style-') && name.endsWith('.css'))
    expect(cssFile, 'built stylesheet not found under dist/web/public/assets — run `npm run build` first').toBeDefined()
    const css = await fs.readFile(path.join(assetsDir, cssFile as string), 'utf8')
    expect(css).toMatch(/#app\s*\{\s*display:\s*contents\s*;?\s*\}/)
  })
})

/**
 * Asserted against the *source* stylesheet, unlike the shipped rule above:
 * `dist/` is a release artefact rebuilt by `npm run build`, not by this suite,
 * so a source rule added between releases is not in it yet. What is under test
 * here is the rule itself — three equal cards that stack rather than scroll on
 * a 390px screen — which is a source fact.
 */
describe('the quality mode cards at 390px', () => {
  it('renders three equal cards wide, stacks them narrow, and keeps a 44px target', async () => {
    const panels = await fs.readFile(path.resolve(process.cwd(), 'src/web/app/styles/60-panels.css'), 'utf8')
    expect(panels).toMatch(/\.quality-modes\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/)
    expect(panels).toMatch(/@media \(max-width: 390px\)\s*\{\s*\.quality-modes\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(panels).toMatch(/\.quality-card\s*\{[^}]*min-height:\s*44px/)
    // The card is the target and the radio inside it is small, so the focus
    // ring has to be drawn on the card the keyboard actually lands in.
    expect(panels).toMatch(/\.quality-card:focus-within\s*\{[^}]*outline:/)
  })
})
