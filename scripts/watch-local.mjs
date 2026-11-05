#!/usr/bin/env node
// watch/Local.xcconfig: this Mac's own settings for building the watch app, so
// the app opens with the Mac's address filled in. Not committed.
//   node scripts/watch-local.mjs [APPLE_TEAM_ID]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'watch', 'Local.xcconfig')
const known = existsSync(file) ? readFileSync(file, 'utf8') : ''
const team = process.argv[2] ?? known.match(/DEVELOPMENT_TEAM = (\S+)/)?.[1] ?? ''
const lan = Object.values(networkInterfaces())
  .flat()
  .find((one) => one?.family === 'IPv4' && !one.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(one.address))?.address

// A bare address: "//" in an xcconfig value starts a comment.
writeFileSync(file, `COOKREW_BASE = ${lan ?? ''}\nDEVELOPMENT_TEAM = ${team}\n`)
console.log(`wrote ${file}: base ${lan ?? '(none found)'}, team ${team || '(none: set it in Xcode, or pass it here)'}`)
