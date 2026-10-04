// Why "Open in Cookrew" on cookrew.dev opened a bare Electron window (2026-10-04), and the fix.
//
// macOS binds a URL scheme to a BUNDLE ID, never to a path. In development the
// app runs out of node_modules/electron/dist/Electron.app, whose id is
// com.github.Electron — the same id as every other project's copy on the disk.
// `app.setAsDefaultProtocolClient` therefore says "cookrew:// → com.github.Electron",
// and Launch Services resolves that to whichever copy it likes (the highest
// CFBundleVersion, in practice): another project's Electron, launched bare, with
// the Electron welcome page. The execPath/argv form Electron's docs prescribe
// helps on Windows and Linux only; macOS ignores the arguments.
//
// This doctor lists every Electron.app Launch Services knows and, with --fix,
// unregisters the copies that are not this repository's, so the id resolves to
// the one copy the running dev app is — and the running app receives open-url.
// A packaged Cookrew.app has its own id (dev.cookrew.app) and needs none of this.
//
//   node scripts/dev-deeplink-doctor.mjs          report
//   node scripts/dev-deeplink-doctor.mjs --fix    unregister the foreign copies
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ours = path.join(repo, 'node_modules', 'electron', 'dist', 'Electron.app')

if (process.platform !== 'darwin') {
  console.log('Only macOS binds a scheme by bundle id; nothing to do here.')
  process.exit(0)
}

const dump = execFileSync(LSREGISTER, ['-dump'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
const copies = [...dump.matchAll(/^path:\s+(\/.*\/node_modules\/electron\/dist\/Electron\.app) \(/gm)].map((m) => m[1])
const handler = (dump.match(/handlerpref id:\s+cookrew \([^\n]*\n[^\n]*\n\s*all roles:\s+(\S+)/) ?? [])[1] ?? 'none'

console.log(`cookrew:// is bound to  ${handler}`)
console.log(`this repository's copy  ${ours}`)
for (const copy of copies) console.log(`${copy === ours ? '  keep   ' : '  foreign'} ${copy}`)

const foreign = copies.filter((copy) => copy !== ours)
if (!process.argv.includes('--fix')) {
  if (foreign.length > 0) console.log(`\n${foreign.length} foreign cop${foreign.length === 1 ? 'y' : 'ies'} can take the link. Run with --fix to unregister them.`)
  else console.log('\nOnly this repository’s copy is registered; the link reaches the running dev app.')
  process.exit(0)
}
for (const copy of foreign) {
  execFileSync(LSREGISTER, ['-u', copy], { stdio: 'ignore' })
  console.log(`unregistered ${copy}`)
}
execFileSync(LSREGISTER, ['-f', ours], { stdio: 'ignore' })
console.log(`re-registered ${ours}`)
console.log('Done. The next `npm install` in another Electron project may register its copy again — run this doctor again then.')
