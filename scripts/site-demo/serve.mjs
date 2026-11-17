// node scripts/site-demo/serve.mjs — this repository's renderer on the synthetic fixture, port 5397, its own cache.
// The release-notes page the browser card opens is served separately on 5398 (another origin):
//   python3 -m http.server 5398 --bind 127.0.0.1 --directory scripts/site-demo/pages
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = realpathSync(path.dirname(fileURLToPath(import.meta.url)))
const repo = path.resolve(here, '../..')
const require = createRequire(repo + '/package.json')
const { createServer } = await import(repo + '/node_modules/vite/dist/node/index.js')
const react = require('@vitejs/plugin-react')
const server = await createServer({
  configFile: false,
  root: path.join(here, 'fixture'),
  publicDir: repo + '/src/renderer/public',
  cacheDir: realpathSync('/tmp') + '/cookrew-site-demo-vite',
  plugins: [(react.default ?? react)()],
  resolve: { alias: { '@repo': repo } },
  server: { port: 5397, strictPort: true, host: '127.0.0.1', hmr: false, fs: { allow: [repo, realpathSync(path.join(repo, 'node_modules'))] } }
})
await server.listen()
console.log('fixture on http://127.0.0.1:5397/')
