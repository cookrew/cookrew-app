// Shared by the zoom QA tests (Gauge, 2026-11-01): a crew model, and a paint()
// run on stand-in elements that reads back what the painter wrote.
import { layoutOf, paint, type FrameEls, type FrameModel, type FrameState } from '../src/renderer/src/zoom/zoom-frame'

export const modelOf = (agents: number, workspaces = 1): FrameModel => ({
  agents: Array.from({ length: agents }, (_, i) => ({ id: `a${i}`, name: `A${i}`, preset: 'Claude Code', orch: i === 0, waiting: false })),
  items: [],
  links: [],
  ties: [],
  workspaces: Array.from({ length: workspaces }, (_, i) => `w${i}`),
  otherMachines: 0,
  active: 'w0',
  newest: null
})

const part = (): HTMLElement => ({ style: {} }) as unknown as HTMLElement

/** The owner's workspace label ("13 COOKREW DEV 216 83"): about this wide and tall at 11px. */
export const LABEL = { w: 200, h: 24 }

export function paintAt(model: FrameModel, st: Partial<FrameState> & { sv: number; w: number; h: number; narrow: boolean }, size: { w: number; h: number } = LABEL) {
  const els = {
    devices: part(), device: part(), scene: part(), panel: part(), wash: part(), ring: part(), label: part(), newCap: part(), machine: part(),
    labelW: size.w, labelH: size.h,
    agents: new Map(), links: new Map(), items: new Map(), ties: new Map(), marks: new Map(), next: null
  } as unknown as FrameEls
  const L = layoutOf(model, st.narrow)
  const out = paint(model, L, els, { dir: 'agents', focus: model.agents[0]?.id ?? null, leaving: null, leavingAmt: 0, focusItem: null, ...st })
  const nums = (t: string, fn: string): number[] => (t.match(new RegExp(`${fn}\\(([^)]*)\\)`))?.[1] ?? '').split(',').map((n) => parseFloat(n))
  const scene = { t: nums(els.scene.style.transform, 'translate'), s: nums(els.scene.style.transform, 'scale')[0] }
  const lt = nums(els.label.style.transform, 'translate')
  const lk = els.label.style.transform.includes('scale(') ? nums(els.label.style.transform, 'scale')[0] : 1
  // The label scales about its centre (zoom.css · .zv-grp has no origin of its own).
  const cx = scene.t[0] + (lt[0] + size.w / 2) * scene.s
  const cy = scene.t[1] + (lt[1] + size.h / 2) * scene.s
  const hw = (size.w * lk * scene.s) / 2
  const hh = (size.h * lk * scene.s) / 2
  return { L, out, scene, label: { left: cx - hw, right: cx + hw, top: cy - hh, bottom: cy + hh, k: lk, o: Number(els.label.style.opacity) } }
}
