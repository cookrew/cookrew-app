// THE DEVICE'S CARD OFFERS A WINDOW (renderer zoom/ZoomParts.tsx · LocalMachine):
// the share button sits on this machine's card, and pressing it opens the
// picker without also opening the device.
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LocalMachine } from '../src/renderer/src/zoom/ZoomParts'
import { layoutOf, paint, type FrameEls } from '../src/renderer/src/zoom/zoom-frame'
import { modelOf } from './zoom-qa-helpers'

const base = { name: 'Studio', detail: '3 workspaces · 9 agents', bind: () => () => undefined, onOpen: () => undefined }

type Props = { children?: ReactNode; onClick?: (e: unknown) => void; className?: string }
const elements = (node: ReactNode): ReactElement<Props>[] => {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Props>(node)) return []
  return [node, ...elements(node.props.children)]
}

describe('LocalMachine', () => {
  it('is the same card: name, counts, and a press opens the device', () => {
    const onOpen = vi.fn()
    const tree = LocalMachine({ ...base, onOpen, onShare: null })
    const html = renderToStaticMarkup(tree)
    expect(html).toContain('Studio')
    expect(html).toContain('3 workspaces · 9 agents')
    expect(html).not.toContain('zv-machine-share')
    elements(tree)[0].props.onClick?.({})
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('carries the share button when the machine can share, and its press stays its own', () => {
    const onOpen = vi.fn()
    const onShare = vi.fn()
    const stopPropagation = vi.fn()
    const tree = LocalMachine({ ...base, onOpen, onShare })
    const share = elements(tree).find((el) => el.props.className === 'zv-machine-share')
    expect(share?.type).toBe('button')
    share?.props.onClick?.({ stopPropagation })
    expect(onShare).toHaveBeenCalledOnce()
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('the share button keeps a thumb\'s size wherever the camera is', () => {
  type Part = HTMLElement & { _t?: string; _o?: number }
  const part = (): Part => ({ style: { setProperty: () => undefined } }) as unknown as Part
  const scaleOf = (t: string): number => {
    const m = [...t.matchAll(/scale\(([^)]*)\)/g)].map((x) => parseFloat(x[1].split(',')[0]))
    return m.length ? m.reduce((a, b) => a * b, 1) : 1
  }
  const onScreen = (w: number, h: number, narrow: boolean): number => {
    const model = modelOf(13)
    const words = part()
    const share = part()
    const els = {
      devices: part(), device: part(), scene: part(), panel: part(), wash: part(), label: part(), newCap: part(), machine: part(),
      labelW: 200, labelH: 24, agents: new Map(), links: new Map(), items: new Map(), ties: new Map(), marks: new Map(), next: null,
      deviceLabel: part(), markLabels: [], machineWords: [words], machineShare: share
    } as unknown as FrameEls
    paint(model, layoutOf(model, narrow), els, { dir: 'agents', sv: -2, w, h, narrow, focus: null, leaving: null, leavingAmt: 0, focusItem: null })
    return scaleOf(els.devices.style.transform) * scaleOf(words.style.transform ?? '') * scaleOf(share.style.transform)
  }

  it('is 1:1 on a phone, and on a desk', () => {
    expect(onScreen(412, 753, true)).toBeCloseTo(1, 2)
    expect(onScreen(375, 650, true)).toBeCloseTo(1, 2)
    expect(onScreen(1440, 900, false)).toBeCloseTo(1, 2)
  })
})
