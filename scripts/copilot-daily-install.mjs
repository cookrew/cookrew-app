#!/usr/bin/env node
/**
 * Schedule the daily Copilot lane through launchd (macOS).
 *
 *   npm run daily:install               # install, runs daily at 04:30
 *   npm run daily:install -- --uninstall
 *
 * Copies the runner to ~/.cookrew/bin like perf-eval-install.mjs, so the job
 * survives this checkout moving. Re-run after changing a script. A Mac asleep
 * at 04:30 runs the lane when it wakes.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LABEL = 'dev.cookrew.copilot-daily'
const HOUR = 4
const MINUTE = 30
const STABLE_NODE = '/opt/homebrew/bin/node'
const SCRIPTS = ['copilot-daily.mjs', 'copilot-daily-lib.mjs', 'copilot-daily-ops.mjs']

const here = path.dirname(fileURLToPath(import.meta.url))
const bin = path.join(homedir(), '.cookrew', 'bin')
const state = path.join(homedir(), '.cookrew', 'copilot-daily')
const plist = path.join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const domain = `gui/${process.getuid?.() ?? ''}`

function launchctl(...args) {
  try {
    execFileSync('launchctl', args, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function plistXml(nodeBin, script) {
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const log = escape(path.join(state, 'launchd.log'))
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(nodeBin)}</string>
    <string>${escape(script)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${HOUR}</integer>
    <key>Minute</key><integer>${MINUTE}</integer>
  </dict>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`
}

function uninstall() {
  launchctl('bootout', `${domain}/${LABEL}`)
  if (existsSync(plist)) rmSync(plist)
  for (const file of SCRIPTS) rmSync(path.join(bin, file), { force: true })
  process.stdout.write(`removed ${LABEL} (history kept in ${state})\n`)
}

function install() {
  mkdirSync(bin, { recursive: true })
  mkdirSync(state, { recursive: true })
  for (const file of SCRIPTS) copyFileSync(path.join(here, file), path.join(bin, file))
  // The Cellar path in execPath dies at the next brew cleanup, and the job with it, silently.
  const nodeBin = existsSync(STABLE_NODE) ? STABLE_NODE : process.execPath
  writeFileSync(plist, plistXml(nodeBin, path.join(bin, 'copilot-daily.mjs')))
  launchctl('bootout', `${domain}/${LABEL}`)
  if (!launchctl('bootstrap', domain, plist)) throw new Error(`launchctl could not load ${plist}`)
  process.stdout.write(`installed ${LABEL}: daily at 0${HOUR}:${MINUTE}, log in ${state}/launchd.log\n`)
}

if (process.platform !== 'darwin') {
  process.stderr.write('launchd is macOS only\n')
  process.exitCode = 1
} else if (process.argv.includes('--uninstall')) {
  uninstall()
} else {
  install()
}
