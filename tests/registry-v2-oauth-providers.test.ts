import { describe, expect, it } from 'vitest'
import { createProviders, readOAuthEnv, verifiedGithubEmail } from '../registry/src/v2-oauth-providers'
import { suggestHandle } from '../src/shared/oauth'

describe('reading the configuration', () => {
  const full = {
    GITHUB_OAUTH_CLIENT_ID: 'id',
    GITHUB_OAUTH_CLIENT_SECRET: 'shh',
    GOOGLE_OAUTH_CLIENT_ID: 'gid',
    GOOGLE_OAUTH_CLIENT_SECRET: 'gshh'
  }

  it('turns on exactly the provider whose pair is present', () => {
    expect(readOAuthEnv({})).toEqual({})
    expect(Object.keys(readOAuthEnv(full))).toEqual(['github', 'google'])
    expect(Object.keys(readOAuthEnv({ GOOGLE_OAUTH_CLIENT_ID: 'g', GOOGLE_OAUTH_CLIENT_SECRET: 's' }))).toEqual(['google'])
  })

  it('half a pair is off, and the boot line names the variable and never the value', () => {
    const said: string[] = []
    const config = readOAuthEnv({ GITHUB_OAUTH_CLIENT_ID: 'id', GITHUB_OAUTH_CLIENT_SECRET: ' ' }, (m) => said.push(m))
    expect(config).toEqual({})
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('GITHUB_OAUTH_CLIENT_SECRET')
    const quiet: string[] = []
    readOAuthEnv({ GITHUB_OAUTH_CLIENT_SECRET: 'a-real-secret-value' }, (m) => quiet.push(m))
    expect(quiet.join(' ')).not.toContain('a-real-secret-value')
  })

  it('with no configuration there are no providers', () => {
    expect(createProviders().size).toBe(0)
  })

  it('refuses an endpoint override that is not on loopback', () => {
    expect(() =>
      createProviders({ github: { clientId: 'a', clientSecret: 'b', endpoints: { token: 'https://evil.example/token' } } })
    ).toThrow(/loopback/)
  })

  it('asks GitHub for identity and email and never repo; Google for openid email', () => {
    const providers = createProviders({
      github: { clientId: 'a', clientSecret: 'b' },
      google: { clientId: 'c', clientSecret: 'd' }
    })
    const input = { state: 's', challenge: 'c', nonce: 'n', redirectUri: 'https://cookrew.dev/v2/oauth/github/callback' }
    const github = new URL(providers.get('github')?.authorizeUrl(input) ?? '')
    expect(github.origin).toBe('https://github.com')
    expect(github.searchParams.get('scope')).toBe('read:user user:email')
    expect(github.searchParams.get('scope')).not.toContain('repo')
    const google = new URL(providers.get('google')?.authorizeUrl(input) ?? '')
    expect(google.origin).toBe('https://accounts.google.com')
    expect(google.searchParams.get('scope')).toBe('openid email')
    expect(providers.get('google')?.deviceStart).toBeUndefined()
  })
})

describe('the verified address', () => {
  it('prefers the primary, skips unverified and noreply', () => {
    expect(
      verifiedGithubEmail([
        { email: 'a@x.dev', primary: false, verified: true },
        { email: 'b@x.dev', primary: true, verified: true }
      ])
    ).toBe('b@x.dev')
    expect(verifiedGithubEmail([{ email: 'a@x.dev', primary: true, verified: false }])).toBeNull()
    expect(verifiedGithubEmail([{ email: '1+me@users.noreply.github.com', primary: true, verified: true }])).toBeNull()
    expect(verifiedGithubEmail({ message: 'scope not granted' })).toBeNull()
  })
})

describe('a provider name as a prefill', () => {
  it('fits the handle shape, or starts blank', () => {
    expect(suggestHandle('Octo-Cat', null)).toBe('octo-cat')
    expect(suggestHandle('a_b.c', null)).toBe('a-b-c')
    expect(suggestHandle(null, 'ada.l@example.com')).toBe('ada-l')
    expect(suggestHandle(null, null)).toBe('')
    expect(suggestHandle('acct-root', null)).toBe('')
    expect(suggestHandle('x'.repeat(50), null)).toHaveLength(32)
    expect(suggestHandle('---', null)).toBe('')
  })
})
