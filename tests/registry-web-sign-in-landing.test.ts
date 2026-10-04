import { describe, expect, it } from 'vitest'
import { ASSETS } from '../registry/src/assets-bundle'

/**
 * WHERE A SIGN-IN LANDS ON THE WEB.
 *
 * A reader who pressed BUY on a team's page while signed out is sent to the
 * account sheet; line.js keeps the intent in sessionStorage and resumes it on
 * the next load of THAT page. Until this, every successful sign-in left for
 * /me — so the buyer landed on their account page and the purchase they had
 * started was never resumed. Both sign-in paths (the sheet in site.js and the
 * second-factor ladder in factors.js) now ask one rule: a team page reloads
 * itself, anywhere else goes to /me.
 */
describe('a sign-in on a team page reloads the page instead of leaving for /me', () => {
  const site = ASSETS['site.js'].body
  const factors = ASSETS['factors.js'].body

  it('site.js decides the landing once and publishes it for the ladder', () => {
    expect(site).toContain("if (document.getElementById('team')) location.reload()")
    expect(site).toContain('window.cookrewAfterSignIn = afterSignIn')
    // Neither sign-in path in the sheet jumps to /me on its own any more.
    expect(site.match(/dialog\.close\(\)\n\s+location\.assign\('\/me'\)/g)).toBeNull()
  })

  it('the ladder and the passkey path use the same rule, with /me as the fallback', () => {
    expect(factors.match(/window\.cookrewAfterSignIn \?\? \(\(\) => location\.assign\('\/me'\)\)/g)).toHaveLength(2)
  })
})

describe('the site enrols no handle', () => {
  it('site.js carries no v1 enrolment dialog, and stars act over the v2 session', () => {
    const site = ASSETS['site.js'].body
    expect(site).not.toContain('Enrol this browser')
    expect(site).not.toContain('signInFlow')
    expect(site).not.toContain('/v1/identity/register')
    expect(site).toContain("v2('POST', `/v1/doors/@${handle}/${name}/star`)")
  })
})
