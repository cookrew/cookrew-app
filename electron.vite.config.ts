import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- a plain .mjs build helper, tested on its own
import { keepRecentChunks } from './scripts/keep-recent-chunks.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))

/**
 * Modules the renderer's entry asks for LAZILY (color-scheme.ts,
 * relay-machine-call.ts) that App imports STATICALLY. App is asked for on the
 * entry's first line, so every boot fetched them anyway, each as a chunk of
 * its own: three requests, three relay exchanges of a phone's boot
 * (tests/perf/budgets.ts · REMOTE_OPEN). They ride in the entry's chunk with
 * main.tsx instead (~38 KB). NOT in App's chunk: there the entry would have to
 * load all of App before main.tsx could run (measured 2026-11-18).
 */
const ENTRY_RIDERS = /src[\\/]renderer[\\/]src[\\/](main\.tsx|skins[\\/]skin-look\.ts|account-device\.ts|account-pair-client\.ts)$/
const entryChunk = (id: string): string | undefined => (ENTRY_RIDERS.test(id) ? 'index' : undefined)

/**
 * The header's mark (header.css masks with it) is 5.7 KB, just over Vite's
 * 4 KB inline limit, so every boot fetched it as a file of its own: one more
 * relay exchange. Inlined into the stylesheet it is already in. Every other
 * asset keeps Vite's own rule (undefined).
 */
const inlineAsset = (file: string): boolean | undefined => (/[\\/]brand[\\/]co-mark\.svg$/.test(file) ? true : undefined)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: path.join(root, 'src/main/index.ts'),
          'storage-gc-worker': path.join(root, 'src/main/storage-gc-worker-entry.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: { format: 'cjs' }
      }
    }
  },
  renderer: {
    // Earlier builds' chunks stay for a while (scripts/keep-recent-chunks.mjs):
    // a phone that loaded the page before a rebuild must still find them.
    build: {
      emptyOutDir: false,
      assetsInlineLimit: inlineAsset,
      rollupOptions: { output: { manualChunks: entryChunk } }
    },
    plugins: [react(), keepRecentChunks()]
  }
})
