import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * The four settings below are load-bearing, each against a named failure:
 *
 *  base                  the page is served from `/`, but a relative base
 *                        survives any remount of the path
 *  assetsInlineLimit     `server.ts`'s MIME map knows .html/.js/.css/.json/.map
 *                        and nothing else; an emitted .svg or font would be
 *                        served as application/octet-stream
 *  cssCodeSplit          one stylesheet, so the page makes one request and the
 *                        committed diff has one CSS file in it
 *  sourcemap             `dist` is in git, and maps double every diff for a
 *                        user who does not have the source
 */
export default defineConfig({
  root: fileURLToPath(new URL('./src/web/app/', import.meta.url)),
  base: './',
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL('./dist/web/public/', import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: Infinity,
    cssCodeSplit: false,
    sourcemap: false,
  },
  server: {
    // Only `/api` needs proxying. The WebSocket connects straight to the engine
    // origin: `server.ts` authenticates the upgrade by token (`server.ts:155`)
    // and never inspects `Origin`, and a cross-origin WebSocket is not subject
    // to CORS preflight. Set MJLOOP_DEV_ORIGIN to the URL `mjloop-web` printed.
    proxy: {
      '/api': process.env['MJLOOP_DEV_ORIGIN'] ?? 'http://127.0.0.1:7777',
    },
  },
})
