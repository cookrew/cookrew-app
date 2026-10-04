import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkspaceCreateSheet } from '../src/renderer/src/WorkspaceCreateSheet'
import type { TeamMeta } from '../src/shared/model'

/**
 * THE NEW-WORKSPACE SHEET — what used to be the header dropdown's inline form,
 * now the wall's. A name, a directory (native picker where there is one, a
 * typed path where there is not), and the saved teams as templates.
 */

const TEAMS: TeamMeta[] = [
  { name: 'goat team', savedAt: Date.UTC(2026, 8, 20), nodeCount: 5, terminalCount: 3 },
  { name: 'solo', savedAt: Date.UTC(2026, 8, 21), nodeCount: 1, terminalCount: 1 },
]

const sheet = (over: Partial<React.ComponentProps<typeof WorkspaceCreateSheet>> = {}): string =>
  renderToStaticMarkup(
    <WorkspaceCreateSheet
      defaultDir="/Users/me/work"
      teams={TEAMS}
      canPickDir
      pickDir={async () => null}
      onCreate={() => undefined}
      onCancel={() => undefined}
      {...over}
    />
  )

describe('the sheet', () => {
  it('asks for a name and shows where the workspace will live', () => {
    const html = sheet()
    expect(html).toContain('placeholder="workspace name"')
    expect(html).toContain('/Users/me/work')
  })

  it('offers the native picker on the desktop and a typed path elsewhere', () => {
    expect(sheet({ canPickDir: true })).toContain('cr-ws-dir-picker')
    const phone = sheet({ canPickDir: false })
    expect(phone).not.toContain('cr-ws-dir-picker')
    expect(phone).toContain('placeholder="working directory"')
  })

  it('lists every saved team as a template, after the empty option', () => {
    const html = sheet()
    expect(html).toContain('FROM TEMPLATE')
    expect(html).toContain('Empty workspace')
    expect(html.indexOf('Empty workspace')).toBeLessThan(html.indexOf('goat team'))
    expect(html).toContain('solo')
  })

  it('hides the template section when nothing has been saved', () => {
    expect(sheet({ teams: [] })).not.toContain('FROM TEMPLATE')
  })

  it('has a CREATE button and a way out', () => {
    const html = sheet()
    expect(html).toContain('CREATE')
    expect(html).toContain('CANCEL')
  })
})
