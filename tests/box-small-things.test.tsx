// BOX ROUND 3, BUG 9: the smaller things, each read off a real screen or disk.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkWorkspaceCreate } from '../src/main/workspace-door'
import { Requests } from '../src/main/requests'
import { removeFork } from '../src/main/workspace-fork-check'
import { boardActions, saysNothingMatches } from '../src/renderer/src/board-actions'
import { WorkspaceCreateSheet } from '../src/renderer/src/WorkspaceCreateSheet'

describe('the search box', () => {
  it('finds both workspace actions in the words of their own labels', () => {
    for (const query of ['new workspace', 'New Workspace', 'create a workspace', 'add workspace']) {
      expect(boardActions(query).map((a) => a.id)).toContain('new-workspace')
    }
    for (const query of ['rename workspace', 'rename this workspace', 'rename']) {
      expect(boardActions(query).map((a) => a.id)).toEqual(['rename-workspace'])
    }
  })

  it('says nothing matches only when nothing does: a row above it is a match', () => {
    expect(saysNothingMatches({ hits: 0, actions: 0 })).toBe(true)
    expect(saysNothingMatches({ hits: 0, actions: 1 })).toBe(false)
    expect(saysNothingMatches({ hits: 2, actions: 0 })).toBe(false)
  })

  it('stacks an action row above the panel: beside it, it floated over the page, see-through', () => {
    const css = readFileSync('src/renderer/src/header.css', 'utf8')
    const pop = /\.cr-board-pop \{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(pop).toMatch(/flex-direction: column/)
    const roster = readFileSync('src/renderer/src/agent-roster.css', 'utf8')
    expect(/\.cr-board-actions \{[^}]*\}/.exec(roster)?.[0]).toMatch(/background: var\(--cream-hi\)/)
  })

  it('the panel under the box is told what the box found', () => {
    expect(readFileSync('src/renderer/src/BoardSearch.tsx', 'utf8')).toMatch(/actionCount=\{actions\.length\}/)
    expect(readFileSync('src/renderer/src/RosterPanel.tsx', 'utf8')).toMatch(/saysNothingMatches\(\{ hits: results\.length \+ itemHits\.length, actions: actionCount \}\)/)
  })
})

describe('the new workspace sheet', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cookrew-sheet-'))
  const mine = [{ id: 'a', name: 'My Workspace', dir: home, dirs: [home], icon: '🗂' }]
  const check = (name: string, dir: string, workspaces = mine) => checkWorkspaceCreate({ name, dir, workspaces, liveDir: home, home })

  it('does not open on a folder another workspace already works in', () => {
    expect(check('', '').suggestedDir).toBe('')
  })

  it('still opens on a free one', () => {
    expect(check('', '', []).suggestedDir).toBe(home)
  })

  it('a workspace with no folder given still lands somewhere, and says where and with whom', () => {
    const verdict = check('Beta', '')
    expect(verdict).toMatchObject({ ok: true, dir: home })
    expect(verdict.notes.join(' ')).toContain('"My Workspace" already works in this folder')
  })

  const sheet = (over: Partial<React.ComponentProps<typeof WorkspaceCreateSheet>>): string =>
    renderToStaticMarkup(
      <WorkspaceCreateSheet defaultDir="" teams={[]} canPickDir pickDir={async () => null} onCreate={() => undefined} onCancel={() => undefined} {...over} />
    )
  const shared = { ok: true, name: 'Workspace', dir: home, notes: ['"My Workspace" already works in this folder, so their agents will share its files.'], suggestedDir: '' }

  it('warns of nothing on opening', () => {
    expect(sheet({ initialCheck: shared })).not.toContain('already works in this folder')
  })

  it('warns before CREATE can be pressed: a name is what makes it pressable', () => {
    const html = sheet({ initialName: 'Beta', initialCheck: shared })
    expect(html).toContain('already works in this folder')
    expect(html).not.toMatch(/<button[^>]*cr-ws-create[^>]*disabled/)
  })
})

describe('removing a forked workspace', () => {
  const sh = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  let root = ''
  let repo = ''
  let worktreeRoot = ''

  const fork = (slug: string, name: string): string => {
    const worktree = path.join(worktreeRoot, slug, name)
    mkdirSync(path.dirname(worktree), { recursive: true })
    sh(repo, 'worktree', 'add', '-q', '-b', `cookrew/${slug}-${name}`, worktree)
    return worktree
  }
  const remove = (worktree: string, branch: string) =>
    removeFork({ worktree, branch, removable: true }, { worktreeRoot, otherDirs: [] })

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cookrew-fork-prune-')))
    repo = path.join(root, 'proj-a')
    worktreeRoot = path.join(root, 'worktrees')
    mkdirSync(repo)
    sh(repo, 'init', '-q', '-b', 'main')
    sh(repo, 'config', 'user.email', 'test@example.invalid')
    sh(repo, 'config', 'user.name', 'Test')
    sh(repo, 'config', 'commit.gpgsign', 'false')
    writeFileSync(path.join(repo, 'a.txt'), 'a')
    sh(repo, 'add', '.')
    sh(repo, 'commit', '-qm', 'first')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('leaves no empty folder under the worktree root', async () => {
    const worktree = fork('alpha-1234', 'proj-a')
    expect(await remove(worktree, 'cookrew/alpha-1234-proj-a')).toEqual({ ok: true })
    expect(existsSync(path.join(worktreeRoot, 'alpha-1234'))).toBe(false)
  })

  it('keeps the worktree root itself', async () => {
    const worktree = fork('alpha-1234', 'proj-a')
    await remove(worktree, 'cookrew/alpha-1234-proj-a')
    expect(existsSync(worktreeRoot)).toBe(true)
  })

  it('keeps a folder that still holds another repository’s worktree', async () => {
    const first = fork('team-1', 'one')
    const second = fork('team-1', 'two')
    await remove(first, 'cookrew/team-1-one')
    expect(existsSync(second)).toBe(true)
  })

  it('keeps a folder holding anything else at all', async () => {
    const worktree = fork('alpha-1234', 'proj-a')
    writeFileSync(path.join(worktreeRoot, 'alpha-1234', 'notes.txt'), 'mine')
    expect(await remove(worktree, 'cookrew/alpha-1234-proj-a')).toEqual({ ok: true })
    expect(existsSync(path.join(worktreeRoot, 'alpha-1234', 'notes.txt'))).toBe(true)
  })
})

describe('the avatar’s count and the notification', () => {
  it('a notification that cannot be shown costs the badge nothing', async () => {
    const onChange = vi.fn()
    const row = { id: 'reach-1', kind: 'reach', device: 'Pixel', address: 'Pixel', at: 1, expiresAt: 9e12, state: 'pending' }
    const requests = new Requests({
      accounts: {
        account: () => ({ username: 'mira' }),
        sessionLive: () => true,
        call: async (route: string) => ({ ok: true, value: route === '/v2/me/requests' ? [row] : { events: [], cursor: 0 } })
      } as never,
      notify: () => {
        throw new Error('no notification server on this box')
      },
      onChange
    })
    await requests.refresh()
    expect(requests.count).toBe(1)
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
