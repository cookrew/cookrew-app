// THE CONNECT CODE: what the relay has never seen. It goes into the seal's keys, so
// it has to stay on this Mac, and a rotation has to end whoever came in on the old one.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createConnectCodes } from '../src/main/connect-code'
import { connectCodeId, SEAL_CODE_BYTES } from '../src/shared/canvas-seal'

let dir = ''
let file = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'connect-code-'))
  file = path.join(dir, 'nested', 'connect-code')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const bytes = (encoded: string): Uint8Array => new Uint8Array(Buffer.from(encoded, 'base64url'))

describe('createConnectCodes', () => {
  it('makes a code once, keeps it, and only its owner can read it', () => {
    const first = createConnectCodes(file).encoded()
    expect(bytes(first)).toHaveLength(SEAL_CODE_BYTES)
    expect(createConnectCodes(file).encoded()).toBe(first)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('names its code the way a phone does', async () => {
    const codes = createConnectCodes(file)
    const code = bytes(codes.encoded())
    expect(codes.codeFor(await connectCodeId(code))).toEqual(code)
  })

  it('knows no other code', async () => {
    const codes = createConnectCodes(file)
    expect(codes.codeFor(await connectCodeId(new Uint8Array(SEAL_CODE_BYTES)))).toBeNull()
    expect(codes.codeFor('')).toBeNull()
  })

  it('a rotation replaces it on disk, and the old one opens nothing', async () => {
    const codes = createConnectCodes(file)
    const old = bytes(codes.encoded())
    codes.rotate()
    expect(codes.encoded()).not.toBe(Buffer.from(old).toString('base64url'))
    expect(codes.codeFor(await connectCodeId(old))).toBeNull()
    expect(createConnectCodes(file).encoded()).toBe(codes.encoded())
  })

  it('a damaged file makes a new code rather than a weak one', () => {
    const first = createConnectCodes(file).encoded()
    writeFileSync(file, 'short\n')
    const next = createConnectCodes(file).encoded()
    expect(next).not.toBe(first)
    expect(bytes(next)).toHaveLength(SEAL_CODE_BYTES)
  })

  it('a served seat cannot read it', () => {
    expect(readFileSync('src/main/owner-secrets.ts', 'utf8')).toContain("'connect-code'")
  })
})

describe('the wiring', () => {
  const main = readFileSync('src/main/index.ts', 'utf8')

  it('the server gets the terminus, and quitting ends it', () => {
    expect(main).toContain('sealTerminus: () => sealTerminus')
    expect(main.indexOf('sealTerminus.close()')).toBeLessThan(main.indexOf('canvasLink.stop()'))
  })

  it('one rotation shuts out the old token and the old code together', () => {
    const rotate = main.slice(main.indexOf('rotatePairingToken: () => {'))
    const body = rotate.slice(0, rotate.indexOf('return rotateActivePairingToken()'))
    expect(body).toContain('connectCodes.rotate()')
    expect(body).toContain('sealTerminus.endSessions(')
  })

  it('a slow phone is seen on the relay line, not only on loopback', () => {
    expect(main).toContain('canvasLink.backlog()')
  })

  it('both ways a link is made carry the code', () => {
    expect(main.match(/connectCodes\.encoded\(\)/g)).toHaveLength(2)
  })
})

