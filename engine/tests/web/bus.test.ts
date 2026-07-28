// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { install, on, registered } from '../../src/web/public/ui/bus.js'

/**
 * One delegated click and one delegated submit over `[data-act]`.
 *
 * The interesting case is the overlap between them: a form carries its action
 * on itself, and a click on its submit button resolves to the form through
 * `closest()`. Without a guard the action runs twice — which sent the halt
 * write twice and wrote HALT.md twice before this test existed.
 */

let fired: string[]

beforeEach(() => {
  fired = []
  document.body.innerHTML = `
    <form data-act="submitted" id="form"><button type="submit" id="go">Go</button></form>
    <button data-act="clicked" id="plain">Plain</button>
    <div data-act="outer"><span id="inner">inner</span></div>
  `
})

describe('bus', () => {
  it('fires a form action once per submit, not once per click as well', () => {
    on('submitted', () => fired.push('submitted'))
    install(document)
    ;(document.getElementById('go') as HTMLButtonElement).click()
    expect(fired).toEqual(['submitted'])
  })

  it('fires a plain action on click', () => {
    on('clicked', () => fired.push('clicked'))
    install(document)
    ;(document.getElementById('plain') as HTMLButtonElement).click()
    expect(fired).toEqual(['clicked'])
  })

  it('resolves an action from a descendant of the element carrying it', () => {
    on('outer', () => fired.push('outer'))
    install(document)
    ;(document.getElementById('inner') as HTMLElement).click()
    expect(fired).toEqual(['outer'])
  })

  it('refuses two handlers for one name', () => {
    on('once', () => {})
    // A silent overwrite would make a renamed action look like it still works.
    expect(() => on('once', () => {})).toThrow()
    expect(registered()).toContain('once')
  })

  it('ignores a click that lands on nothing registered', () => {
    const seen = vi.fn()
    on('never', seen)
    install(document)
    document.body.click()
    expect(seen).not.toHaveBeenCalled()
  })
})
