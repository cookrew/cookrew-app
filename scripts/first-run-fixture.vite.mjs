// The real renderer on its demo api, for the first run's QA (first-run-shoot.mjs).
// Its own port and its own cache, never the app's .vite or a port the app uses.
//   npx vite --config scripts/first-run-fixture.vite.mjs
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export default {
  root: path.join(repo, 'src/renderer'),
  cacheDir: '/tmp/first-run-vite-cache',
  plugins: [react()],
  server: {
    port: Number(process.env.FIRST_RUN_PORT ?? 5377),
    strictPort: true,
    host: '127.0.0.1',
    hmr: false,
    watch: null,
    fs: { allow: [repo, path.resolve(repo, '../../..')] }
  }
}
