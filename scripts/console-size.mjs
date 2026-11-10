// THE SIZE GATE: how much a first visit to the console downloads before it
// paints (the page, and the scripts, preloads and styles the page itself
// names), as the host sends it: brotli. Over the limit, the build is not
// shipped. What loads later, layer by layer, is not counted here.
//
//   node scripts/console-size.mjs [dir] [--limit-kb 300]     dir defaults to out/console
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants } from 'node:zlib'
import { firstLoad } from './console-host-files.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const at = args.indexOf('--limit-kb')
const limitKb = at === -1 ? 300 : Number(args[at + 1])
const dir = path.resolve(args.find((arg, index) => !arg.startsWith('--') && index !== at + 1) ?? path.join(root, 'out/console'))

const sent = (bytes) => brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length

try {
  if (!Number.isFinite(limitKb) || limitKb <= 0) throw new Error('--limit-kb takes a number of kilobytes')
  const page = readFileSync(path.join(dir, 'index.html'))
  const files = firstLoad(page.toString('utf8'))
  if (files.length === 0) throw new Error(`${path.join(dir, 'index.html')} names no script: this is not a built console`)
  const sizes = [['/index.html', sent(page)], ...files.map((file) => [file, sent(readFileSync(path.join(dir, file)))])]
  const total = sizes.reduce((sum, [, size]) => sum + size, 0)
  const kb = (bytes) => (bytes / 1024).toFixed(1)
  for (const [file, size] of sizes) process.stdout.write(`  ${kb(size).padStart(7)} KB  ${file}\n`)
  process.stdout.write(`first load: ${kb(total)} KB brotli (limit ${limitKb} KB)\n`)
  if (total > limitKb * 1024) {
    process.stderr.write(`first load is over its limit by ${kb(total - limitKb * 1024)} KB\n`)
    process.exit(1)
  }
} catch (error) {
  process.stderr.write(`size gate failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
