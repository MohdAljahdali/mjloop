import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * The web program must not carry Node typings.
 *
 * They were added when `app/lib` began importing `protocol.js`, which pulls the
 * server's own modules into the browser's compile. The cost is silent: with
 * `node` in `types`, a component that reaches for `process` or Node's
 * `setTimeout` overloads compiles clean and breaks in a browser.
 */
describe('the web program', () => {
  it('typechecks without node typings', () => {
    // `tsconfig.web.json` resolves `Snapshot`/`ClientMessage`/`Write` through a
    // project reference to `tsconfig.protocol.json` (see that file for why a
    // type-only barrel alone could not cut the graph). A reference is consumed
    // through its built `.d.ts`, so it has to be built before `vue-tsc` can
    // resolve it — `-b` is incremental, so a repeat run here costs nothing.
    execFileSync('npx', ['tsc', '-b', 'tsconfig.protocol.json'], { encoding: 'utf8', stdio: 'pipe' })
    const out = execFileSync('npx', ['vue-tsc', '-p', 'tsconfig.web.json'], { encoding: 'utf8', stdio: 'pipe' })
    expect(out).toBe('')
  })
})
