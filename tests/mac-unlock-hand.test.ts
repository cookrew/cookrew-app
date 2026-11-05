// THE ONE THING THE HAND DOES AT A LOCKED SCREEN. Every other operation is still
// refused there, and the password travels on stdin, never on a command line.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAC_INPUT_SCRIPT, macKeystrokes } from '../src/main/mac-bridge'

describe('macKeystrokes', () => {
  it('uses physical keys: a secure field ignores a bare unicode event', () => {
    expect(macKeystrokes('a')).toEqual([{ code: 0, shift: false, unit: 97 }])
    expect(macKeystrokes('A')).toEqual([{ code: 0, shift: true, unit: 65 }])
    expect(macKeystrokes('1!')).toEqual([{ code: 18, shift: false, unit: 49 }, { code: 18, shift: true, unit: 33 }])
    expect(macKeystrokes(' ')).toEqual([{ code: 49, shift: false, unit: 32 }])
  })

  it('covers every printable ASCII character', () => {
    for (let unit = 32; unit < 127; unit += 1) {
      expect(macKeystrokes(String.fromCharCode(unit))[0].code, String.fromCharCode(unit)).toBeGreaterThanOrEqual(0)
    }
  })

  it('sends what it cannot place as the character alone', () => {
    expect(macKeystrokes('é')).toEqual([{ code: -1, shift: false, unit: 233 }])
  })
})

describe('the script', () => {
  const lockCheck = MAC_INPUT_SCRIPT.indexOf("if (locked()) throw new Error('the screen is locked')")

  it('still refuses every other operation at a locked screen', () => {
    expect(lockCheck).toBeGreaterThan(0)
    for (const op of ["case 'click'", "case 'drag'", "case 'scroll'", "case 'key'", "case 'type'"]) {
      expect(MAC_INPUT_SCRIPT.indexOf(op)).toBeGreaterThan(lockCheck)
    }
  })

  it('unlock runs before that check, and only on a locked screen', () => {
    const unlock = MAC_INPUT_SCRIPT.indexOf("if (op.op === 'unlock')")
    expect(unlock).toBeGreaterThan(0)
    expect(unlock).toBeLessThan(lockCheck)
    expect(MAC_INPUT_SCRIPT).toContain("if (!locked()) throw new Error('not locked')")
  })
})

describe('who can reach it', () => {
  it('no viewer or agent verb sends it: one call site, behind the unlock door', () => {
    expect(readFileSync('src/main/use-instances.ts', 'utf8')).toContain("op: 'unlock'")
    for (const file of ['src/main/screen-device.ts', 'src/main/use-commands.ts', 'src/main/pixel-instance.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/op: 'unlock'|typeAtLock/)
    }
  })

  it('the password goes in on stdin, never on a command line', () => {
    const bridge = readFileSync('src/main/mac-bridge.ts', 'utf8')
    expect(bridge).toContain('child.stdin.write(`${JSON.stringify(')
    expect(bridge).not.toMatch(/spawn\([^)]*password/)
  })

  it('a served seat cannot read the key a password opens under', () => {
    expect(readFileSync('src/main/owner-secrets.ts', 'utf8')).toContain("'unlock-key.json'")
  })
})
