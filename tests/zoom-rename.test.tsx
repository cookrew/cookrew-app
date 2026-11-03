// RENAME BY HAND IN THE ZOOM VIEW (owner, 2026-11-04): a double-click on an
// agent's name (the crew card, the floating card, the full view's head) turns
// it into a field; on a phone a tap on the name on the bar does. Enter or
// blur saves, Esc cancels, an IME's Enter picks a character and saves
// nothing. ⋯ → Rename opens the same field. Notes rename the same way.
//
// House pattern: no jsdom. The rules are pure (zoom/name-edit.ts) and the
// field is a plain function component whose element tree is pressed directly.
import { readFileSync } from 'node:fs'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clickOrDouble, IDLE_EDIT, nameEditKey, nameEditReducer, planCommit } from '../src/renderer/src/zoom/name-edit'
import { onRenameRequest, requestRename } from '../src/renderer/src/zoom/rename-request'
import { NameField } from '../src/renderer/src/zoom/NameEdit'
import { AgentNode, type Bind } from '../src/renderer/src/zoom/ZoomParts'
import type { AgentView } from '../src/renderer/src/zoom/zoom-model'

const key = (k: string, over: Record<string, unknown> = {}) => ({ key: k, keyCode: 0, nativeEvent: { isComposing: false }, ...over })

describe('nameEditKey — Enter saves, Esc cancels, never while composing', () => {
  it('Enter commits and Escape cancels', () => {
    expect(nameEditKey(key('Enter'), false)).toBe('commit')
    expect(nameEditKey(key('Escape'), false)).toBe('cancel')
    expect(nameEditKey(key('a'), false)).toBeNull()
  })
  it('an IME composing takes Enter (and Esc) for itself', () => {
    expect(nameEditKey(key('Enter', { nativeEvent: { isComposing: true } }), false)).toBeNull()
    expect(nameEditKey(key('Enter'), true)).toBeNull()
    // Safari ends the composition before its keydown, which then reads 229.
    expect(nameEditKey(key('Enter', { keyCode: 229 }), false)).toBeNull()
    expect(nameEditKey(key('Escape', { nativeEvent: { isComposing: true } }), false)).toBeNull()
  })
})

describe('planCommit — what a save sends', () => {
  it('an empty or whitespace name is refused with the main process’s words', () => {
    expect(planCommit('', 'Forge')).toEqual({ kind: 'refuse', error: 'A name needs at least one letter or digit.' })
    expect(planCommit(' \n\t ', 'Forge')).toEqual({ kind: 'refuse', error: 'A name needs at least one letter or digit.' })
  })
  it('the same name closes without a save; another is trimmed and cleaned', () => {
    expect(planCommit('  Forge ', 'Forge')).toEqual({ kind: 'close' })
    expect(planCommit('  Billing\n Webhook ', 'Forge')).toEqual({ kind: 'save', name: 'Billing Webhook' })
    expect(planCommit('构建 修复', 'Forge')).toEqual({ kind: 'save', name: '构建 修复' })
  })
})

describe('nameEditReducer — the field’s states', () => {
  it('opens on the name, types, cancels back to it', () => {
    const open = nameEditReducer(IDLE_EDIT, { type: 'start', name: 'Forge' })
    expect(open).toMatchObject({ editing: true, draft: 'Forge', error: null })
    const typed = nameEditReducer(open, { type: 'type', draft: 'Scout' })
    expect(typed.draft).toBe('Scout')
    expect(nameEditReducer(typed, { type: 'cancel' })).toEqual(IDLE_EDIT)
  })
  it('a refusal on Enter keeps the field open with its message; typing clears it', () => {
    const open = nameEditReducer(IDLE_EDIT, { type: 'start', name: 'Forge' })
    const refused = nameEditReducer({ ...open, saving: true }, { type: 'refused', error: 'taken', keepOpen: true })
    expect(refused).toMatchObject({ editing: true, saving: false, error: 'taken' })
    expect(nameEditReducer(refused, { type: 'type', draft: 'S' }).error).toBeNull()
  })
  it('a refusal on blur closes the field and still says why', () => {
    const open = nameEditReducer(IDLE_EDIT, { type: 'start', name: 'Forge' })
    expect(nameEditReducer(open, { type: 'refused', error: 'taken', keepOpen: false })).toMatchObject({ editing: false, error: 'taken' })
  })
  it('Esc while a save is out does nothing: the save cannot be called back', () => {
    const saving = { ...IDLE_EDIT, editing: true, saving: true, draft: 'Scout' }
    expect(nameEditReducer(saving, { type: 'cancel' })).toBe(saving)
  })
  it('a field moved to another card starts over', () => {
    const open = nameEditReducer(IDLE_EDIT, { type: 'start', name: 'Forge' })
    expect(nameEditReducer({ ...open, saving: true, error: 'x' }, { type: 'reset' })).toEqual(IDLE_EDIT)
  })
  it('a save shows the new name until the card wears it', () => {
    const saved = nameEditReducer({ ...IDLE_EDIT, editing: true, saving: true, draft: 'Scout' }, { type: 'saved', name: 'Scout' })
    expect(saved).toMatchObject({ editing: false, saving: false, shown: 'Scout' })
    expect(nameEditReducer(saved, { type: 'settled' })).toEqual(IDLE_EDIT)
  })
})

describe('clickOrDouble — one click presses, a double-click renames', () => {
  afterEach(() => vi.useRealTimers())
  it('a single click presses after the double-click window; a second click renames instead', () => {
    vi.useFakeTimers()
    const press = vi.fn()
    const rename = vi.fn()
    const c = clickOrDouble(() => ({ press, rename, tap: false }))
    c.click(1)
    vi.advanceTimersByTime(100)
    c.click(2)
    vi.advanceTimersByTime(1000)
    expect(press).not.toHaveBeenCalled()
    expect(rename).toHaveBeenCalledTimes(1)
    c.click(1)
    vi.advanceTimersByTime(1000)
    expect(press).toHaveBeenCalledTimes(1)
  })
  it('the keyboard (detail 0) presses at once; with nothing to press a click waits for the second', () => {
    vi.useFakeTimers()
    const press = vi.fn()
    const rename = vi.fn()
    clickOrDouble(() => ({ press, rename, tap: false })).click(0)
    expect(press).toHaveBeenCalledTimes(1)
    const bare = clickOrDouble(() => ({ rename, tap: false }))
    bare.click(1)
    vi.advanceTimersByTime(1000)
    expect(rename).not.toHaveBeenCalled()
    bare.click(2)
    expect(rename).toHaveBeenCalledTimes(1)
  })
  it('a slower double-click (inside the OS window, past ours) still renames', () => {
    vi.useFakeTimers()
    const press = vi.fn()
    const rename = vi.fn()
    const c = clickOrDouble(() => ({ press, rename, tap: false }))
    c.click(1)
    vi.advanceTimersByTime(400)
    c.click(2)
    expect(press).toHaveBeenCalledTimes(1)
    expect(rename).toHaveBeenCalledTimes(1)
  })
  it('on the phone’s bar one tap renames', () => {
    const rename = vi.fn()
    clickOrDouble(() => ({ rename, tap: true })).click(1)
    expect(rename).toHaveBeenCalledTimes(1)
  })
})

describe('⋯ → Rename asks the card’s own field', () => {
  it('reaches the listeners of that card only', () => {
    const t1 = vi.fn()
    const t2 = vi.fn()
    const off1 = onRenameRequest('t1', t1)
    const off2 = onRenameRequest('t2', t2)
    requestRename('t1')
    expect(t1).toHaveBeenCalledTimes(1)
    expect(t2).not.toHaveBeenCalled()
    off1()
    off2()
    requestRename('t1')
    expect(t1).toHaveBeenCalledTimes(1)
  })
})

/** Every element in a tree, depth first. */
const elements = (node: ReactNode): ReactElement<Record<string, unknown>>[] => {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  const el = node as ReactElement<Record<string, unknown>>
  return [el, ...elements(el.props.children as ReactNode)]
}

describe('NameField — the field itself', () => {
  const field = (over: Partial<Parameters<typeof NameField>[0]> = {}) => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    const onDraft = vi.fn()
    const props = { label: 'Forge', draft: 'Forge', saving: false, error: null, composing: { current: false }, onCommit, onCancel, onDraft, ...over }
    const tree = NameField(props)
    const input = elements(tree).find((e) => e.type === 'input')!
    return { tree, input, onCommit, onCancel, onDraft }
  }
  const ev = (k: string, isComposing = false) => ({ key: k, keyCode: 0, nativeEvent: { isComposing }, preventDefault: vi.fn(), stopPropagation: vi.fn() })

  it('is a labelled text field for a phone keyboard too', () => {
    const html = renderToStaticMarkup(field().tree)
    expect(html).toContain('<input')
    expect(html).toContain('aria-label="Rename Forge"')
    expect(html).toContain('value="Forge"')
    expect(html).toContain('enterKeyHint="done"')
  })

  it('Enter saves, Esc cancels, and neither key reaches the card around it', () => {
    const { input, onCommit, onCancel } = field()
    const enter = ev('Enter')
    ;(input.props.onKeyDown as (e: unknown) => void)(enter)
    expect(onCommit).toHaveBeenCalledWith('enter')
    expect(enter.stopPropagation).toHaveBeenCalled()
    const esc = ev('Escape')
    ;(input.props.onKeyDown as (e: unknown) => void)(esc)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(esc.stopPropagation).toHaveBeenCalled()
  })

  it('an Enter while composing saves nothing', () => {
    const composing = { current: false }
    const { input, onCommit } = field({ composing })
    ;(input.props.onKeyDown as (e: unknown) => void)(ev('Enter', true))
    ;(input.props.onCompositionStart as () => void)()
    expect(composing.current).toBe(true)
    ;(input.props.onKeyDown as (e: unknown) => void)(ev('Enter'))
    expect(onCommit).not.toHaveBeenCalled()
    ;(input.props.onCompositionEnd as () => void)()
    expect(composing.current).toBe(false)
  })

  it('blur saves; a refusal is said where the name is', () => {
    const { input, onCommit } = field()
    ;(input.props.onBlur as () => void)()
    expect(onCommit).toHaveBeenCalledWith('blur')
    const html = renderToStaticMarkup(field({ draft: '  ', error: 'A name needs at least one letter or digit.' }).tree)
    expect(html).toContain('role="alert"')
    expect(html).toContain('A name needs at least one letter or digit.')
  })
})

describe('the names that rename', () => {
  const bind: Bind = () => () => undefined
  const agent: AgentView = {
    id: 't1', name: 'Forge', preset: 'Claude Code', orch: false, phase: 'waiting', status: 'waiting', word: 'needs you',
    line: '', browsers: 0, notes: 0, turn: null
  }
  it('the crew card’s name says it renames on a double-click, and still opens on a click', () => {
    const html = renderToStaticMarkup(<AgentNode agent={agent} bind={bind} onOpen={() => undefined} />)
    expect(html).toContain('Double-click to rename')
    expect(html).toContain('Forge')
    const src = readFileSync('src/renderer/src/zoom/ZoomParts.tsx', 'utf8')
    expect(src).toContain("useNameEdit(agent.id, agent.name, { onPress: onOpen })")
  })
  it('the floating card, the full view’s head and the phone’s bar wear the same field', () => {
    expect(readFileSync('src/renderer/src/zoom/AgentCard.tsx', 'utf8')).toContain('useNameEdit(agent.id, agent.name)')
    const stage = readFileSync('src/renderer/src/stage/StageView.tsx', 'utf8')
    // One field per card: keyed, so a head that shows another agent never carries the last one's draft.
    expect(stage.match(/<NameHost key=\{shown\.id\} id=\{shown\.id\} name=\{shown\.name\}[^>]*\bmenu\b/g)?.length).toBe(2)
    expect(stage).toMatch(/<NameHost key=\{shown\.id\} id=\{shown\.id\} name=\{shown\.name\} tap\b/)
    expect(stage).toMatch(/<NameHost key=\{pickedItem\.id\} id=\{pickedItem\.id\} name=\{pickedItem\.title\}/)
  })
  it('⋯ on an agent’s full view has a Rename row', () => {
    const overlay = readFileSync('src/renderer/src/TerminalOverlay.tsx', 'utf8')
    expect(overlay).toContain('requestRename(node.id)')
    expect(overlay).toContain('<span className="cr-more-label">Rename</span>')
  })
})
