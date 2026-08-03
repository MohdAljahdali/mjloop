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
/**
 * `any`, not a narrower shape — a trap on its own. It makes `Terminal.vue`
 * typecheck against the real global (`new Terminal({ ... })`), but it would
 * just as happily typecheck an accidental `import Terminal from
 * './Terminal.vue'` in that same file: the import shadows this global, `any`
 * accepts `new <the component>(...)` without complaint, and no test catches
 * it — `tests/web/*.test.ts` inject a fake `Terminal` global before the
 * component ever loads, so a shadowed import would fail against xterm's real
 * constructor shape at runtime, never in a type-checked, mocked test.
 */
declare const Terminal: any
declare const FitAddon: { FitAddon: any }
