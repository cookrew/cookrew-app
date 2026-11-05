/**
 * A LAUNCH THAT CANNOT GO ON SAYS WHY, IF IT CAN STILL PAINT (round 2, bug 13).
 *
 * A throw while main's module runs left the process up with no window: a black
 * screen, the reason on a terminal nobody opened. `bootStep` wraps the steps that
 * touch the disk and asks for a window with the reason in it, then fails as it
 * did. What dies before any JavaScript (Electron's chrome-sandbox check on Linux)
 * cannot be reached from here: that one stays on the terminal.
 */

const escaped = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function failureReason(error: unknown): string {
  const { code, path } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; path?: unknown }
  if ((code === 'EACCES' || code === 'EPERM') && typeof path === 'string') {
    return `Cookrew does not have permission to use ${path}. It may belong to another user on this computer.`
  }
  return error instanceof Error ? error.message : String(error)
}

export function failureHtml(error: unknown): string {
  return `<!doctype html><meta charset="utf-8"><title>Cookrew could not start</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#f4efe4;color:#1d1a16;font:14px/1.5 ui-monospace,Menlo,monospace">
<main style="max-width:560px;padding:24px"><h1 style="font:500 24px Georgia,serif;margin:0 0 12px">Cookrew could not start</h1>
<p>${escaped(failureReason(error))}</p><p style="color:#6f675b">Close this window, fix that, and open Cookrew again.</p></main>`
}

/** One boot step. A failure paints, then goes on failing: nothing after it can run. */
export function bootStep<T>(step: () => T, paint: (error: unknown) => void): T {
  try {
    return step()
  } catch (error) {
    paint(error)
    throw error
  }
}

interface FailureWindow {
  loadURL: (url: string) => Promise<void>
}

/** Waits for the app to be able to draw, then draws one plain window. Never throws. */
export function paintFailure(whenReady: () => Promise<unknown>, open: () => FailureWindow, error: unknown): void {
  console.error('Cookrew could not start:', error)
  void whenReady()
    .then(() => open().loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(failureHtml(error))}`))
    .catch((paintError: unknown) => console.error('The failure window could not open:', paintError))
}
