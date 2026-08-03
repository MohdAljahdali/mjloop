/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

/**
 * xterm is loaded from `vendor/` as a global rather than bundled, so the page
 * ships one copy that a one-line UI change does not re-diff. Task 12 deleted
 * `src/web/page-globals.d.ts`, which declared the same two globals for the
 * old page — this file is now the only declaration of either.
 */
declare const Terminal: any
declare const FitAddon: { FitAddon: any }
