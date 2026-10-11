// WHERE THE STUCK SENTENCE COMES FROM (route program, lane e2e2, item 2).
//
// A routed card that the RTE dial respawns came back with a sentence sitting in its composer, so
// every later `cookrew ask` to it read "owner is composing" and dropped the brief. Two mechanisms
// could put it there — Claude Code restoring its own draft, or herdr re-adopting the pane and
// replaying what it had — and the difference decides who fixes it.
//
// This isolates the first: a scratch tmux server (`-L ux-e2e2`, nothing to do with the owner's
// fleet or any Cookrew card), one Claude Code routed at Ollama through the live Magpie gateway,
// and the respawn route/service.ts performs — `ptys.kill(id)` then a spawn that resumes the same
// session, which for claude is `harness.ts resumeCommand`: `claude … --resume <sessionId>`.
//
// Two legs, because "the previous prompt" can mean two different things:
//   A · SENT     one full turn, then kill + --resume → is the prompt that was answered back in
//                the composer?
//   B · UNSENT   a sentence typed and NOT sent, then kill + --resume → is the draft back?
//
// Leg B is the shape that matches the symptom (a sentence nobody sent), and both legs run without
// herdr at all, so whatever appears here is Claude's own doing.
//
//   node scratchpad/stuck-sentence.mjs            # both legs
//   node scratchpad/stuck-sentence.mjs --leg=a    # one of them
//
// Captures: /tmp/ux-e2e2-stuck-<leg>-<step>.txt · record: /tmp/ux-e2e2-stuck.json
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const SOCKET = 'ux-e2e2'
const SESSION = 'stuck'
const DIR = '/tmp/ux-e2e2-stuck'
/** The real path, which is what Claude Code's project slug is made from on this machine. */
const REAL_DIR = `/private${DIR}`
const GATEWAY = 'http://127.0.0.1:3425'
const KEY = 'magpie-cookrew'
/** The model Ollama already holds: a cold one may never load here (report-e2e.md §8). */
const MODEL = 'ollama/qwen2.5:1.5b'
const SENT = 'Reply with the single word ALPHA and nothing else.'
const DRAFT = 'BRAVO this sentence was never sent'

const args = process.argv.slice(2)
const leg = (args.find((a) => a.startsWith('--leg=')) ?? '--leg=ab').slice(6).toLowerCase()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmux = (...argv) => execFileSync('tmux', ['-L', SOCKET, ...argv], { encoding: 'utf8' })
const quiet = (...argv) => {
  try {
    return tmux(...argv)
  } catch {
    return ''
  }
}
const pane = () => quiet('capture-pane', '-p', '-t', SESSION)

/** The env route-env.ts composes for a claude card, spelled as a shell prefix. */
function routeEnvLine(cardId) {
  const pairs = {
    ANTHROPIC_BASE_URL: GATEWAY,
    ANTHROPIC_AUTH_TOKEN: KEY,
    ANTHROPIC_MODEL: MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    ANTHROPIC_CUSTOM_HEADERS: `X-Magpie-Session: cookrew:${cardId}`,
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1'
  }
  return Object.entries(pairs)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ')
}

const BOOT = 'claude --permission-mode bypassPermissions'

function start(command) {
  quiet('kill-session', '-t', SESSION)
  mkdirSync(DIR, { recursive: true })
  tmux('new-session', '-d', '-s', SESSION, '-x', '150', '-y', '45', '-c', DIR, command)
}

/** Wait for the pane to satisf`ok`, giving the reason and the last screen when it does not. */
async function until(what, ok, timeoutMs = 120_000, everyMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  let screen = ''
  while (Date.now() < deadline) {
    screen = pane()
    // A fresh directory asks to be trusted before the composer exists.
    if (/do you trust|trust the files/i.test(screen)) {
      tmux('send-keys', '-t', SESSION, 'Enter')
      await sleep(1_500)
      continue
    }
    if (ok(screen)) return screen
    await sleep(everyMs)
  }
  throw new Error(`${what}: never happened in ${Math.round(timeoutMs / 1000)}s. Last screen:\n${screen}`)
}

/**
 * Claude Code 2.1.275 draws its composer as a `❯` line between two horizontal rules — NOT the
 * rounded box an earlier guess here looked for, which is why the first run of this script timed
 * out on a screen that was in fact ready and routed.
 */
const PROMPT = '\u276f'
const RULE = /^\u2500{10,}/
const composerUp = (s) => s.includes(PROMPT) && RULE.test(s.split('\n').find((l) => RULE.test(l)) ?? '')

/** The composer's own lines — the rules around the `❯`, never the transcript above them. */
function composer(screen) {
  const lines = screen.split('\n')
  const at = lines.map((l, i) => [l, i]).filter(([l]) => l.includes(PROMPT)).pop()
  if (!at) return ''
  let top = at[1]
  while (top > 0 && !RULE.test(lines[top - 1])) top -= 1
  let bottom = at[1]
  while (bottom < lines.length - 1 && !RULE.test(lines[bottom + 1])) bottom += 1
  return lines.slice(top, bottom + 1).join('\n')
}

function save(name, text) {
  const file = `/tmp/ux-e2e2-stuck-${name}.txt`
  writeFileSync(file, `${text}\n`)
  return file
}

/** The newest session file Claude Code wrote for this directory. */
function sessionId() {
  const slug = REAL_DIR.replace(/\//g, '-')
  const dir = path.join(process.env.HOME ?? '', '.claude', 'projects', slug)
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, m: statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  return files[0] ? files[0].f.replace(/\.jsonl$/, '') : null
}

const record = { startedAt: new Date().toISOString(), model: MODEL, socket: SOCKET, dir: DIR, legs: {} }

/** LEG A — a sentence that was asked and answered, then kill + --resume. */
async function legA() {
  const cardId = `ux-e2e2-a-${Date.now().toString(36)}`
  start(`${routeEnvLine(cardId)} ${BOOT}`)
  await until('the composer appears', composerUp)
  tmux('send-keys', '-t', SESSION, '-l', SENT)
  await sleep(600)
  const typed = composer(pane())
  tmux('send-keys', '-t', SESSION, 'Enter')
  // The turn is over when the word is on screen outside the composer, or claude is idle again.
  const answered = await until('the turn is answered', (s) => /ALPHA/.test(s.replace(composer(s), '')), 180_000, 2_000)
  const before = save('a-1-answered', answered)
  const id = sessionId()
  // THE RESPAWN, as route/service.ts does it: the PTY is killed and the same session resumed.
  quiet('kill-session', '-t', SESSION)
  await sleep(1_000)
  if (!id) throw new Error('no Claude session file for the scratch directory — nothing to resume')
  start(`${routeEnvLine(cardId)} ${BOOT} --resume ${id}`)
  const resumed = await until('the composer appears after --resume', composerUp)
  const after = save('a-2-resumed', resumed)
  const box = composer(resumed)
  record.legs.a = {
    what: 'one answered turn, then kill + --resume',
    sessionId: id,
    sentenceTypedInComposer: typed.includes(SENT.slice(0, 24)),
    composerAfterResume: box,
    /** THE QUESTION: is the prompt that was already answered back in the input? */
    promptReappeared: box.includes(SENT.slice(0, 24)),
    transcriptHasPrompt: resumed.includes(SENT.slice(0, 24)),
    captures: [before, after]
  }
  quiet('kill-session', '-t', SESSION)
}

/** LEG B — a sentence typed and never sent, then kill + --resume. The symptom's shape. */
async function legB() {
  const cardId = `ux-e2e2-b-${Date.now().toString(36)}`
  start(`${routeEnvLine(cardId)} ${BOOT}`)
  await until('the composer appears', composerUp)
  tmux('send-keys', '-t', SESSION, '-l', DRAFT)
  await sleep(1_200)
  const draftScreen = pane()
  const before = save('b-1-draft', draftScreen)
  const inBox = composer(draftScreen).includes(DRAFT.slice(0, 16))
  const id = sessionId()
  quiet('kill-session', '-t', SESSION)
  await sleep(1_000)
  // With no turn there may be no session file at all; then the respawn is a plain boot, which is
  // exactly what route/service.ts does for a card with nothing to restore.
  start(`${routeEnvLine(cardId)} ${BOOT}${id ? ` --resume ${id}` : ''}`)
  const resumed = await until('the composer appears after the respawn', composerUp)
  const after = save('b-2-respawned', resumed)
  const box = composer(resumed)
  record.legs.b = {
    what: `a sentence typed and never sent, then kill + ${id ? '--resume' : 'a plain boot (no session file)'}`,
    sessionId: id,
    draftWasInComposer: inBox,
    composerAfterRespawn: box,
    /** THE QUESTION: does an unsent draft survive the respawn? */
    draftReappeared: box.includes(DRAFT.slice(0, 16)),
    captures: [before, after]
  }
  quiet('kill-session', '-t', SESSION)
}

async function main() {
  try {
    if (leg.includes('a')) await legA()
    if (leg.includes('b')) await legB()
  } catch (e) {
    record.error = String(e?.message ?? e)
  } finally {
    quiet('kill-server')
    record.finishedAt = new Date().toISOString()
    writeFileSync('/tmp/ux-e2e2-stuck.json', `${JSON.stringify(record, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
  if (record.error) process.exitCode = 1
}

await main()
