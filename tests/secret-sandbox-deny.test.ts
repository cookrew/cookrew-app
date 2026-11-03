// A SERVED SANDBOX CANNOT READ THE SECRET FILES — the refusal in the CLI is
// matched by a refusal in the Seatbelt profile, or it is theatre.
import { describe, expect, it } from 'vitest'
import { ownerSecretPaths } from '../src/main/owner-secrets'
import { seatbeltProfile } from '../src/main/session-sandbox'

describe('the served sandbox and the secrets', () => {
  it('ownerSecretPaths names the secrets dir and the pairing token', () => {
    const paths = ownerSecretPaths('/home/owner/.cookrew', '/home/owner')
    expect(paths).toContain('/home/owner/.cookrew/secrets')
    expect(paths).toContain('/home/owner/.cookrew/pairing-token')
    // The ones that were already there are still there.
    expect(paths).toContain('/home/owner/.cookrew/stripe.env')
    expect(paths).toContain('/home/owner/.cookrew/payment.json')
  })

  it('the profile denies reads under the secrets dir and of the pairing token, after the broad allow', () => {
    const profile = seatbeltProfile({
      sandbox: '/s/svc/ana-1',
      siblingRoot: '/s/svc',
      sessionsRoot: '/s',
      secretPaths: ownerSecretPaths('/home/owner/.cookrew', '/home/owner')
    })
    const deny = '(deny file-read* (subpath "/home/owner/.cookrew/secrets") (literal "/home/owner/.cookrew/secrets"))'
    expect(profile).toContain(deny)
    expect(profile).toContain('(deny file-read* (subpath "/home/owner/.cookrew/pairing-token")')
    // Seatbelt takes the LAST matching rule: the deny must follow the allow.
    expect(profile.indexOf(deny)).toBeGreaterThan(profile.indexOf('(allow file-read*)'))
  })
})
