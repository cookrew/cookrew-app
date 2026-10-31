import { useCallback, useLayoutEffect, useRef } from 'react'
import { agentClick, derive, itemClick, settle, type ZoomDir } from './zoom-path'
import { layoutOf, paint, type FrameEls, type FrameModel } from './zoom-frame'
import { zoomStore } from './zoom-store'
import { stageSelect } from '../stage/stage-select'

/** The compositor-facing part of the navigator. React builds nodes; this owns the moving values. */
export function useZoomMotion(model: FrameModel, collect: () => FrameEls | null, root: React.RefObject<HTMLDivElement>) {
  const m = useRef({ model, collect })
  m.current = { model, collect }
  const moving = useRef({ v: zoomStore.get().v, dir: zoomStore.get().dir, leaving: null as string | null, amount: 0, pending: null as { id: string; full: boolean } | null })
  const kick = useRef<() => void>(() => undefined)
  const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSelection = useRef<string | null>(null)
  const wake = useCallback(() => kick.current(), [])

  useLayoutEffect(() => {
    let raf = 0
    let last = 0
    let alive = true
    let layoutModel: FrameModel | null = null
    let narrowWas = false
    let layout: ReturnType<typeof layoutOf> | null = null
    let jump = zoomStore.get().jump
    const tick = (now: number): void => {
      raf = 0
      if (!alive) return
      const env = root.current
      const els = m.current.collect()
      if (!env || !els) return
      const { clientWidth: w, clientHeight: h } = env
      if (w < 1 || h < 1) return
      const narrow = w < 760
      if (!layout || m.current.model !== layoutModel || narrow !== narrowWas) {
        layoutModel = m.current.model
        narrowWas = narrow
        layout = layoutOf(layoutModel, narrow)
      }
      const target = zoomStore.get()
      const at = moving.current
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const dt = last ? Math.min(64, now - last) : 16
      last = now
      if (jump !== target.jump || at.dir !== target.dir) {
        // Across paths, keep only a snapshot of the old view, never a second live terminal.
        if (!reduced) {
          const ghost = els.scene.cloneNode(true) as HTMLElement
          ghost.removeAttribute('id')
          ghost.classList.add('zv-ghost')
          env.append(ghost)
          const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' })
          void fade.finished.then(() => ghost.remove(), () => ghost.remove())
        }
        at.dir = target.dir
        at.v = target.v
        jump = target.jump
      } else if (reduced) at.v = target.v
      else at.v += (target.v - at.v) * (1 - Math.exp(-dt / 90))
      if (Math.abs(target.v - at.v) < 0.0005) at.v = target.v
      if (at.leaving) {
        at.amount *= Math.exp(-dt / 75)
        if (at.amount < 0.002) {
          at.leaving = null
          at.amount = 0
        }
      }
      if (at.pending && at.v <= 2.005) {
        const pending = at.pending
        at.pending = null
        at.leaving = zoomStore.get().agent
        at.amount = 1
        at.v = 1
        zoomStore.focusAgent(pending.id)
        zoomStore.go(pending.full ? 3 : 2, 'agents')
      }
      const focus = target.agent ?? m.current.model.agents[0]?.id ?? null
      const focusItem = target.item ?? m.current.model.items[0]?.id ?? null
      // WHO OWNS `full`: the value the eye has reached, never the target. Enter
      // late and leave early (hysteresis), so a wheel resting near the edge does
      // not mount and unmount the real view under itself.
      const wasFull = zoomStore.get().full
      const enter = at.dir === 'agents' ? at.v > 2.85 : at.v > 0.85
      const stay = wasFull !== null && wasFull === (at.dir === 'agents' ? 'agent' : 'item') && (at.dir === 'agents' ? at.v > 2.4 : at.v > 0.4)
      const fullKind = wasFull !== null && wasFull !== (at.dir === 'agents' ? 'agent' : 'item') ? null : enter || stay ? (at.dir === 'agents' ? 'agent' : 'item') : null
      zoomStore.setFull(fullKind)
      if (fullKind !== null) {
        const selectionKey = fullKind === 'agent' ? `agent:${focus ?? ''}` : `item:${focusItem ?? ''}`
        if (lastSelection.current !== selectionKey) {
          lastSelection.current = selectionKey
          if (fullKind === 'agent' && focus) stageSelect.set({ kind: 'agent', id: focus })
          else if (fullKind === 'item' && focusItem) stageSelect.set({ kind: 'item', id: focusItem })
        }
      } else if (lastSelection.current !== null) {
        lastSelection.current = null
      }
      const out = paint(m.current.model, layout, els, { dir: at.dir, sv: at.v, focus, leaving: at.leaving, leavingAmt: at.amount, focusItem, w, h, narrow })
      // The real view fades in under the shell as the shell's own cover goes.
      env.style.setProperty('--zv-full-opacity', String(1 - out.cover))
      env.style.setProperty('--zv-cover', String(out.cover))
      env.dataset.full = out.cover < 0.02 ? 'true' : 'false'
      // Per-agent stacking order is changed only when the focus changes.
      for (const a of m.current.model.agents) {
        const el = els.agents.get(a.id)
        if (!el) continue
        const open = a.id === focus && at.v > 1.2
        const flag = open ? 'open' : ''
        if (el.node.dataset.card !== flag) el.node.dataset.card = flag
        const level = a.id === focus && at.v > 1.01 ? 40 : a.id === at.leaving ? 36 : 10
        if (el.node.style.zIndex !== String(level + 2)) el.node.style.zIndex = String(level + 2)
        if (el.cardl.style.zIndex !== String(level)) el.cardl.style.zIndex = String(level)
      }
      for (const l of m.current.model.links) {
        const el = els.links.get(l.key)
        if (!el) continue
        const level = l.agent === focus && at.v > 1.01 ? 41 : l.agent === at.leaving ? 37 : 8
        if (el.node.style.zIndex !== String(level)) el.node.style.zIndex = String(level)
      }
      const state = zoomStore.get()
      if (at.v !== state.v || at.leaving || at.pending) raf = requestAnimationFrame(tick)
      else last = 0
    }
    kick.current = () => {
      if (!raf && alive) raf = requestAnimationFrame(tick)
    }
    const unsub = zoomStore.subscribe(kick.current)
    const observer = new ResizeObserver(kick.current)
    if (root.current) observer.observe(root.current)
    kick.current()
    return () => {
      alive = false
      if (raf) cancelAnimationFrame(raf)
      observer.disconnect()
      unsub()
      kick.current = () => undefined
      if (snapTimer.current) clearTimeout(snapTimer.current)
    }
  }, [root])

  const go = useCallback((v: number, dir: ZoomDir = zoomStore.get().dir) => {
    if (snapTimer.current) clearTimeout(snapTimer.current)
    zoomStore.go(v, dir)
    // Group is a passage: wheel/slider release never leaves it as a resting view.
    snapTimer.current = setTimeout(() => {
      const s = zoomStore.get()
      const next = settle(s.dir, s.v)
      if (next !== s.v) zoomStore.go(next)
    }, 220)
  }, [])

  const agent = useCallback((id: string) => {
    const s = zoomStore.get()
    const action = agentClick(s.dir, moving.current.v, s.agent === id)
    if (action.kind === 'jump-full') return zoomStore.jumpTo('agent', id)
    if (action.kind === 'refocus-full') {
      moving.current.pending = { id, full: true }
      return go(2, 'agents')
    }
    if (action.kind === 'switch') {
      moving.current.leaving = s.agent
      moving.current.amount = Math.max(0, Math.min(1, moving.current.v - 1))
      moving.current.v = Math.min(moving.current.v, 1)
      zoomStore.focusAgent(id)
      return go(2, 'agents')
    }
    if (s.agent !== id && action.v >= 2) zoomStore.focusAgent(id)
    go(action.v, 'agents')
  }, [go])

  const item = useCallback((id: string) => {
    const s = zoomStore.get()
    const action = itemClick(s.dir, moving.current.v)
    zoomStore.focusItem(id)
    if (action.kind === 'jump-full') return zoomStore.jumpTo('item', id)
    if (action.kind === 'item-full') return go(1, 'items')
    if (action.kind === 'set') go(action.v, action.dir)
  }, [go])

  return { go, agent, item, wake }
}
