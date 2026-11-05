import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { boardActions } from '../src/renderer/src/board-actions'
import { onCardMenuRequest, requestCardMenu } from '../src/renderer/src/card-menu-request'
import { TeamSaveBar } from '../src/renderer/src/TeamSaveBar'
import { WorkspaceCreateSheet } from '../src/renderer/src/WorkspaceCreateSheet'
import { WorkspaceEditSheet } from '../src/renderer/src/WorkspaceEditSheet'
import { WorkspaceRemoveSheet } from '../src/renderer/src/WorkspaceRemoveSheet'
import { WorkspaceWall } from '../src/renderer/src/WorkspaceWall'
import { planFor } from '../src/renderer/src/workspace-wall-actions'
import { announce, beginArrival, endArrival, heldForArrival, onAnnounce } from '../src/renderer/src/workspace-arrival'
import type { WorkspaceCheck, WorkspaceRemovePlan } from '../src/shared/workspace-door'
import { removeLines } from '../src/shared/workspace-door'

/** Box user test 2, the workspace door: what a new user can now see and reach. */

const passed: WorkspaceCheck = { ok: true, name: 'Beta', dir: '/p', notes: [], suggestedDir: '/home/me' }

const sheet = (over: Partial<React.ComponentProps<typeof WorkspaceCreateSheet>> = {}): string =>
  renderToStaticMarkup(
    <WorkspaceCreateSheet
      defaultDir="/home/me"
      teams={[]}
      canPickDir
      pickDir={async () => null}
      onCreate={() => undefined}
      onCancel={() => undefined}
      {...over}
    />
  )

describe('the create sheet', () => {
  it('gives the desktop a typed path beside the picker', () => {
    const html = sheet({ canPickDir: true })
    expect(html).toContain('aria-label="Folder path"')
    expect(html).toContain('value="/home/me"')
    expect(html).toContain('CHOOSE…')
  })

  it('gives the phone the typed path with no picker', () => {
    const html = sheet({ canPickDir: false })
    expect(html).toContain('aria-label="Folder path"')
    expect(html).not.toContain('CHOOSE…')
  })

  it('shows a refusal, and CREATE cannot be pressed', () => {
    const html = sheet({ initialName: 'Ghost', initialCheck: { ...passed, ok: false, reason: 'There is no folder at /nope. Choose one that exists.' } })
    expect(html).toContain('There is no folder at /nope. Choose one that exists.')
    expect(html).toMatch(/<button[^>]*cr-ws-create[^>]*disabled/)
  })

  it('says a taken name and a shared folder before creating, and CREATE still works', () => {
    const notes = ['"Alpha" is taken, so this one will be called "Alpha (2)".']
    const html = sheet({ initialName: 'Alpha', initialCheck: { ...passed, notes } })
    expect(html).toContain('&quot;Alpha&quot; is taken')
    expect(html).not.toMatch(/<button[^>]*cr-ws-create[^>]*disabled/)
  })

  it('says why CREATE waits on a name', () => {
    expect(sheet()).toContain('Give it a name to create it.')
  })
})

describe('the wall', () => {
  const faces = [
    { id: 'a', name: 'Alpha', icon: '🗂', dir: '/a' },
    { id: 'b', name: 'Beta', icon: '🗂', dir: '/b' }
  ]
  const wall = (over: Partial<React.ComponentProps<typeof WorkspaceWall>> = {}): string =>
    renderToStaticMarkup(
      <WorkspaceWall
        open
        workspaces={faces}
        activeId="a"
        recent={['a', 'b']}
        shots={{}}
        stage={null}
        onEnter={() => undefined}
        onClose={() => undefined}
        onCreate={() => undefined}
        onDirectories={() => undefined}
        onRemove={() => undefined}
        now={0}
        {...over}
      />
    )

  it('offers NEW from any screen, so a phone never steps past every workspace', () => {
    expect(wall()).toContain('NEW WORKSPACE…')
  })

  it('offers rename and remove on the picked workspace', () => {
    const html = wall()
    expect(html).toContain('RENAME…')
    expect(html).toContain('REMOVE…')
    expect(html).not.toContain('REMOVE? YES')
  })

  it('reads as a phone on a phone, whatever the pointer says', () => {
    expect(wall({ touch: true })).toContain('SWIPE TO LOOK')
    expect(wall({ touch: true })).not.toContain('ENTER')
  })

  it('says why REMOVE is off for the last workspace, on the screen', () => {
    expect(wall({ canRemove: false })).toContain('The last workspace stays.')
  })
})

describe('a sheet is about the workspace it was opened on', () => {
  const plan = (id: string): WorkspaceRemovePlan => ({ id, name: id, stops: [], notes: 0, browsers: 0, keeps: [], forks: [] })

  it('takes the plan it asked for, and not a late answer for another', () => {
    expect(planFor('b', plan('b'))?.id).toBe('b')
    expect(planFor('c', plan('b'))).toBeNull()
    expect(planFor(null, plan('b'))).toBeNull()
  })

  it('confirms against the plan on screen, never the pick behind it', () => {
    const wall = readFileSync('src/renderer/src/WorkspaceWall.tsx', 'utf8')
    expect(wall).toContain('onRemove(plan.id, options)')
    expect(wall).not.toContain('onRemove(picked.id')
    expect(wall).not.toContain('onEdit(picked.id')
  })
})

describe('the rename sheet', () => {
  it('offers the name and the icons', () => {
    const html = renderToStaticMarkup(
      <WorkspaceEditSheet name="Alpha" icon="🗂" onSave={async () => undefined} onCancel={() => undefined} />
    )
    expect(html).toContain('value="Alpha"')
    expect(html).toContain('aria-label="Icon 🚀"')
    expect(html).toContain('aria-pressed="true"')
  })
})

describe('the remove sheet', () => {
  const plan: WorkspaceRemovePlan = {
    id: 'w', name: 'Alpha', stops: ['Shell', 'Conductor'], notes: 2, browsers: 1, keeps: ['/p'], forks: []
  }
  const render = (over: Partial<WorkspaceRemovePlan> = {}): string =>
    renderToStaticMarkup(
      <WorkspaceRemoveSheet plan={{ ...plan, ...over }} onConfirm={async () => undefined} onCancel={() => undefined} />
    )

  it('names what stops, what goes and what stays', () => {
    const html = render()
    expect(html).toContain('Remove &quot;Alpha&quot;?')
    expect(html).toContain('Stops 2 agents: Shell and Conductor.')
    expect(html).toContain('Deletes 2 notes and 1 browser.')
    expect(html).toContain('Leaves /p on disk.')
  })

  it('offers a clean fork\'s worktree and branch, unticked', () => {
    const html = render({ keeps: ['/wt'], forks: [{ worktree: '/wt', branch: 'cookrew/a', removable: true }] })
    expect(html).toContain('Also remove the worktree and branch')
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/)
  })

  it('says why a fork that is not clean stays, and offers nothing', () => {
    const reason = 'The worktree has uncommitted changes, so it stays.'
    const html = render({ keeps: ['/wt'], forks: [{ worktree: '/wt', branch: 'cookrew/a', removable: false, reason }] })
    expect(html).toContain(reason)
    expect(html).not.toContain('Also remove')
  })

  it('waits for the plan rather than asking blind', () => {
    const html = renderToStaticMarkup(
      <WorkspaceRemoveSheet plan={null} onConfirm={async () => undefined} onCancel={() => undefined} />
    )
    expect(html).toMatch(/<button[^>]*danger[^>]*disabled/)
  })
})

describe('removeLines', () => {
  it('has nothing to stop in an empty workspace', () => {
    expect(removeLines({ id: 'w', name: 'A', stops: [], notes: 0, browsers: 0, keeps: ['/p'], forks: [] })).toEqual([
      'No agents to stop.',
      'Leaves /p on disk.'
    ])
  })
})

describe('board search finds what the app can do', () => {
  it('finds New workspace', () => {
    for (const query of ['new workspace', 'new', 'workspace', 'create workspace', 'NEW WORK']) {
      expect(boardActions(query).map((a) => a.id)).toContain('new-workspace')
    }
  })

  it('finds Rename this workspace', () => {
    expect(boardActions('rename').map((a) => a.id)).toEqual(['rename-workspace'])
  })

  it('stays out of the way of an agent\'s name', () => {
    expect(boardActions('')).toEqual([])
    expect(boardActions('scout')).toEqual([])
  })
})

describe('one calm message after creating', () => {
  const event = (type: string) => ({ type, workspaceId: 'w', workspaceName: 'Alpha', entityName: 'Conductor' })

  beforeEach(() => endArrival())

  it('holds the burst a create sets off, and nothing after it', () => {
    beginArrival(1000)
    expect(heldForArrival(event('workspace.created'), 1100)).toBe(true)
    expect(heldForArrival(event('workspace.switched'), 1200)).toBe(true)
    expect(heldForArrival(event('terminal.created'), 1300)).toBe(true)
    expect(heldForArrival(event('terminal.created'), 9000)).toBe(false)
  })

  it('never holds an event about something else', () => {
    beginArrival(1000)
    expect(heldForArrival(event('note.created'), 1100)).toBe(false)
  })

  it('holds nothing when nobody on this device is creating', () => {
    expect(heldForArrival(event('workspace.created'), 1100)).toBe(false)
  })

  it('stops holding the moment the create is refused', () => {
    beginArrival(1000)
    endArrival()
    expect(heldForArrival(event('workspace.created'), 1100)).toBe(false)
  })

  it('reaches the toast layer', () => {
    const heard = vi.fn()
    const off = onAnnounce(heard)
    announce({ title: 'Alpha is ready', detail: 'Press ＋' })
    off()
    expect(heard).toHaveBeenCalledWith({ title: 'Alpha is ready', detail: 'Press ＋' })
  })
})

describe('team save on screen', () => {
  it('asks for a name and cannot save without one', () => {
    const html = renderToStaticMarkup(<TeamSaveBar onSave={async () => undefined} onCancel={() => undefined} />)
    expect(html).toContain('Team name')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>SAVE TEAM/)
  })
})

describe('the card menu', () => {
  it('is asked for by anything that holds a card', () => {
    const heard = vi.fn()
    const off = onCardMenuRequest(heard)
    requestCardMenu('t1', 10, 20)
    off()
    requestCardMenu('t2', 0, 0)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(heard).toHaveBeenCalledWith({ nodeId: 't1', x: 10, y: 20 })
  })

  it('is drawn by the app, and the retired canvas\'s SelectionBar is not imported', () => {
    const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(app).toContain('<CardMenu')
    expect(app).not.toContain("from './SelectionBar'")
  })
})
