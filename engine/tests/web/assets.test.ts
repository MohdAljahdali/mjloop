import { describe, expect, it } from 'vitest'
import { referencedAssets } from '../../scripts/assets.mjs'

describe('referencedAssets', () => {
  it('finds script and stylesheet references', () => {
    const html = `<link rel="stylesheet" href="./assets/index-a1b2.css"><script type="module" src="./assets/index-c3d4.js"></script>`
    expect(referencedAssets(html)).toEqual(['assets/index-a1b2.css', 'assets/index-c3d4.js'])
  })

  it('keeps the vendor scripts the page loads by hand', () => {
    expect(referencedAssets(`<script src="vendor/xterm.js"></script>`)).toEqual(['vendor/xterm.js'])
  })

  it('ignores data URIs and absolute URLs', () => {
    const html = `<link rel="icon" href="data:image/svg+xml,%3Csvg%3E"><script src="https://cdn.example/x.js"></script>`
    expect(referencedAssets(html)).toEqual([])
  })

  it('strips a leading slash so paths resolve under the public root', () => {
    expect(referencedAssets(`<script src="/assets/x.js"></script>`)).toEqual(['assets/x.js'])
  })
})
