// A CLOSED WINDOW'S CARD (renderer use/UseOverlay.tsx): it says so over the
// last frame and offers the screen or another window; nothing else offers.
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ openUseSource: vi.fn() }))
vi.mock('../src/renderer/src/api', () => ({ cookrew: () => api }))

const { goneOffered, deviceLine, GoneOfferView, showTheScreen } = await import('../src/renderer/src/use/UseOverlay')
const { closeSourcePicker, currentSourceAsk } = await import('../src/renderer/src/use/source-picker-store')

const gone = { state: 'offline', message: "The 'Safari' window this card showed has closed", use: 'computer', input: false, gone: 'window' } as const

type Props = { children?: ReactNode; onClick?: () => void }
const elements = (node: ReactNode): ReactElement<Props>[] => {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Props>(node)) return []
  return [node, ...elements(node.props.children)]
}
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join('') : isValidElement<Props>(node) ? text(node.props.children) : node == null || node === false ? '' : String(node)

beforeEach(() => {
  api.openUseSource.mockReset()
  closeSourcePicker()
})

describe('goneOffered', () => {
  it('only a window that is gone, and only while it is', () => {
    expect(goneOffered(gone)).toBe(true)
    expect(goneOffered({ ...gone, gone: undefined })).toBe(false)
    expect(goneOffered({ ...gone, state: 'live' })).toBe(false)
    expect(goneOffered(null)).toBe(false)
  })
  it('the line says what happened, in the device\'s own sentence', () => {
    expect(deviceLine(gone, false)).toEqual({ text: gone.message, tone: 'warn' })
  })
})

describe('GoneOfferView', () => {
  it('offers the screen and another window', () => {
    const onScreen = vi.fn()
    const onAnother = vi.fn()
    const tree = GoneOfferView({ error: null, busy: false, onScreen, onAnother })
    const buttons = elements(tree).filter((el) => el.type === 'button')
    expect(buttons.map(text)).toEqual(['Show the screen', 'Pick another window'])
    buttons[0].props.onClick?.()
    buttons[1].props.onClick?.()
    expect(onScreen).toHaveBeenCalledOnce()
    expect(onAnother).toHaveBeenCalledOnce()
  })
})

describe('showTheScreen', () => {
  it('points this card at the main display', async () => {
    api.openUseSource.mockResolvedValue({ ok: true, card: { id: 'c', name: 'Main display', url: 'screen://main' } })
    expect(await showTheScreen('c')).toBeNull()
    expect(api.openUseSource).toHaveBeenCalledWith({ source: 'screen:main', card: 'c' })
  })
  it('answers the refusal in words', async () => {
    api.openUseSource.mockResolvedValue({ ok: false, error: 'Screen Recording is off' })
    expect(await showTheScreen('c')).toBe('Screen Recording is off')
  })
})

describe('another window', () => {
  it('opens the sheet for this card', async () => {
    const { openSourcePicker } = await import('../src/renderer/src/use/source-picker-store')
    openSourcePicker({ card: 'c' })
    expect(currentSourceAsk()).toMatchObject({ card: 'c' })
  })
})
