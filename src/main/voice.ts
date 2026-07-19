import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import path from 'node:path'

const CONFIG_FILE = path.join(homedir(), '.cookrew', 'voice.json')

interface VoiceConfig {
  enabled: boolean
  voice: string | null
  rate: number | null
}

/**
 * Spoken replies, Agent-Grid style "voice mode": agents talk back when they
 * finish. Uses the macOS `say` engine (no cloud, no keys); other platforms
 * report unsupported. Dictation (speech → text) lives in the mobile client,
 * where the browser's Web Speech API is available.
 */
export class VoiceEngine {
  private config: VoiceConfig

  constructor() {
    this.config = load()
  }

  get enabled(): boolean {
    return this.config.enabled
  }

  setEnabled(enabled: boolean): void {
    this.config = { ...this.config, enabled }
    void this.persist()
  }

  setVoice(voice: string): void {
    this.config = { ...this.config, voice }
    void this.persist()
  }

  setRate(rate: number): void {
    this.config = { ...this.config, rate }
    void this.persist()
  }

  status(): string {
    return [
      `Voice replies: ${this.config.enabled ? 'on' : 'off'}`,
      `Voice: ${this.config.voice ?? 'system default'}`,
      `Rate: ${this.config.rate ?? 'default'} wpm`
    ].join('\n')
  }

  async listVoices(): Promise<string> {
    if (platform() !== 'darwin') return 'Voice output requires macOS (uses the `say` engine).'
    const output = await run('say', ['-v', '?'])
    return output.trim()
  }

  /** Speak text out loud. Resolves when playback finishes. */
  async speak(text: string): Promise<void> {
    if (platform() !== 'darwin') throw new Error('Voice output requires macOS')
    const args: string[] = []
    if (this.config.voice) args.push('-v', this.config.voice)
    if (this.config.rate) args.push('-r', String(this.config.rate))
    args.push('--', sanitize(text))
    await run('say', args)
  }

  /** Speak a completed agent reply, trimmed to something listenable. */
  async speakReply(agentName: string, reply: string): Promise<void> {
    const gist = reply.replace(/\s+/g, ' ').trim().slice(0, 280)
    await this.speak(`${agentName} finished. ${gist}`)
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
      await fs.writeFile(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf8')
    } catch (error) {
      console.error('Failed to persist voice config:', error)
    }
  }
}

function sanitize(text: string): string {
  return text.replace(/[\x00-\x1f]/g, ' ').slice(0, 1000)
}

function load(): VoiceConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as VoiceConfig
    }
  } catch (error) {
    console.error('Failed to load voice config:', error)
  }
  return { enabled: false, voice: null, rate: null }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message))
      else resolve(stdout)
    })
  })
}
