// THE TUNE CHIP IN THE PROMPT BOX (owner 2026-11-01): aimed at an agent it is
// that agent's live model · effort · route button; with nobody targeted it
// picks what the new agent starts on, and the pick rides the launch flags.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NewAgentTune } from '../src/renderer/src/prompt/NewAgentTune'
import { lastLaunchTune, offeredPart, rememberLaunchTune, withLaunchKnob } from '../src/renderer/src/prompt/launch-pref'
import { launchOffer } from '../src/shared/launch-tune'

const src = (file: string): string => readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', file), 'utf8')
const CLAUDE = launchOffer('claude --permission-mode bypassPermissions')

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

describe('the new agent’s pick, remembered', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true })
  })

  it('starts at the harness defaults, then keeps the last pick', () => {
    expect(lastLaunchTune()).toEqual({})
    rememberLaunchTune({ model: 'sonnet', effort: 'max' })
    expect(lastLaunchTune()).toEqual({ model: 'sonnet', effort: 'max' })
  })

  it('reads a torn value as no pick', () => {
    localStorage.setItem('cookrew.new-agent-tune', '{nope')
    expect(lastLaunchTune()).toEqual({})
    localStorage.setItem('cookrew.new-agent-tune', JSON.stringify({ model: 7, effort: 'high' }))
    expect(lastLaunchTune()).toEqual({ effort: 'high' })
  })

  it('sets one knob or clears it back to the default, without touching the old pick', () => {
    const before = { model: 'opus', effort: 'high' }
    expect(withLaunchKnob(before, 'effort', 'low')).toEqual({ model: 'opus', effort: 'low' })
    expect(withLaunchKnob(before, 'model', null)).toEqual({ effort: 'high' })
    expect(before).toEqual({ model: 'opus', effort: 'high' })
  })

  it('sends only what the harness takes', () => {
    expect(offeredPart({ model: 'opus', effort: 'ultracode' }, CLAUDE)).toEqual({ model: 'opus' })
    expect(offeredPart({ model: 'opus' }, null)).toEqual({})
  })
})

describe('the chip', () => {
  it('reads the pick, or "default"', () => {
    if (!CLAUDE) throw new Error('claude must take a pick')
    expect(renderToStaticMarkup(<NewAgentTune offer={CLAUDE} tune={{ model: 'opus', effort: 'high' }} onPick={() => {}} />)).toContain('opus · high ▾')
    expect(renderToStaticMarkup(<NewAgentTune offer={CLAUDE} tune={{}} onPick={() => {}} />)).toContain('default ▾')
  })
})

describe('the box carries it', () => {
  const box = src('prompt/GlobalPrompt.tsx')

  it('draws the aimed agent’s own tune button, rising over the dock', () => {
    expect(box).toContain('<CardTune key={to.id} terminalId={to.id}')
    const line = box.split('\n').find((l) => l.includes('<CardTune key={to.id}')) ?? ''
    expect(line).toContain(' rise />')
  })

  it('draws the new agent’s chip only for a harness that takes a pick, and sends the pick with the prompt', () => {
    expect(box).toContain('offer && <NewAgentTune offer={offer}')
    expect(box).toContain('autoName: true, tune }')
  })
})
