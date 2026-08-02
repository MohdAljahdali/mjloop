/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

/**
 * xterm is loaded from `vendor/` as a global rather than bundled, so the page
 * ships one copy that a one-line UI change does not re-diff. These mirror
 * `src/web/page-globals.d.ts`, which serves the old page.
 */
declare const Terminal: any
declare const FitAddon: { FitAddon: any }
