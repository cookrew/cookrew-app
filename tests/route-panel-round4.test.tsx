// ROUND 4 OF THE PANEL LANE — what the verification of round 3 asked for.
//
// A shaped RouteState cannot hand the vendor CLI an option (a plugin path
// starts with / or ~, a brew formula with a letter or digit); the one POSIX
// escape main emits for an apostrophe in a path is admitted exactly; the
// run decision refuses after a workspace switch; the RTE dial's input is
// main's choices alone; the Add menu's group item is disabled with its
// sentence when main sent no line.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { setupLines } from '../src/main/route/setup'
import { setupLineAllowed } from '../src/shared/route-lines'
import { LINE_UNEXPECTED, WORKSPACE_CHANGED, runLine } from '../src/renderer/src/routing/use-setup-terminal'
import { AddMenu } from '../src/renderer/src/routing/RoutingSections'
import { ROUTING_COPY, routeDialInput } from '../src/shared/route-view'
import { cardRouteFixture, routeFixture } from '../src/shared/route-fixture'

describe('no option reaches the vendor CLI', () => {
  it('requires a plugin path to start with / or ~', () => {
    for (const line of ['magpie plugin add -rf', "magpie plugin add '-rf'", 'magpie plugin add --help', 'magpie plugin add etc/x', "magpie plugin add 'x/y'"]) {
      expect(setupLineAllowed(line), line).toBe(false)
    }
    for (const line of ['magpie plugin add /opt/magpie', 'magpie plugin add ~/magpie', "magpie plugin add '/Applications/Cookrew Dev.app/Contents/Resources/magpie'", "magpie plugin add '~/x y'"]) {
      expect(setupLineAllowed(line), line).toBe(true)
    }
  })

  it('requires a brew formula to start with a letter or digit', () => {
    for (const line of ['brew install --cask x', 'brew install -f', 'brew install --', 'brew install .hidden', 'brew install /x']) {
      expect(setupLineAllowed(line), line).toBe(false)
    }
    for (const line of ['brew install sst/tap/opencode', 'brew install 7zip', 'brew install node@22']) {
      expect(setupLineAllowed(line), line).toBe(true)
    }
  })

  it('admits the exact POSIX escape main emits for an apostrophe in the plugin path, and nothing looser', () => {
    const line = setupLines("/Users/d'arcy/app").pluginLine
    expect(line).toBe("magpie plugin add '/Users/d'\\''arcy/app'")
    expect(setupLineAllowed(line)).toBe(true)
    expect(setupLineAllowed(setupLines("/Users/d'arcy/o'brien app").pluginLine)).toBe(true)
    // A bare apostrophe, an unclosed quote, text after the closing quote, or an escape smuggling a dash in first: refused.
    for (const bad of ["magpie plugin add '/Users/d'arcy/app'", "magpie plugin add '/Users/d'\\''arcy/app", "magpie plugin add '/a'\\''b'; id", "magpie plugin add '/a'\\''b' x", "magpie plugin add ''\\''-rf'"]) {
      expect(setupLineAllowed(bad), bad).toBe(false)
    }
  })
})

describe('the run decision', () => {
  it('refuses a line of no known shape before touching the card', async () => {
    let ensured = 0
    const out = await runLine({ line: 'rm -rf ~', enter: true, currentKey: () => 'a', ensure: async () => (ensured += 1, 't1'), type: () => undefined })
    expect(out).toEqual({ ok: false, reason: LINE_UNEXPECTED })
    expect(ensured).toBe(0)
  })

  it('refuses after a workspace switch during ensure, typing nothing', async () => {
    let key = 'Cookrew Dev | /a'
    const typed: string[] = []
    const out = await runLine({
      line: 'magpie serve',
      enter: true,
      currentKey: () => key,
      ensure: async () => {
        key = 'Lab | /b' // the owner switched while the card was being made
        return 't-old'
      },
      type: (_id, bytes) => void typed.push(bytes)
    })
    expect(out).toEqual({ ok: false, reason: WORKSPACE_CHANGED })
    expect(typed).toEqual([])
  })

  it('reports a card that never appeared as the sentence, and types the bytes otherwise', async () => {
    const failed = await runLine({ line: 'magpie serve', enter: true, currentKey: () => 'a', ensure: async () => { throw new Error('the Setup card did not appear on the canvas') }, type: () => undefined })
    expect(failed).toEqual({ ok: false, reason: 'the Setup card did not appear on the canvas' })
    const typed: [string, string][] = []
    const ok = await runLine({ line: 'magpie provider add deepseek ', enter: false, currentKey: () => 'a', ensure: async () => 't1', type: (id, bytes) => void typed.push([id, bytes]) })
    expect(ok).toEqual({ ok: true })
    expect(typed).toEqual([['t1', 'magpie provider add deepseek ']])
  })
})

describe('the Add menu, open', () => {
  const paint = (addGroupLine: string | null): string =>
    renderToStaticMarkup(<AddMenu setup={{ ...routeFixture('online').setup, addGroupLine }} onRun={() => {}} defaultOpen />)

  it('disables the routing-group item with its sentence when main sent no line', () => {
    const html = paint(null)
    expect(html).toContain(ROUTING_COPY.groupNeedsTwo)
    const item = html.slice(html.indexOf('Routing group') - 200, html.indexOf('Routing group'))
    expect(item).toContain('disabled=""')
  })

  it('offers the line when main sent one', () => {
    const html = paint('magpie group add smart models=claude/claude-opus-5-5,deepseek/deepseek-v4 routing=smart')
    expect(html).toContain('magpie group add smart models=')
    const item = html.slice(html.indexOf('Routing group') - 200, html.indexOf('Routing group'))
    expect(item).not.toContain('disabled=""')
  })
})

describe('what the RTE dial is given', () => {
  it('is nothing for a card that may not have one', () => {
    expect(routeDialInput({ allowed: false, routeChoices: ['direct'], state: cardRouteFixture() })).toBeNull()
    expect(routeDialInput({ allowed: true, routeChoices: null, state: null })).toBeNull()
  })

  it('is main’s choices, copied, when main listed them', () => {
    const choices = ['direct', 'group/smart']
    const dial = routeDialInput({ allowed: true, routeChoices: choices, state: cardRouteFixture() })
    expect(dial).toEqual({ choices: ['direct', 'group/smart'], notRoutable: null })
    expect(dial!.choices).not.toBe(choices)
  })

  it('is no list and main’s note — or "no routable models" — when main listed none', () => {
    expect(routeDialInput({ allowed: true, routeChoices: null, state: cardRouteFixture({ note: 'direct · pi is not routable yet' }) })).toEqual({ choices: [], notRoutable: 'direct · pi is not routable yet' })
    expect(routeDialInput({ allowed: true, routeChoices: null, state: cardRouteFixture({ note: null }) })).toEqual({ choices: [], notRoutable: ROUTING_COPY.noRoutable })
  })
})
