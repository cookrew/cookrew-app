/**
 * Refuse to boot from inside a terminal this app is itself hosting.
 *
 * A Cookrew pane exports HERDR_SESSION, HERDR_TAB_ID and COOKREW_TERMINAL_ID
 * into whatever runs in it. Launch `npm run dev` from a Cookrew card and the
 * new instance inherits the identity of the very multiplexer session it is
 * about to adopt. On boot it reattaches every pane with `--takeover`, including
 * the one whose foreground process group is its own launcher, and kills the
 * chain it hangs from.
 *
 * Observed 2026-08-27: an agent ran the dev server from terminal
 * db9b45d0 on pane w1:t1, and the app died by SIGTERM about ninety seconds
 * into every boot — no crash report, no stack, only `[vite] server connection
 * lost` in the log. The parent chain told the story:
 *
 *     Electron . <- electron-vite dev <- npm run dev <- codex <- herdr server
 *
 * Same medicine as the single-instance lock: turn a slow, invisible
 * self-destruction into an immediate refusal that says why.
 */

export interface SelfHostRefusal {
  terminalId: string
  session: string
}

/**
 * Is this process running inside a pane of the herdr session it would adopt?
 *
 * Both signals are required. HERDR_SESSION alone is not enough — a developer
 * may keep an unrelated herdr session of the same name — and COOKREW_TERMINAL_ID
 * alone is not enough either, since a card belonging to some OTHER session is
 * somebody else's terminal and none of our business. Only the pair means "we
 * are about to take over the pane we are standing on".
 */
export function selfHostedLaunch(
  env: Record<string, string | undefined>,
  ownSession: string
): SelfHostRefusal | null {
  const session = env.HERDR_SESSION
  const terminalId = env.COOKREW_TERMINAL_ID
  if (session !== ownSession) return null
  if (typeof terminalId !== 'string' || terminalId.length === 0) return null
  return { terminalId, session }
}

/** What to print. Names the pane, the cause, and the way out. */
export function selfHostRefusalMessage(refusal: SelfHostRefusal): string {
  return (
    `Refusing to start: this shell is a Cookrew terminal (${refusal.terminalId}) hosted by the ` +
    `'${refusal.session}' session this instance would adopt. Booting here makes the app take over ` +
    `its own launcher's pane and kill itself about a minute in. Launch it from a terminal outside ` +
    `Cookrew instead.`
  )
}
