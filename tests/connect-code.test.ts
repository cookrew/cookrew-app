// THE CONNECT CODE: what the relay has never seen. It goes into the seal's keys, so
// it has to stay on this Mac, and a rotation has to end whoever came in on the old one.
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createConnectCodes } from '../src/main/connect-code'
import { ownerSecretPaths } from '../src/main/owner-secrets'
import { checkReplaced, connectCodeId, proveReplaced, SEAL_CODE_BYTES, startHandshake } from '../src/shared/canvas-seal'

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

  it('a rotation it cannot save says so, and the old code is dead for this run anyway', async () => {
    const codes = createConnectCodes(file)
    const old = bytes(codes.encoded())
    const nested = path.dirname(file)
    renameSync(nested, `${nested}-moved`)
    writeFileSync(nested, 'not a directory')
    expect(() => codes.rotate()).toThrow(/could not be saved/)
    expect(codes.codeFor(await connectCodeId(old))).toBeNull()
  })

  it('a damaged file makes a new code rather than a weak one', () => {
    const first = createConnectCodes(file).encoded()
    writeFileSync(file, 'short\n')
    const next = createConnectCodes(file).encoded()
    expect(next).not.toBe(first)
    expect(bytes(next)).toHaveLength(SEAL_CODE_BYTES)
  })

  it('remembers of a replaced code only what proves it was replaced, across a restart, and of the last few', async () => {
    const codes = createConnectCodes(file)
    const old = bytes(codes.encoded())
    const oldId = await connectCodeId(old)
    expect(codes.replacedKeyFor(oldId)).toBeNull()
    codes.rotate()
    const { hello } = await startHandshake(old)
    for (const holder of [codes, createConnectCodes(file)]) {
      const key = holder.replacedKeyFor(oldId)
      expect(key).not.toBeNull()
      expect(await checkReplaced(old, hello, await proveReplaced(key as Uint8Array, hello))).toBe(true)
      expect(holder.replacedKeyFor(await connectCodeId(bytes(holder.encoded())))).toBeNull()
    }
    expect(statSync(`${file}.was`).mode & 0o777).toBe(0o600)
    expect(readFileSync(`${file}.was`, 'utf8')).not.toContain(Buffer.from(old).toString('base64url'))
    for (let turn = 0; turn < 5; turn++) codes.rotate()
    expect(codes.replacedKeyFor(oldId)).toBeNull()
    expect(JSON.parse(readFileSync(`${file}.was`, 'utf8'))).toHaveLength(4)
  })

  it('a served seat cannot read it, nor catch it on its way to disk', () => {
    const denied = ownerSecretPaths('/Users/me/.cookrew', '/Users/me', 'cookrew', {})
    expect(denied).toContain('/Users/me/.cookrew/connect-code.was')
    expect(denied).toContain('/Users/me/.cookrew/connect-code.was.tmp')
    expect(denied).toContain('/Users/me/.cookrew/connect-code')
    expect(denied).toContain('/Users/me/.cookrew/connect-code.tmp')
    expect(denied).toContain('/Users/me/.cookrew/unlock-key.json.tmp')
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
    const body = rotate.slice(0, rotate.indexOf('return rotated'))
    expect(body).toContain('rotateActivePairingToken()')
    expect(body).toContain('connectCodes.rotate()')
    expect(body).toContain('sealTerminus.endSessions(')
  })

  it('a code that cannot be saved still ends the sessions, and the token has already gone', () => {
    const rotate = main.slice(main.indexOf('rotatePairingToken: () => {'))
    expect(rotate.indexOf('rotateActivePairingToken()')).toBeLessThan(rotate.indexOf('connectCodes.rotate()'))
    expect(rotate).toMatch(/try \{\s*connectCodes\.rotate\(\)\s*\} finally \{\s*sealTerminus\.endSessions\(/)
  })

  it('a slow phone is seen on the relay line, not only on loopback', () => {
    expect(main).toContain('canvasLink.backlog()')
  })

  it('only the link on the owner\'s own screen carries the code', () => {
    expect(main.match(/connectCodes\.encoded\(\)/g)).toHaveLength(1)
    // The request flow that once sealed a link for another device is not wired at all: it can admit nobody.
    expect(main).not.toContain('pairingUrlFor')
  })
})

