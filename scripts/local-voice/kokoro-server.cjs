'use strict'

/**
 * THE LOCAL VOICE'S PROCESS (main/local-voice.ts spawns it; install with
 * scripts/local-voice/install.mjs).
 *
 * Kokoro-82M v1.1-zh through sherpa-onnx, on this Mac's CPU: no network, no
 * key, no bill. It runs apart from the app because one chunk takes a second
 * or more of solid CPU, which would freeze the main process.
 *
 * Talks JSON lines. In:  {"id","text","lang":"zh"|"en"}  or  {"cancel": id}
 *                    Out: {"id","ok":true,"wav":<base64>}  or  {"id","ok":false,"error"}
 * One chunk at a time, in order; a cancelled chunk that has not started is dropped.
 * Runs under a real node (runtime.json): Electron in node mode refuses the
 * addon's external audio buffers.
 *
 * THE PACE is a speaking rate, not a multiplier: each voice is timed once on
 * a calibration line at speed 1, and its speed is set so it says
 * `charsPerSecond` Chinese characters a second (about 5.2: a brisk,
 * conversational pace like Doubao's).
 */

const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const sherpa = require('sherpa-onnx-node')
const { sayableText, supplementLexicon } = require('./kokoro-words.cjs')

const HOME = __dirname
const MODEL = path.join(HOME, 'kokoro-multi-lang-v1_1')
const SUPPLEMENT_FILE = path.join(HOME, 'lexicon-cookrew.txt')
const CALIBRATION = '好的，我已经把这件事处理完了，测试也全部通过，你可以直接去看结果。'

const DEFAULTS = { sid: 36, englishSid: 0, charsPerSecond: 5.2, englishSpeed: 1.1 }

function config() {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(HOME, 'voice.json'), 'utf8'))
    return { ...DEFAULTS, ...saved }
  } catch {
    return DEFAULTS
  }
}

function lexiconWords(file) {
  const words = new Set()
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const space = line.indexOf(' ')
    if (space > 0) words.add(line.slice(0, space))
  }
  return words
}

function wav(samples, rate) {
  const bytes = Buffer.alloc(44 + samples.length * 2)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(36 + samples.length * 2, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(rate, 24)
  bytes.writeUInt32LE(rate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i += 1) {
    bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  }
  return bytes
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function main() {
  fs.writeFileSync(SUPPLEMENT_FILE, supplementLexicon())
  const english = lexiconWords(path.join(MODEL, 'lexicon-us-en.txt'))
  const known = (word) => english.has(word)
  const tts = await sherpa.OfflineTts.createAsync({
    model: {
      kokoro: {
        model: path.join(MODEL, 'model.onnx'),
        voices: path.join(MODEL, 'voices.bin'),
        tokens: path.join(MODEL, 'tokens.txt'),
        lexicon: [path.join(MODEL, 'lexicon-us-en.txt'), SUPPLEMENT_FILE, path.join(MODEL, 'lexicon-zh.txt')].join(',')
      },
      numThreads: 4,
      provider: 'cpu',
      debug: false
    },
    maxNumSentences: 1,
    ruleFsts: ['date-zh.fst', 'phone-zh.fst', 'number-zh.fst'].map((f) => path.join(MODEL, f)).join(',')
  })

  // Each voice's own rate at speed 1, timed once and kept on disk.
  const PACE_FILE = path.join(HOME, 'pace.json')
  let paces = {}
  try {
    paces = JSON.parse(fs.readFileSync(PACE_FILE, 'utf8'))
  } catch {
    paces = {}
  }
  const paceOf = (sid, charsPerSecond) => {
    if (typeof paces[sid] !== 'number') {
      const timed = tts.generate({ text: CALIBRATION, sid, speed: 1 })
      paces = { ...paces, [sid]: CALIBRATION.length / (timed.samples.length / timed.sampleRate) }
      fs.writeFileSync(PACE_FILE, `${JSON.stringify(paces, null, 2)}\n`)
    }
    return Math.min(2, Math.max(0.6, charsPerSecond / paces[sid]))
  }
  // Before the first chunk is asked for, not during it.
  paceOf(config().sid, config().charsPerSecond)

  const queue = []
  let busy = false
  const pump = async () => {
    if (busy) return
    busy = true
    // generate() is synchronous: yield between chunks so a cancel that
    // arrived meanwhile is read first.
    while (queue.length > 0) {
      await new Promise((resolve) => setImmediate(resolve))
      const job = queue.shift()
      if (!job) break
      try {
        const voice = config()
        const zh = job.lang !== 'en'
        const sid = zh ? voice.sid : voice.englishSid
        const speed = zh ? paceOf(voice.sid, voice.charsPerSecond) : voice.englishSpeed
        const audio = tts.generate({ text: sayableText(job.text, known), sid, speed })
        send({ id: job.id, ok: true, wav: wav(audio.samples, audio.sampleRate).toString('base64') })
      } catch (error) {
        send({ id: job.id, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    busy = false
  }

  send({ ready: true })
  const lines = readline.createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message && typeof message.cancel === 'string') {
      const at = queue.findIndex((job) => job.id === message.cancel)
      if (at >= 0) {
        queue.splice(at, 1)
        send({ id: message.cancel, ok: false, error: 'cancelled' })
      }
      return
    }
    if (!message || typeof message.id !== 'string' || typeof message.text !== 'string') return
    queue.push({ id: message.id, text: message.text, lang: message.lang })
    void pump()
  })
  lines.on('close', () => process.exit(0))
}

main().catch((error) => {
  send({ ready: false, error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
