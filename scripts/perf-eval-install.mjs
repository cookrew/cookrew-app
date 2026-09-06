#!/usr/bin/env node
/**
 * Schedule the live perf eval hourly through launchd (macOS).
 *
 *   npm run perf:install               # install + start
 *   npm run perf:install -- --uninstall
 *
 * The runner and its lib are COPIED to ~/.cookrew/bin, so the job keeps
 * working when this checkout moves, is a worktree that gets removed, or is
 * on a branch that has not merged yet. Re-run the install after changing
 * either script to refresh the copies. Output goes to
 * ~/.cookrew/perf-history/launchd.log; the eval's own history sits beside it.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LABEL = 'dev.cookrew.perf-eval'
const INTERVAL_SECONDS = 3600
const SCRIPTS = ['perf-eval.mjs', 'perf-eval-lib.mjs', 'perf-budgets.mjs']

const here = path.dirname(fileURLToPath(import.meta.url))
const cookrew = path.join(homedir(), '.cookrew')
const bin = path.join(cookrew, 'bin')
const history = path.join(cookrew, 'perf-history')
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
  <key>StartInterval</key><integer>${INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escape(path.join(history, 'launchd.log'))}</string>
  <key>StandardErrorPath</key><string>${escape(path.join(history, 'launchd.log'))}</string>
</dict>
</plist>
`
}

function uninstall() {
  launchctl('bootout', `${domain}/${LABEL}`)
  if (existsSync(plist)) rmSync(plist)
  for (const f of SCRIPTS) {
    const target = path.join(bin, f)
    if (existsSync(target)) rmSync(target)
  }
  process.stdout.write(`removed ${LABEL} (history kept in ${history})\n`)
}

/** A node under a version manager is a path the next upgrade deletes. */
const VERSION_MANAGED = /\/(\.nvm|\.fnm|\.asdf|\.volta|\.n)\//

function install() {
  mkdirSync(bin, { recursive: true })
  mkdirSync(history, { recursive: true })
  mkdirSync(path.dirname(plist), { recursive: true })
  for (const f of SCRIPTS) copyFileSync(path.join(here, f), path.join(bin, f))
  const script = path.join(bin, 'perf-eval.mjs')
  writeFileSync(plist, plistXml(process.execPath, script))
  if (VERSION_MANAGED.test(process.execPath)) {
    process.stderr.write(
      `warning: ${process.execPath} is under a version manager — the job dies silently when that version is removed; re-run perf:install after upgrading node\n`
    )
  }
  // bootout first so a re-install picks up the new plist; ignore "not loaded".
  launchctl('bootout', `${domain}/${LABEL}`)
  if (!launchctl('bootstrap', domain, plist)) {
    process.stderr.write(`launchctl bootstrap failed — load it by hand: launchctl bootstrap ${domain} ${plist}\n`)
    process.exit(1)
  }
  process.stdout.write(
    [
      `installed ${LABEL}: every ${INTERVAL_SECONDS / 60} min, and once now`,
      `  runner   ${script}`,
      `  plist    ${plist}`,
      `  history  ${history}`,
      `  log      ${path.join(history, 'launchd.log')}`,
      `  remove   npm run perf:install -- --uninstall`
    ].join('\n') + '\n'
  )
}

if (platform() !== 'darwin') {
  process.stderr.write('perf:install schedules through launchd and needs macOS; run `npm run perf:eval` from cron elsewhere\n')
  process.exit(2)
}
if (process.argv.includes('--uninstall')) uninstall()
else install()
