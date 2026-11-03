#!/usr/bin/env node
/**
 * Install the local voice for spoken replies into ~/.cookrew/tts:
 *   node scripts/local-voice/install.mjs
 *
 * Free and offline once installed: Kokoro-82M v1.1-zh (Apache-2.0, about
 * 330 MB) run by sherpa-onnx (Apache-2.0). Downloads the model once, installs
 * the runtime beside it, copies the voice process, and says one test line.
 * Running it again refreshes the scripts and keeps the model and voice.json.
 */
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = path.join(homedir(), '.cookrew', 'tts')
const MODEL_DIR = 'kokoro-multi-lang-v1_1'
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${MODEL_DIR}.tar.bz2`
const RUNTIME = 'sherpa-onnx-node@2.0.1'

function step(message) {
  process.stdout.write(`local voice: ${message}\n`)
}

/** Every file the voice reads: a model directory missing one is not installed. */
const MODEL_FILES = ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'lexicon-zh.txt', 'date-zh.fst', 'phone-zh.fst', 'number-zh.fst']

function modelComplete() {
  return MODEL_FILES.every((file) => existsSync(path.join(HOME, MODEL_DIR, file)))
}

/**
 * Downloaded and unpacked in a scratch directory beside HOME, then moved into
 * place whole: an interrupted install leaves no half a model that looks done.
 */
function installModel() {
  if (modelComplete()) return step('model already here')
  const scratch = mkdtempSync(path.join(HOME, '.download-'))
  try {
    const archive = path.join(scratch, `${MODEL_DIR}.tar.bz2`)
    step(`downloading ${MODEL_URL}`)
    execFileSync('curl', ['-fsSL', '-o', archive, MODEL_URL], { stdio: 'inherit' })
    execFileSync('tar', ['xjf', archive, '-C', scratch], { stdio: 'inherit' })
    rmSync(path.join(HOME, MODEL_DIR), { recursive: true, force: true })
    renameSync(path.join(scratch, MODEL_DIR), path.join(HOME, MODEL_DIR))
    if (!modelComplete()) throw new Error(`the archive lacks part of ${MODEL_DIR}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function installRuntime() {
  if (!existsSync(path.join(HOME, 'package.json'))) writeFileSync(path.join(HOME, 'package.json'), '{ "private": true }\n')
  step(`installing ${RUNTIME}`)
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefix', HOME, RUNTIME], { stdio: 'inherit' })
}

/** This node, by a path that survives an upgrade (Homebrew's Cellar path is versioned). */
function stableNode() {
  const exec = process.execPath
  for (const link of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try {
      if (existsSync(link) && realpathSync(link) === realpathSync(exec)) return link
    } catch {
      // a broken link is not a node
    }
  }
  return exec
}

function installScripts() {
  for (const file of ['kokoro-server.cjs', 'kokoro-words.cjs']) copyFileSync(path.join(HERE, file), path.join(HOME, file))
  // The node that runs the voice: Electron's own cannot (its memory cage
  // refuses the native addon's audio buffers), and an app opened from Finder
  // has no shell PATH to find one with.
  writeFileSync(path.join(HOME, 'runtime.json'), `${JSON.stringify({ node: stableNode() }, null, 2)}\n`)
  const config = path.join(HOME, 'voice.json')
  if (!existsSync(config)) writeFileSync(config, `${JSON.stringify({ sid: 20, englishSid: 0, charsPerSecond: 5.2, englishWordsPerMinute: 190 }, null, 2)}\n`)
}

function smokeTest() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HOME, 'kokoro-server.cjs')], { cwd: HOME, stdio: ['pipe', 'pipe', 'ignore'] })
    let buffer = ''
    const timer = setTimeout(() => (child.kill(), reject(new Error('the voice did not answer in 60 s'))), 60_000)
    child.stdout.on('data', (data) => {
      buffer += data
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const message = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (message.ready === true) child.stdin.write(`${JSON.stringify({ id: 't', text: '本地语音已经装好了。' })}\n`)
        else if (message.ready === false) reject(new Error(message.error))
        else if (message.id === 't') {
          clearTimeout(timer)
          child.stdin.end()
          if (!message.ok) return reject(new Error(message.error))
          return resolve(Buffer.from(message.wav, 'base64').length)
        }
      }
    })
  })
}

mkdirSync(HOME, { recursive: true })
installModel()
installRuntime()
installScripts()
const bytes = await smokeTest()
step(`ready: a test line came back as ${Math.round(bytes / 1024)} KB of audio. Voice and pace: ${path.join(HOME, 'voice.json')}`)
