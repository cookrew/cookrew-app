import { useEffect, useRef, useState } from 'react'
import { sendRefusal, type RemoteItem } from './remote-machine'
import { remoteDraft, setRemoteDraft, type RemoteMachineRef } from './remote-machine-store'
import { callRemote, REMOTE_PAGE_MS, useRemoteNote, useRemotePicture } from './use-remote-machine'

/**
 * A BROWSER, A SCREEN OR A NOTE ON ANOTHER MACHINE, WORKED FROM HERE (owner
 * 2026-11-10, design B, layers 3 and 4). A page is its picture: a click taps
 * where it lands, the wheel scrolls it, the box types into it, all in the
 * shares of the picture that machine's own routes take (watch-routes.ts ·
 * browserInputOf). A computer's screen is the same once control is taken on
 * it, as a phone takes it (use-source-routes.ts · control), and that machine
 * says on its own screen who holds it. A note is read.
 */

/** The widest picture that machine sends (watch-routes.ts · FRAME_WIDTH_MAX). */
const PAGE_W = 640
/** A wheel's turns, gathered, go at most this often: a trackpad sends sixty a second. */
const WHEEL_MS = 220
/** After a touch, the picture is asked for again once the page has had time to move. */
const SETTLED_MS = 500

type Say = (text: string, failed: boolean) => void

function usePageInput(machine: RemoteMachineRef, item: RemoteItem, say: Say, refresh: () => void): (body: Record<string, unknown>) => Promise<boolean> {
  const later = useRef(0)
  useEffect(() => () => window.clearTimeout(later.current), [])
  return async (body) => {
    const refusal = sendRefusal(await callRemote(machine.id, 'POST', `api/watch/item/${encodeURIComponent(item.id)}/input`, body), machine.name)
    if (refusal) say(refusal, true)
    window.clearTimeout(later.current)
    later.current = window.setTimeout(refresh, SETTLED_MS)
    return refusal === null
  }
}

function Page({ machine, item, say }: { machine: RemoteMachineRef; item: RemoteItem; say: Say }): React.JSX.Element {
  const { src, refresh } = useRemotePicture(machine.id, item.id, PAGE_W, false, REMOTE_PAGE_MS)
  const input = usePageInput(machine, item, say, refresh)
  const frame = useRef<HTMLDivElement>(null)
  const wheel = useRef({ dy: 0, x: 0.5, y: 0.5, timer: 0 })
  const inputRef = useRef(input)
  inputRef.current = input
  const box = `item:${item.id}`
  const [words, setWords] = useState(() => remoteDraft(machine.id, box))
  const write = (text: string): void => {
    setWords(text)
    setRemoteDraft(machine.id, box, text)
  }

  const share = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const rect = frame.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return null
    const clamp = (v: number): number => Math.min(1, Math.max(0, v))
    return { x: clamp((e.clientX - rect.left) / rect.width), y: clamp((e.clientY - rect.top) / rect.height) }
  }

  // The wheel, gathered and sent as a share of the picture's height, where the pointer is.
  useEffect(() => {
    const el = frame.current
    if (!el) return undefined
    const onWheel = (e: WheelEvent): void => {
      const at = share(e)
      if (!at) return
      e.preventDefault()
      e.stopPropagation()
      const held = wheel.current
      held.dy += e.deltaY * (e.deltaMode === 1 ? 16 : 1)
      held.x = at.x
      held.y = at.y
      if (held.timer) return
      held.timer = window.setTimeout(() => {
        const height = el.getBoundingClientRect().height || 1
        const fy = held.dy / height
        held.dy = 0
        held.timer = 0
        if (fy !== 0) void inputRef.current({ t: 'scroll', fy, x: held.x, y: held.y })
      }, WHEEL_MS)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      window.clearTimeout(wheel.current.timer)
      wheel.current.timer = 0
    }
  }, [])

  const type = async (): Promise<void> => {
    const text = words.trim()
    if (text && (await input({ t: 'text', text }))) write('')
  }

  return (
    <>
      <div
        ref={frame}
        className="rm-page"
        role="button"
        tabIndex={0}
        aria-label={`${item.title} on ${machine.name}: click to tap there, scroll to scroll it`}
        onClick={(e) => {
          const at = share(e)
          if (at) void input({ t: 'tap', ...at })
        }}
      >
        {src ? <img src={src} alt={`${item.title} on ${machine.name}`} draggable={false} /> : <p className="rm-empty">Asking {machine.name} for the picture…</p>}
      </div>
      <form className="rm-box" onSubmit={(e) => { e.preventDefault(); void type() }}>
        <input value={words} onChange={(e) => write(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder={`Type into ${item.title} on ${machine.name}…`} aria-label={`Type into ${item.title} on ${machine.name}`} autoComplete="off" />
        <button type="submit" disabled={!words.trim()}>Type</button>
        <button type="button" onClick={() => void input({ t: 'enter' })} aria-label="Press Enter">⏎</button>
      </form>
    </>
  )
}

/** A computer's screen: control first, as a phone takes it; given back when this view leaves it. */
function ScreenControl({ machine, item, workspaceId, say }: { machine: RemoteMachineRef; item: RemoteItem; workspaceId: string; say: Say }): React.JSX.Element {
  const [held, setHeld] = useState(false)
  const route = `api/use/sources/control?seat=${encodeURIComponent(workspaceId)}`
  const heldRef = useRef(false)
  heldRef.current = held
  useEffect(
    () => () => {
      if (heldRef.current) void callRemote(machine.id, 'POST', route, { card: item.id, on: false })
    },
    [machine.id, route, item.id]
  )
  const flip = async (on: boolean): Promise<void> => {
    const answer = await callRemote(machine.id, 'POST', route, { card: item.id, on })
    const refusal = sendRefusal(answer, machine.name)
    if (refusal) return say(refusal, true)
    setHeld(on)
    say(on ? `You control this screen on ${machine.name} for 15 minutes.` : 'Control given back.', false)
  }
  return (
    <div className="rm-control">
      <span>{held ? `You hold control of ${machine.name}’s screen.` : `${machine.name}’s screen. Take control to work it from here.`}</span>
      <button type="button" onClick={() => void flip(!held)}>{held ? 'Give back' : 'Take control'}</button>
    </div>
  )
}

function Note({ machine, item }: { machine: RemoteMachineRef; item: RemoteItem }): React.JSX.Element {
  const note = useRemoteNote(machine.id, item.id)
  return note ? <pre className="rm-text">{note.content || '(empty note)'}</pre> : <p className="rm-empty">Asking {machine.name} for the note…</p>
}

export function RemoteItemView({ machine, item, workspaceId }: { machine: RemoteMachineRef; item: RemoteItem; workspaceId: string }): React.JSX.Element {
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null)
  const say: Say = (text, failed) => setNote({ text, failed })
  return (
    <section className="rm-item" aria-label={`${item.title} on ${machine.name}`}>
      {item.kind === 'note' ? (
        <Note machine={machine} item={item} />
      ) : (
        <>
          {item.use === 'computer' && <ScreenControl machine={machine} item={item} workspaceId={workspaceId} say={say} />}
          <Page machine={machine} item={item} say={say} />
        </>
      )}
      <p className={`rm-note${note?.failed ? ' failed' : ''}`} role="status">{note?.text ?? ''}</p>
    </section>
  )
}
