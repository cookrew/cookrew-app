import { describe, expect, it } from 'vitest'
import { servedSpawn, type ServedSpawnContext } from '../src/main/session-spawn'

/**
 * ENV-AT-SPAWN composes the two confinements slice 1 proved separately. These
 * pin that a served spawn gets BOTH — the Seatbelt wrap and the scrubbed env —
 * because either alone is a door beside an open window.
 */

const ctx = (over: Partial<ServedSpawnContext> = {}): ServedSpawnContext => ({
  base: '/base',
  serviceId: 'svc',
  sessionId: 'svc-ana-1',
  sandbox: '/base/sessions/svc/svc-ana-1',
  ownerEnv: { ANTHROPIC_API_KEY: 'sk-secret', LENT: 'yes', PATH: '/usr/bin' },
  grantedKeys: ['LENT'],
  ...over
})

/** Capture the profile write instead of touching disk. */
const capture = (): { writes: { path: string; profile: string }[]; write: (p: string, c: string) => void } => {
  const writes: { path: string; profile: string }[] = []
  return { writes, write: (path, profile) => writes.push({ path, profile }) }
}

describe('servedSpawn — the command is wrapped under Seatbelt', () => {
  it('runs the original command through sandbox-exec with the written profile', () => {
    const cap = capture()
    const out = servedSpawn({ file: 'claude', args: ['--resume', 'x'] }, ctx(), cap.write)
    expect(out.file).toBe('/usr/bin/sandbox-exec')
    expect(out.args).toEqual(['-f', out.profilePath, 'claude', '--resume', 'x'])
    // The profile it points at is the one that was written.
    expect(cap.writes).toHaveLength(1)
    expect(cap.writes[0].path).toBe(out.profilePath)
  })

  it('writes the profile inside the sandbox, so END removes it', () => {
    const cap = capture()
    const out = servedSpawn({ file: 'sh', args: [] }, ctx(), cap.write)
    expect(out.profilePath.startsWith('/base/sessions/svc/svc-ana-1/')).toBe(true)
  })

  it('the profile confines writes to this sandbox and denies EVERY other session', () => {
    const cap = capture()
    servedSpawn({ file: 'sh', args: [] }, ctx(), cap.write)
    const profile = cap.writes[0].profile
    expect(profile).toContain('file-write* (subpath "/base/sessions/svc/svc-ana-1")')
    // The deny covers the whole sessions root, not just this service's
    // siblings: a probe against the earlier per-service deny read ANOTHER
    // service's sandbox straight out.
    expect(profile).toContain('deny file-read* (subpath "/base/sessions")')
    // …and Seatbelt takes the LAST matching rule, so this session's own
    // subtree — which lives inside the denied root — is re-allowed after it.
    const denyAt = profile.indexOf('deny file-read* (subpath "/base/sessions")')
    const allowOwnAt = profile.indexOf('allow file-read* (subpath "/base/sessions/svc/svc-ana-1")')
    expect(allowOwnAt).toBeGreaterThan(denyAt)
  })

  it('denies the owner credential stores a served agent was never lent', () => {
    const cap = capture()
    servedSpawn({ file: 'sh', args: [] }, ctx(), cap.write)
    const profile = cap.writes[0].profile
    // file-read* is allowed across the disk on purpose, so without these an
    // agent could read the owner's OAuth refresh token unlent. The paths are
    // the real owner's (owner-secrets.ts reads homedir), so match the tails.
    for (const secret of ['.credentials.json', '.ssh', '.aws']) {
      expect(profile).toMatch(
        new RegExp(`deny file-read\\* \\(subpath "[^"]*${secret.replace('.', '\\.')}"`)
      )
    }
    // The main process may hold this key, but a served crew may never read the
    // source file even when it knows the binding path by name.
    expect(profile).toContain('deny file-read* (subpath "/base/stripe.env")')
    // Public but still owner configuration: the fixture explicitly keeps the
    // payment destination inside the same denied ~/.cookrew boundary.
    expect(profile).toContain('deny file-read* (subpath "/base/payment.json")')
  })
})

describe('servedSpawn — the env is scrubbed', () => {
  it('makes the sandbox HOME and marks the process served', () => {
    const out = servedSpawn({ file: 'sh', args: [] }, ctx(), () => undefined)
    expect(out.env.HOME).toBe('/base/sessions/svc/svc-ana-1')
    expect(out.env.COOKREW_SERVED).toBe('1')
    expect(out.env.COOKREW_SESSION).toBe('svc-ana-1')
    expect(out.env.PI_CODING_AGENT_DIR).toBe(
      '/base/sessions/svc/svc-ana-1/.pi/agent'
    )
  })

  it("carries only the lent key, never the owner's secret", () => {
    const out = servedSpawn({ file: 'sh', args: [] }, ctx(), () => undefined)
    expect(out.env.LENT).toBe('yes')
    expect(out.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('refuses a granted name that would override the scrub (HOME/PATH/TMPDIR)', () => {
    // The grant loop runs after HOME is set, so a granted HOME would point at
    // the owner's real home — reopening ~/.ssh, ~/.aws, ~/.cookrew. grantable()
    // must filter it out here, not rely on an upstream check.
    const out = servedSpawn(
      { file: 'sh', args: [] },
      ctx({ ownerEnv: { HOME: '/Users/owner', LENT: 'yes' }, grantedKeys: ['HOME', 'LENT'] }),
      () => undefined
    )
    expect(out.env.HOME).toBe('/base/sessions/svc/svc-ana-1') // sandbox, not owner home
    expect(out.env.LENT).toBe('yes') // a legitimate grant still lands
  })

  it('a session with no granted keys gets no owner credentials at all', () => {
    const out = servedSpawn({ file: 'sh', args: [] }, ctx({ grantedKeys: [] }), () => undefined)
    expect(out.env.LENT).toBeUndefined()
    expect(out.env.ANTHROPIC_API_KEY).toBeUndefined()
    // A served session cannot run against the owner's tokens unless lent one —
    // the property that makes the per-session budget load-bearing.
    expect(out.env.HOME).toBe('/base/sessions/svc/svc-ana-1')
  })
})
