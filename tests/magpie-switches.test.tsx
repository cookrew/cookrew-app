// THE TWO MAGPIE SWITCHES, PAINTED, and the account guide following them.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MagpieSwitchesView } from '../src/renderer/src/routing/MagpieSwitches'
import { AccountWays } from '../src/renderer/src/first-run/AccountWays'
import { routeFixture } from '../src/shared/route-fixture'

const view = (over: Partial<React.ComponentProps<typeof MagpieSwitchesView>> = {}): string =>
  renderToStaticMarkup(<MagpieSwitchesView values={{ magpie: true, magpieRemote: false }} pinned={[]} installed busy={false} problem={null} onSet={() => {}} onConfigure={() => {}} {...over} />)

const checked = (html: string, name: string): boolean => new RegExp(`name="${name}"[^>]*checked`).test(html)
const disabled = (html: string, name: string): boolean => new RegExp(`name="${name}"[^>]*disabled`).test(html)

describe('MagpieSwitchesView', () => {
  it('draws both switches as they are, with the way into Magpie’s own settings', () => {
    const html = view()
    expect(html).toContain('Use Magpie')
    expect(html).toContain('Use another computer’s Magpie (Magpie remote)')
    expect(checked(html, 'magpie')).toBe(true)
    expect(checked(html, 'magpieRemote')).toBe(false)
    expect(html).toContain('Open Magpie settings')
    expect(html).toContain('Applies at once')
  })

  it('holds Magpie remote off and shut while Magpie itself is off, and hides the settings button', () => {
    const html = view({ values: { magpie: false, magpieRemote: true } })
    expect(checked(html, 'magpieRemote')).toBe(false)
    expect(disabled(html, 'magpieRemote')).toBe(true)
    expect(html).toContain('Turn on Magpie first.')
    expect(html).not.toContain('Open Magpie settings')
  })

  it('names the variable that pinned a switch, and does not offer to change it', () => {
    const html = view({ pinned: ['magpie'] })
    expect(disabled(html, 'magpie')).toBe(true)
    expect(html).toContain('Set by COOKREW_MAGPIE when Cookrew started.')
  })

  it('says when Magpie is not installed rather than offering a page that cannot open', () => {
    const html = view({ installed: false })
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Open Magpie settings/)
    expect(html).toContain('Magpie is not installed yet.')
  })
})

describe('the account guide follows the switches', () => {
  const paint = (magpie: boolean, magpieRemote: boolean): string =>
    renderToStaticMarkup(<AccountWays route={routeFixture('online', { defaultModel: null, harnesses: [] })} endpointActive={false} onRun={() => {}} running={null} switches={{ magpie, magpieRemote }} showSwitches={false} />)

  it('offers keys and another computer only with Magpie, and the remote only with its switch', () => {
    expect(paint(true, true)).toContain('Another computer’s Magpie')
    expect(paint(true, false)).not.toContain('Another computer’s Magpie')
    expect(paint(true, false)).toContain('API key')
    expect(paint(false, true)).not.toContain('API key')
    expect(paint(false, true)).not.toContain('Another computer’s Magpie')
  })
})

describe('where the switches are drawn', () => {
  const read = (rel: string): string => readFileSync(path.join(__dirname, '../src', rel), 'utf8')
  it('in Launch settings and in the first-run guide', () => {
    expect(read('renderer/src/LaunchSettingsSheet.tsx')).toContain('<MagpieSwitches installed variant="sheet" />')
    expect(read('renderer/src/first-run/AccountWays.tsx')).toContain('<MagpieSwitches installed={installed} />')
    expect(read('renderer/src/first-run/Preflight.tsx')).toContain('<AccountWays')
  })
})

describe('in Launch settings', () => {
  it('wears the sheet’s own rows and buttons', () => {
    const html = view({ variant: 'sheet' })
    expect(html).toContain('class="ls-switch"')
    expect(html).toContain('class="gs-ghost"')
    expect(html).not.toContain('fr-check')
  })
})
