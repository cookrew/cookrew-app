import type { WebContents } from 'electron'
import { paneInputs, SEALED_REFUSAL } from './pane-input'

/**
 * `cookrew ui`: REAL INPUT EVENTS, PUT IN THE WINDOW.
 *
 * They reach a focused pane as ordinary keys, and a click can press a control
 * that sends some, so none of this is a keyboard (pane-input.ts). EVERY EVENT
 * ASKS FIRST, not just the command: `ui type` paces itself at 15 ms a
 * character, and a check made once at the top would let one long call open a
 * hidden prompt and go on to answer it.
 */

type InputEvent = Parameters<WebContents['sendInputEvent']>[0]

export interface WindowInput {
  sendInputEvent: (event: never) => void
}

type Modifier = 'shift' | 'control' | 'meta' | 'alt'

export async function injectWindowInput(window: WindowInput, args: readonly string[]): Promise<string> {
  const send = (event: InputEvent): void => {
    if (!paneInputs.driveWindow()) throw new Error(SEALED_REFUSAL)
    window.sendInputEvent(event as never)
  }
  const press = (x: number, y: number, clickCount: number): void => {
    send({ type: 'mouseDown', x, y, button: 'left', clickCount })
    send({ type: 'mouseUp', x, y, button: 'left', clickCount })
  }
  const [sub, ...rest] = args
  if (sub === 'click' || sub === 'dblclick') {
    const x = parseInt(rest[0] ?? '', 10)
    const y = parseInt(rest[1] ?? '', 10)
    press(x, y, 1)
    if (sub === 'click') return `Clicked ${x},${y}`
    press(x, y, 2)
    return `Double-clicked ${x},${y}`
  }
  if (sub === 'type') {
    for (const char of rest.join(' ')) {
      send({ type: 'char', keyCode: char })
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    return `Typed ${rest.join(' ').length} chars`
  }
  if (sub === 'key') {
    const keyCode = rest[0] ?? ''
    // Optional modifiers as a 2nd arg: "meta", "meta+shift", etc.
    const modifiers = rest[1] ? (rest[1].split(/[+,]/) as Modifier[]) : undefined
    send({ type: 'keyDown', keyCode, modifiers })
    send({ type: 'keyUp', keyCode, modifiers })
    return `Pressed ${keyCode}${rest[1] ? ` +${rest[1]}` : ''}`
  }
  throw new Error('Usage: cookrew ui click X Y | dblclick X Y | type "text" | key Enter')
}
