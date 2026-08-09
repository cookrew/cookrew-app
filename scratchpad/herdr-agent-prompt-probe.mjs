// Can `herdr agent prompt` replace Cookrew's bracketed-paste + delayed-Enter?
//
// This is the question I deferred twice, because it can only be answered
// against a REAL agent TUI. The bug Cookrew's machinery exists to prevent —
// a TUI mid-ingest folding the submitting Enter into the paste, so the prompt
// sits in the input box forever ("[Pasted text] never sent") — does not
// reproduce against a shell.
//
// Runs in an ISOLATED herdr session with its own throwaway agent, so the
// user's real crew is never prompted.
//
// Measures, for a genuine `claude` TUI:
//   - does the prompt actually SUBMIT (not just land in the input box)
//   - does --wait --until idle return when the reply is done
//   - how long it takes
//   - does a LONG prompt still submit (the paste-swallow case)

import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'

const SESSION = 'cookrewprompt'
const env = { ...process.env, HERDR_SESSION: SESSION }
const cli = (args, opts = {}) =>
  execFileSync('herdr', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const run = async () => {
  try {
    cli(['server', 'stop'])
  } catch {
    /* not running */
  }
  rmSync(`${process.env.HOME}/.config/herdr/sessions/${SESSION}`, { recursive: true, force: true })

  const { spawn } = await import('node:child_process')
  spawn('herdr', ['server'], { detached: true, stdio: 'ignore', env }).unref()
  for (let i = 0; i < 40; i++) {
    try {
      cli(['pane', 'list'])
      break
    } catch {
      await sleep(250)
    }
  }

  const ws = JSON.parse(cli(['workspace', 'create', '--cwd', '/tmp']))
  const pane = ws.result.root_pane.pane_id
  console.log('pane:', pane)

  // A real claude TUI. bypassPermissions so it never blocks on approval.
  cli(['pane', 'send-text', pane, 'exec claude --permission-mode bypassPermissions'])
  cli(['pane', 'send-keys', pane, 'enter'])
  console.log('booting claude…')
  await sleep(18000)

  cli(['pane', 'report-agent', pane, '--source', 'probe', '--agent', 'claude', '--state', 'idle'])
  await sleep(1500)

  const readPane = () => {
    try {
      return cli(['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', '80'])
    } catch {
      return ''
    }
  }
  check('claude TUI booted', /claude|Welcome|>/i.test(readPane()))

  // --- 1. SHORT prompt -------------------------------------------------
  const MARK = 'ZK7Q'
  const t0 = Date.now()
  let waited = true
  try {
    cli([
      'agent', 'prompt', pane,
      `Reply with exactly this token and nothing else: ${MARK}`,
      '--wait', '--until', 'idle', '--timeout', '120000'
    ])
  } catch (e) {
    waited = false
    console.log('  prompt --wait errored:', String(e.message).slice(0, 160))
  }
  const shortMs = Date.now() - t0
  await sleep(2500)
  const after = readPane()
  // The token appears twice if submitted (echo + reply); once means it is
  // sitting unsent in the input box.
  const hits = (after.match(new RegExp(MARK, 'g')) ?? []).length
  check('short prompt SUBMITTED (token echoed AND answered)', hits >= 2, `${hits} occurrences`)
  check('--wait returned without error', waited, `${shortMs}ms`)

  // --- 2. LONG prompt — the paste-swallow case -------------------------
  const MARK2 = 'QW3T'
  const filler = 'context line that makes this prompt long enough to be pasted rather than typed. '
  const longPrompt = `${filler.repeat(40)}\nReply with exactly this token and nothing else: ${MARK2}`
  console.log(`long prompt: ${longPrompt.length} chars`)
  try {
    cli([
      'agent', 'prompt', pane, longPrompt,
      '--wait', '--until', 'idle', '--timeout', '120000'
    ])
  } catch (e) {
    console.log('  long prompt errored:', String(e.message).slice(0, 160))
  }
  await sleep(3000)
  const after2 = readPane()
  const hits2 = (after2.match(new RegExp(MARK2, 'g')) ?? []).length
  check('LONG prompt submitted (paste-swallow case)', hits2 >= 1, `${hits2} occurrences`)

  console.log('\n--- last 400 chars of pane ---')
  console.log(after2.slice(-400))

  cli(['server', 'stop'])
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  console.log(failed === 0 ? 'VERDICT: agent prompt is a viable replacement' : 'VERDICT: do NOT swap blindly')
  process.exit(0)
}

run().catch((e) => {
  console.error('probe failed:', e.message)
  try {
    execFileSync('herdr', ['server', 'stop'], { env, stdio: 'ignore' })
  } catch {
    /* ignore */
  }
  process.exit(1)
})
