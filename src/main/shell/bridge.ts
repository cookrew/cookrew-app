/**
 * THE SHELL'S BRIDGE, without Electron (shell/index.ts wires it to the window).
 *
 * The daemon treats every request on the owner link as the owner window's
 * (owner-link.ts), so THIS is where "is it the owner?" is decided, exactly as
 * the old main decided it per call (index.ts · ownerFrame): the sender is the
 * owner window's webContents, the call comes from its top frame, and that
 * frame shows the owner page. Anything else is refused here and never reaches
 * the daemon. Pure, so the rule is tested without a window.
 */
import { isOwnerPage, isOwnerSender } from '../owner-grant'
import type { OwnerClient } from '../daemon/owner-client'

/** What an Electron IPC event carries that the owner check reads. */
export interface CallerEvent {
  readonly sender: unknown
  readonly senderFrame: { readonly parent: unknown; readonly url?: string } | null | undefined
}

/** The owner window's top frame, on the owner page; nothing else. */
export function isOwnerCall(event: CallerEvent, ownerContents: unknown, ownerUrl: string): boolean {
  if (ownerContents === null || ownerContents === undefined) return false
  return isOwnerSender(event.sender, event.senderFrame ?? null, ownerContents) && isOwnerPage(event.senderFrame?.url, ownerUrl)
}

/** The part of ipcMain the bridge registers on (injected for tests). */
export interface IpcLike {
  handle(channel: string, listener: (event: CallerEvent, ...args: unknown[]) => unknown): void
  on(channel: string, listener: (event: CallerEvent, ...args: unknown[]) => void): void
}

export interface BridgeOptions {
  readonly ipc: IpcLike
  readonly client: Pick<OwnerClient, 'invoke' | 'send'>
  readonly channels: { readonly handle: readonly string[]; readonly on: readonly string[] }
  /** Answered here, not by the daemon (they need the window or a person). */
  readonly localHandlers: Readonly<Record<string, (...args: unknown[]) => unknown>>
  readonly localSends: Readonly<Record<string, (...args: unknown[]) => void>>
  /** Is this call the owner's (isOwnerCall with the live window). */
  readonly isOwner: (event: CallerEvent) => boolean
  readonly log?: (line: string) => void
}

export const NOT_OWNER = 'refused: the caller is not the owner window'

/** One forwarder per channel, local ones first; a non-owner call is refused before it crosses. */
export function registerBridge(options: BridgeOptions): { handle: number; on: number } {
  const log = options.log ?? console.error
  const handle = new Set([...options.channels.handle, ...Object.keys(options.localHandlers)])
  const on = new Set([...options.channels.on, ...Object.keys(options.localSends)])
  for (const channel of handle) {
    const local = options.localHandlers[channel]
    options.ipc.handle(channel, (event, ...args) => {
      if (!options.isOwner(event)) {
        log(`[cookrew shell] ${channel}: ${NOT_OWNER}`)
        throw new Error(NOT_OWNER)
      }
      return local ? local(...args) : options.client.invoke(channel, args)
    })
  }
  for (const channel of on) {
    const local = options.localSends[channel]
    options.ipc.on(channel, (event, ...args) => {
      if (!options.isOwner(event)) {
        log(`[cookrew shell] ${channel}: ${NOT_OWNER}`)
        return
      }
      if (local) local(...args)
      else options.client.send(channel, args)
    })
  }
  return { handle: handle.size, on: on.size }
}

/**
 * The daemon's window events, held until the page that listens for them has
 * loaded (the old main's events reached a renderer that was already there),
 * then delivered in order. Bounded: a page that never loads costs nothing.
 */
export class HeldEvents {
  private held: { channel: string; args: readonly unknown[] }[] = []
  private dropped = 0
  private deliver: ((channel: string, args: readonly unknown[]) => void) | null = null

  constructor(private readonly max = 5000) {}

  push(channel: string, args: readonly unknown[]): void {
    if (this.deliver !== null) {
      this.deliver(channel, args)
      return
    }
    // Private and appended in place: a copy per event would be quadratic over a long boot.
    if (this.held.length < this.max) this.held.push({ channel, args })
    else this.dropped += 1
  }

  /** The page is up: hand over what was held, then deliver as events come. Answers how many were dropped. */
  open(deliver: (channel: string, args: readonly unknown[]) => void): number {
    this.deliver = deliver
    const held = this.held
    this.held = []
    for (const event of held) deliver(event.channel, event.args)
    const dropped = this.dropped
    this.dropped = 0
    return dropped
  }
}

/**
 * The real window's lifecycle, told to the daemon so main's own listeners on
 * its owner window still run (index.ts · createWindow): focus is presence for
 * the idle lock and clears the notifications; did-finish-load readies deep
 * links; a reload or a crashed renderer releases the page's subscriptions.
 * Only these names cross; the daemon refuses any other (electron-shim.ts).
 */
export const FORWARDED_WINDOW_EVENTS = ['focus', 'blur', 'show', 'hide', 'minimize', 'restore', 'closed'] as const
export const FORWARDED_CONTENTS_EVENTS = ['did-finish-load', 'dom-ready', 'did-start-navigation', 'render-process-gone', 'destroyed'] as const
