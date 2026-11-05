// BOX ROUND 3, BUG 1. A person cannot act on an environment variable. No
// sentence the app shows may name one: the words say what is true and what to
// do on the machine in front of them. The launch line stays for operators, in
// comments and logs.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { V3_COPY } from '../src/shared/account-copy'
import { TRANSLATE_FAILURE_TEXT } from '../src/shared/translate'
import { REFUSAL_FOR_A_PERSON } from '../src/main/host-claim'
import { linuxScreenRefusal } from '../src/main/linux-screen'
import { discover } from '../src/main/route/discovery'

const ENV_NAME = /\b(COOKREW|MAGPIE|ALMA|VPHONE|XDG|CLAUDE_CODE)_[A-Z_]+/

const tsxUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return tsxUnder(full)
    return entry.name.endsWith('.tsx') ? [full] : []
  })

const isComment = (line: string): boolean => /^\s*(\*|\/\/|\/\*|\{\/\*)/.test(line)

describe('no sentence names an environment variable', () => {
  it('in any component', () => {
    const named = tsxUnder('src/renderer/src').flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !isComment(line) && ENV_NAME.test(line))
        .map((line) => `${file}: ${line.trim()}`)
    )
    expect(named).toEqual([])
  })

  it('in the account copy', () => {
    expect(Object.values(V3_COPY).filter((text) => ENV_NAME.test(text))).toEqual([])
  })

  it('in a translation failure', () => {
    expect(Object.values(TRANSLATE_FAILURE_TEXT).filter((text) => ENV_NAME.test(text))).toEqual([])
  })

  it('in the dialog of a refused launch', () => {
    expect(REFUSAL_FOR_A_PERSON).not.toMatch(ENV_NAME)
    expect(readFileSync('src/main/index.ts', 'utf8')).toContain("showErrorBox('Cookrew is already running', REFUSAL_FOR_A_PERSON)")
  })

  it('on the remote desktop card, where a bare name counts too', () => {
    expect(linuxScreenRefusal({})).not.toMatch(/\bDISPLAY\b/)
    expect(linuxScreenRefusal({ XDG_SESSION_TYPE: 'wayland' })).not.toMatch(ENV_NAME)
  })

  it('in a refused gateway', () => {
    const found = discover(
      { env: { MAGPIE_ADDR: 'http://10.1.2.3:3425' }, home: '/nowhere', readFile: () => null } as never,
      false
    )
    expect(found.why).toContain('10.1.2.3')
    expect(found.why).not.toMatch(ENV_NAME)
  })
})
