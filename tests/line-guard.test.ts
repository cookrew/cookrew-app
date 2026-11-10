import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { clipboardGuard, plainText } from '../resources/line-guard.mjs'

/**
 * WHAT SOMEONE ELSE'S SESSION MAY PRINT INTO A PANE OF MINE (resources/line-guard.mjs).
 *
 * An imported card's pane runs a small program that prints the bytes another
 * machine sends. The pane's own terminal reads them first: tmux, with the
 * clipboard switched on as Cookrew switches it, ANSWERS an OSC 52 query by
 * typing its newest copy into the pane, and the program forwards what is typed
 * to that other machine. So a query never reaches the pane. A copy does.
 *
 * The cases follow tmux's own reading of a string (input.c): it starts at
 * ESC ] (controls between the two are run, not counted), controls inside it
 * are ignored, and it is acted on however it ends: BEL, ST, ESC, CAN or SUB.
 */

const QUERY = '\x1b]52;c;?\x07'
const COPY = '\x1b]52;c;aGVsbG8=\x07'
const pass = (...chunks: string[]): string => {
  const guard = clipboardGuard()
  return chunks.map((chunk) => guard(chunk)).join('')
}
/** What a terminal that reads strings as tmux does would be asked, given what was let through. */
const asked = (shown: string): boolean => {
  // Controls are ignored inside a string; between ESC and ] they are run and bytes from DEL up are skipped.
  const plain = shown.replace(/[\x00-\x06\x08-\x17\x19\x1c-\x1f\x7f]/g, '').replace(/\x1b[^\x00-\x7e]+\]/g, '\x1b]')
  // The number is counted in 32 bits, so it wraps.
  return [...plain.matchAll(/\x1b\](\d+);[^;\x07\x1b\x18\x1a]*;\?(?:[\x07\x1b\x18\x1a]|$)/g)].some(([, digits]) => BigInt(digits) % 2n ** 32n === 52n)
}

describe('a query for the clipboard never reaches the pane', () => {
  it('is dropped whole, and what stands around it is untouched', () => {
    expect(pass(`before${QUERY}after`)).toBe('beforeafter')
    expect(pass('\x1b]52;c;?\x1b\\rest')).toBe('\x1b\\rest')
    expect(pass('\x1b]52;;?\x07')).toBe('')
    expect(pass('\x1b]52;pc;?\x07')).toBe('')
    expect(pass('\x1b]052;c;?\x07')).toBe('')
  })

  it('is dropped however it is cut across the frames it arrives in', () => {
    for (let cut = 1; cut < QUERY.length; cut++) expect(pass(`a${QUERY.slice(0, cut)}`, `${QUERY.slice(cut)}b`), String(cut)).toBe('ab')
    expect(pass(...[...`a${QUERY}b`])).toBe('ab')
  })

  it('is dropped however it ends: a string is acted on when it is left, not only when it is closed', () => {
    for (const end of ['\x1b', '\x18', '\x1a', '\x1b[0m']) {
      const shown = pass(`\x1b]52;c;?${end}text`)
      expect(asked(shown), JSON.stringify(end)).toBe(false)
      expect(shown.endsWith(`${end}text`), JSON.stringify(end)).toBe(true)
    }
  })

  it('is dropped with controls slipped into it, which the terminal would skip', () => {
    for (const bent of ['\x1b]5\x012;c;?\x07', '\x1b\x01]52;c;?\x07', '\x1b]52;c;\x02?\x07', '\x1b]\x7f52;c;?\x07', '\x1b\r\n]52;c;?\x07', '\x1b\x1b]52;c;?\x07']) {
      expect(asked(pass(bent)), JSON.stringify(bent)).toBe(false)
    }
  })

  it('is dropped under a number that only counts to 52 once it has wrapped', () => {
    // tmux counts the number in 32 bits (found in review, typed the clipboard back in a real pane).
    for (const wrapped of ['\x1b]4294967348;c;?\x07', '\x1b]8589934644;;?\x1b\\', '\x1b]65588;c;?\x07', '\x1b]18446744073709551668;c;?\x07']) {
      expect(pass(wrapped).includes('?'), JSON.stringify(wrapped)).toBe(false)
    }
    expect(asked('\x1b]4294967348;c;?\x07')).toBe(true)
  })

  it('is dropped with letters the terminal skips put between the ESC and the bracket', () => {
    // tmux skips every byte from DEL up while it waits to learn what an ESC began (found in review, same proof).
    for (const pieces of [['\x1b\u00e9]52;c;?\x07'], ['\x1b\u00a0]52;c;?\x07'], ['\x1b\u{1F600}]52;c;?\x07'], ['\x1b\x01\x7f\u00e9\x02]52;c;?\x18'], ['\x1b', '\u00e9', ']52;c;', '?', '\x07'], ['\x1b\ud800]52;c;?\x07']]) {
      const shown = pass(...pieces)
      expect(asked(shown), JSON.stringify(pieces)).toBe(false)
      expect(shown.includes('52;'), JSON.stringify(pieces)).toBe(false)
    }
    expect(asked('\x1b\u00e9]52;c;?\x07')).toBe(true)
  })

  it('takes the other clipboard protocol out whole: nothing over there has a use for it here', () => {
    expect(pass('a\x1b]5522;type=read;mime=text/plain\x1b\\b')).toBe('a\x1b\\b')
    expect(pass('\x1b]5522;type=write\x07')).toBe('')
  })

  it('is dropped when another string, or a wait, was put in front of it', () => {
    // tmux gives up on an unfinished string after a few seconds and reads on from the ground.
    expect(asked(pass('\x1b]0;a title', QUERY))).toBe(false)
    expect(asked(pass('\x1bPa device string', QUERY))).toBe(false)
    expect(asked(pass('\x1b[38;5;', QUERY))).toBe(false)
  })

  it('cannot be assembled out of pieces the guard let through', () => {
    // An opener let through, then a body sent as plain text.
    for (const pieces of [
      ['\x1b]', '\x9d', '52;c;?\x07', '52;c;?\x07'],
      ['\x1b]\x9d52;c;?\x07', '52;c;?\x07'],
      ['\x1b]52;\x9c;?\x07'],
      ['\x9d52;c;?\x07'],
      ['\x1b', '\x00'.repeat(5000), ']52;c;?\x07'],
      ['\x1b]', '\x00'.repeat(5000), '52;c;?\x07']
    ]) {
      expect(asked(pass(...pieces)), JSON.stringify(pieces).slice(0, 80)).toBe(false)
    }
  })

  it('takes no 8-bit control through: a terminal that reads them and one that does not must read the same thing', () => {
    expect(pass('a\x9db\x9cc\x90d\x9be')).toBe('abcde')
  })

  it('drops a clipboard string too long to judge, and holds no more than that of it', () => {
    const guard = clipboardGuard()
    expect(guard(`\x1b]52;${'c'.repeat(1 << 20)}`)).toBe('')
    expect(guard('c'.repeat(1 << 20))).toBe('')
    expect(guard(';?\x07after')).toBe('after')
  })
})

describe('everything else is shown as it was sent', () => {
  it('a copy lands: selecting in the other side’s tmux is copying', () => {
    expect(pass(COPY)).toBe(COPY)
    expect(pass('\x1b]52;;aGVsbG8=\x1b\\')).toBe('\x1b]52;;aGVsbG8=\x1b\\')
    expect(pass(...[...COPY])).toBe(COPY)
  })

  it('titles, colours, links and ordinary output pass byte for byte, in one frame or many', () => {
    const output = '\x1b]0;a title?\x07\x1b[1;32mgreen?\x1b[0m\r\n\x1b]8;;https://example.test/?q=1\x1b\\link\x1b]8;;\x1b\\ \x1b]11;?\x07 ünïcödé \x1b(B\x1b[?2004h'
    expect(pass(output)).toBe(output)
    expect(pass(...[...output])).toBe(output)
  })

  it('a lone ESC is held only until the next byte says what it began', () => {
    const guard = clipboardGuard()
    expect(guard('x\x1b')).toBe('x')
    expect(guard('[A')).toBe('\x1b[A')
  })
})

describe('both mirrors print through the guard, and the app ships it beside them', () => {
  const root = path.resolve(__dirname, '..')
  const builder = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')

  for (const script of ['orch-line.mjs', 'orch-mirror.mjs']) {
    it(`${script} writes the other machine’s bytes through it and nowhere around it`, () => {
      const source = readFileSync(path.join(root, 'resources', script), 'utf8')
      expect(source).toContain("from './line-guard.mjs'")
      expect(source).toMatch(/process\.stdout\.write\(shown\(payload\)\)/)
      expect(source).not.toMatch(/process\.stdout\.write\(payload\)/)
    })

    it(`every file ${script} imports from beside itself is packaged beside it`, () => {
      const source = readFileSync(path.join(root, 'resources', script), 'utf8')
      const beside = [...source.matchAll(/from '\.\/([A-Za-z0-9._-]+)'/g)].map(([, name]) => name)
      expect(beside.length).toBeGreaterThan(0)
      for (const name of beside) expect(builder, name).toMatch(new RegExp(`from: resources/${name.replace(/\./g, '\\.')}\\n\\s+to: ${name.replace(/\./g, '\\.')}\\n`))
    })
  }
})

/**
 * THE OTHER HALF: WHAT IS TYPED BACK. Whatever terminal hosts the pane, an
 * answer about the clipboard reaches the other machine only as bytes typed
 * into the pane, which the program forwards. So what is typed passes a guard
 * too, and that one takes out every clipboard string: a person does not type
 * one. It holds whether or not the first half read the question as this
 * pane's terminal did.
 */
describe('a clipboard answer typed into the pane is not forwarded', () => {
  const typed = (...chunks: string[]): string => {
    const guard = clipboardGuard({ typed: true })
    return chunks.map((chunk) => guard(chunk)).join('')
  }

  it('in tmux’s shape, the other terminals’ shape, whole or cut', () => {
    expect(typed('\x1b]52;;U0VDUkVU\x07')).toBe('')
    expect(typed('ls\r\x1b]52;c;U0VDUkVU\x1b\\pwd\r')).toBe('ls\r\x1b\\pwd\r')
    expect(typed('\x1b]5522;type=read:status=OK\x1b\\')).toBe('\x1b\\')
    const answer = '\x1b]52;;U0VDUkVU\x07'
    for (let cut = 1; cut < answer.length; cut++) expect(typed(answer.slice(0, cut), answer.slice(cut)).includes('U0VD'), String(cut)).toBe(false)
    expect(typed(...[...answer]).includes('U0VD')).toBe(false)
  })

  it('keys are forwarded as they are pressed: an Escape does not wait for the next key', () => {
    const guard = clipboardGuard({ typed: true })
    expect(guard('\x1b')).toBe('\x1b')
    expect(guard('x')).toBe('x')
    expect(guard('\x1b[A')).toBe('\x1b[A')
    expect(guard('\x1b\x1b[A')).toBe('\x1b\x1b[A')
    expect(guard('\x1bOP\x03\x1d\r')).toBe('\x1bOP\x03\x1d\r')
    expect(guard('caf\u00e9 \u0085')).toBe('caf\u00e9 \u0085')
    // An answer cut right after its ESC: the ESC is already gone, the rest is still taken out.
    expect(guard('\x1b')).toBe('\x1b')
    expect(guard(']52;;U0VDUkVU\x07')).toBe('')
  })

  it('both programs forward what is typed through it', () => {
    const root = path.resolve(__dirname, '..')
    for (const [script, call] of [['orch-line.mjs', "post('/line/raw', { data: sent })"], ['orch-mirror.mjs', 'data: sent']] as const) {
      const source = readFileSync(path.join(root, 'resources', script), 'utf8')
      expect(source, script).toContain('clipboardGuard({ typed: true })')
      expect(source, script).toContain(call)
    }
  })
})

describe('words the other machine sends for this program to say', () => {
  it('are said as words: no control survives, and no more than a line of them', () => {
    expect(plainText('\x1b]52;c;?\x07 budget\r\n\x9d')).toBe(']52;c;? budget')
    expect(plainText('x'.repeat(5000))).toHaveLength(200)
    expect(plainText({ toString: () => '\x1b[2J' })).toBe('[2J')
    expect(plainText(undefined)).toBe('')
  })

  it('the line program says a refusal’s words through it', () => {
    const source = readFileSync(path.resolve(__dirname, '..', 'resources', 'orch-line.mjs'), 'utf8')
    expect(source).not.toMatch(/\$\{body\??\.error/)
    expect(source.match(/plainText\(body\??\.error\)/g)?.length).toBeGreaterThanOrEqual(2)
  })
})
