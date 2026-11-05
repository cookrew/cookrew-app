import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkWorkspaceCreate, suggestWorkspaceDir } from '../src/main/workspace-door'

/**
 * WHAT A NEW WORKSPACE IS TOLD BEFORE IT EXISTS (box user test 2, bugs 5 and 15).
 * One check behind the sheet, the phone, the CLI and the API, so no route can
 * make a workspace on a folder that is not there.
 */

const root = mkdtempSync(path.join(tmpdir(), 'cookrew-door-'))
const folder = path.join(root, 'proj-a')
const file = path.join(root, 'notafolder.txt')
mkdirSync(folder)
writeFileSync(file, 'x')

const workspaces = [{ id: 'a', name: 'Alpha', dir: folder, dirs: [folder], icon: '🗂' }]
const check = (name: string, dir: string, over: Partial<Parameters<typeof checkWorkspaceCreate>[0]> = {}) =>
  checkWorkspaceCreate({ name, dir, workspaces: [], liveDir: root, home: root, ...over })

describe('checkWorkspaceCreate', () => {
  it('passes a real folder and a free name, with nothing to say', () => {
    expect(check('Beta', folder)).toMatchObject({ ok: true, name: 'Beta', dir: folder, notes: [] })
  })

  it('refuses a path that does not exist, in a sentence that names it', () => {
    const missing = path.join(root, 'does-not-exist')
    const verdict = check('Ghost', missing)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe(`There is no folder at ${missing}. Choose one that exists.`)
  })

  it('refuses a file, in a sentence that says what it is', () => {
    const verdict = check('FileDir', file)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe(`${file} is a file, not a folder. Choose a folder.`)
  })

  it('refuses a relative path rather than guess what it is relative to', () => {
    const verdict = check('Rel', 'proj-a')
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/whole path/)
  })

  it('reads ~ as the home folder and drops a trailing slash', () => {
    expect(check('Tilde', '~/proj-a/').dir).toBe(folder)
    expect(check('Tilde', '~', { home: homedir() }).dir).toBe(homedir())
  })

  it('says a taken name before creating, and what it will be called instead', () => {
    const verdict = check('Alpha', root, { workspaces })
    expect(verdict.ok).toBe(true)
    expect(verdict.name).toBe('Alpha (2)')
    expect(verdict.notes).toContain('"Alpha" is taken, so this one will be called "Alpha (2)".')
  })

  it('says a folder another workspace works in before creating', () => {
    const verdict = check('Beta', folder, { workspaces })
    expect(verdict.ok).toBe(true)
    expect(verdict.notes).toContain('"Alpha" already works in this folder, so their agents will share its files.')
  })

  it('counts a folder that is not the owner\'s first', () => {
    const second = [{ ...workspaces[0], dir: root, dirs: [root, folder] }]
    expect(check('Beta', folder, { workspaces: second }).notes).toHaveLength(1)
  })

  it('falls back to the suggested folder when none is given', () => {
    const verdict = check('Beta', '   ', { liveDir: folder })
    expect(verdict.dir).toBe(root)
    expect(verdict.ok).toBe(true)
  })

  it('says where a workspace with no folder given will work', () => {
    expect(check('Beta', '', { liveDir: folder }).notes).toContain(`No folder given, so this one will work in ${root}.`)
  })

  it('offers the suggestion with every answer, so the sheet can open on it', () => {
    expect(check('', '', { liveDir: folder }).suggestedDir).toBe(root)
  })
})

describe('suggestWorkspaceDir', () => {
  const home = '/home/me'

  it('sits beside the workspace you are in, so a new project is one folder away', () => {
    expect(suggestWorkspaceDir('/home/me/work/proj-a', home)).toBe('/home/me/work')
  })

  it('never lands in a hidden worktree under ~/.cookrew', () => {
    expect(suggestWorkspaceDir('/home/me/.cookrew/worktrees/alpha-1234/proj-a', home)).toBe(home)
  })

  it('never lands in any hidden folder', () => {
    expect(suggestWorkspaceDir('/home/me/.config/thing/deep', home)).toBe(home)
  })

  it('is the home folder when the live folder is the home folder or outside it', () => {
    expect(suggestWorkspaceDir(home, home)).toBe(home)
    expect(suggestWorkspaceDir('/home/me/proj-a', home)).toBe(home)
    expect(suggestWorkspaceDir('/srv/data/x', home)).toBe(home)
    expect(suggestWorkspaceDir('', home)).toBe(home)
  })
})
