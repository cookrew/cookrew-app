#!/usr/bin/env node
/**
 * Schedule the daily Copilot lane through launchd (macOS).
 *
 *   npm run daily:install               # install, runs daily at 04:30
 *   npm run daily:install -- --uninstall
 *
 * Also installs the manual release trigger: the Release Cookrew app in
 * ~/Applications (Spotlight, or drag it to the Dock) and ~/.cookrew/bin/cookrew-release.
 *
 * Copies the runner to ~/.cookrew/bin like perf-eval-install.mjs, so the job
 * survives this checkout moving. Re-run after changing a script. A Mac asleep
 * at 04:30 runs the lane when it wakes.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseButtonScript } from './copilot-daily-lib.mjs'

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
const launcher = path.join(bin, 'cookrew-release')
const button = path.join(homedir(), 'Applications', 'Release Cookrew.app')
const repo = process.env.COOKREW_DAILY_REPO ?? path.join(homedir(), 'workspace', 'cookrew-dev')

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

/** Runs the release from the repo, detached, so closing whatever pressed it stops nothing. */
function launcherScript() {
  const log = path.join(state, 'release.log')
  return `#!/bin/sh
# cookrew-release plan|draft|publish|dry: the one way in for a manual release.
export PATH=/opt/homebrew/bin:/usr/bin:/bin
script='${path.join(repo, 'scripts', 'copilot-patch-release.mjs')}'
case "$1" in
  plan) exec node "$script" --plan ;;
  draft) flag= ;;
  publish) flag=--publish ;;
  dry) flag=--dry-run ;;
  *) echo 'usage: cookrew-release plan|draft|publish|dry' >&2; exit 2 ;;
esac
nohup node "$script" $flag >> '${log}' 2>&1 < /dev/null &
echo 'release started, log in ${log}'
`
}

function installButton() {
  writeFileSync(launcher, launcherScript())
  chmodSync(launcher, 0o755)
  mkdirSync(path.dirname(button), { recursive: true })
  rmSync(button, { recursive: true, force: true })
  execFileSync('osacompile', ['-o', button], { input: releaseButtonScript(launcher), stdio: ['pipe', 'pipe', 'pipe'] })
}

function uninstall() {
  launchctl('bootout', `${domain}/${LABEL}`)
  if (existsSync(plist)) rmSync(plist)
  rmSync(launcher, { force: true })
  rmSync(button, { recursive: true, force: true })
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
  installButton()
  launchctl('bootout', `${domain}/${LABEL}`)
  if (!launchctl('bootstrap', domain, plist)) throw new Error(`launchctl could not load ${plist}`)
  process.stdout.write(`installed ${LABEL}: daily at 0${HOUR}:${MINUTE}, log in ${state}/launchd.log\n`)
  process.stdout.write(`installed ${button} and ${launcher}\n`)
}

if (process.platform !== 'darwin') {
  process.stderr.write('launchd is macOS only\n')
  process.exitCode = 1
} else if (process.argv.includes('--uninstall')) {
  uninstall()
} else {
  install()
}
