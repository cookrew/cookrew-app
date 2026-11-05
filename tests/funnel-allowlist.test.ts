import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FUNNEL_EVENTS,
  FUNNEL_PAYLOAD_KEYS,
  TELEMETRY_DEFAULT_ON,
  TELEMETRY_ROW_NOTE,
  dayOf,
  osFamilyOf,
  readFunnelPayload,
  type FunnelPayload
} from '../src/shared/funnel-events'

/**
 * THE ALLOWLIST IS THE PRIVACY PROMISE, WRITTEN AS A TYPE AND A PARSER.
 *
 * The app and the registry read the same one, so nothing can be sent that the
 * receiver would not take, and nothing can be taken that this file did not
 * name. Every field is either a closed set or a shape too narrow to hold text.
 */

const good: FunnelPayload = {
  event: 'installed',
  appVersion: '0.4.0',
  osFamily: 'mac',
  installId: '3f2b8c1e-9d4a-4e7b-8a6f-0c1d2e3f4a5b',
  day: '2026-11-05'
}

describe('what may exist', () => {
  it('is exactly five events', () => {
    expect([...FUNNEL_EVENTS]).toEqual(['installed', 'preflight_passed', 'first_turn_done', 'phone_paired', 'paid'])
  })

  it('is exactly five fields', () => {
    expect([...FUNNEL_PAYLOAD_KEYS].sort()).toEqual(['appVersion', 'day', 'event', 'installId', 'osFamily'])
    expect(Object.keys(good).sort()).toEqual([...FUNNEL_PAYLOAD_KEYS].sort())
  })

  it('the type refuses a sixth field at compile time', () => {
    // `npm run typecheck` covers tests/: this line fails it if the type ever widens.
    // @ts-expect-error a prompt is not a field of the payload
    const widened: FunnelPayload = { ...good, prompt: 'fix the login bug' }
    expect(readFunnelPayload(widened)).toBeNull()
  })

  it('is on by the owner ruling of 2026-11-05', () => {
    expect(TELEMETRY_DEFAULT_ON).toBe(true)
  })

  it('counts packaged builds only, so a source build is never an install', () => {
    const main = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
    expect(main).toContain('defaultOn: app.isPackaged && TELEMETRY_DEFAULT_ON')
  })
})

describe('reading a payload', () => {
  it('takes the five fields and hands back a copy of only those', () => {
    expect(readFunnelPayload({ ...good })).toEqual(good)
    for (const event of FUNNEL_EVENTS) expect(readFunnelPayload({ ...good, event })?.event).toBe(event)
  })

  it('refuses any extra key rather than stripping it', () => {
    for (const extra of ['prompt', 'path', 'cardName', 'username', 'email', 'repo', 'output', 'ip']) {
      expect(readFunnelPayload({ ...good, [extra]: 'x' })).toBeNull()
    }
  })

  it('refuses a missing key', () => {
    for (const key of FUNNEL_PAYLOAD_KEYS) {
      const { [key]: _dropped, ...rest } = good
      expect(readFunnelPayload(rest)).toBeNull()
    }
  })

  it('refuses an event nobody named', () => {
    expect(readFunnelPayload({ ...good, event: 'prompt_sent' })).toBeNull()
    expect(readFunnelPayload({ ...good, event: '__proto__' })).toBeNull()
    expect(readFunnelPayload({ ...good, event: 'constructor' })).toBeNull()
  })

  it.each([
    ['appVersion', '/Users/drej/workspace'],
    ['appVersion', 'alice@example.com'],
    ['appVersion', '0.4.0-alice'],
    ['appVersion', '0.4.0+repo.name'],
    ['osFamily', 'Darwin 25.5.0'],
    ['osFamily', 'alices-macbook'],
    ['installId', 'alice'],
    ['installId', 'alice@example.com'],
    ['installId', '3F2B8C1E-9D4A-4E7B-8A6F-0C1D2E3F4A5B0'],
    ['day', '2026-11-05T13:37:00.000Z'],
    ['day', '1762349820000'],
    ['day', 'yesterday'],
    ['day', '2026-10-99'],
    ['day', '2026-02-30'],
    ['day', '2026-13-01']
  ])('refuses text in a narrow field: %s = %s', (key, value) => {
    expect(readFunnelPayload({ ...good, [key]: value })).toBeNull()
  })

  it('refuses a value of the wrong kind', () => {
    for (const value of [null, undefined, 7, [], 'x', [good]]) expect(readFunnelPayload(value)).toBeNull()
    expect(readFunnelPayload({ ...good, appVersion: 4 })).toBeNull()
    expect(readFunnelPayload({ ...good, day: { y: 2026 } })).toBeNull()
  })

  it('takes a release candidate, which is all a version may say beyond its numbers', () => {
    expect(readFunnelPayload({ ...good, appVersion: '0.5.0-rc.2' })?.appVersion).toBe('0.5.0-rc.2')
    expect(readFunnelPayload({ ...good, appVersion: '0.5.0-beta.1' })?.appVersion).toBe('0.5.0-beta.1')
  })
})

describe('coarse on purpose', () => {
  it('a timestamp is a UTC day, nothing finer', () => {
    expect(dayOf(Date.UTC(2026, 10, 5, 23, 59, 59))).toBe('2026-11-05')
    expect(dayOf(Date.UTC(2026, 10, 6, 0, 0, 1))).toBe('2026-11-06')
  })

  it('an OS is a family, never a release or a hostname', () => {
    expect(osFamilyOf('darwin')).toBe('mac')
    expect(osFamilyOf('win32')).toBe('windows')
    expect(osFamilyOf('linux')).toBe('linux')
    expect(osFamilyOf('freebsd')).toBe('other')
  })
})

describe('what the row tells a person', () => {
  it('names every field that leaves and what never does', () => {
    for (const word of ['installed', 'first turn', 'phone paired', 'paid', 'version', 'OS', 'random ID', 'day']) {
      expect(TELEMETRY_ROW_NOTE).toContain(word)
    }
    for (const word of ['prompts', 'paths', 'names', 'output']) expect(TELEMETRY_ROW_NOTE).toContain(word)
  })
})
