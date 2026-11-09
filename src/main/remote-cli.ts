import { machineCopy } from '../shared/machine-words'
import { hostWords, LINUX_NO_XDOTOOL, remoteView, type RemoteAccess, type RemoteAnswer, type RemoteHostView } from '../shared/remote-access'
import type { CliRequest } from '../shared/model'

/**
 * `cookrew remote on|off|status|stop`: THE MACHINE SWITCH FROM A SHELL ON THE MACHINE.
 *
 * A headless Linux box has no one at its screen, so "someone at the machine"
 * includes a shell on it (an ssh login). The switch still has no route from
 * another device, and this verb is shaped to keep it that way:
 *
 *   ON comes only from a plain shell. A Cookrew terminal is refused, by its
 *   terminal id or by the agent session in its process tree, because a paired
 *   device can type into one, and that would be the switch flipped from
 *   another device. The CLI also asks at the terminal first and sends
 *   `confirmed` only after a person typed it; with no terminal it refuses.
 *   On a Mac the machine's own confirmation (Touch ID) is asked as well.
 *
 *   OFF, STOP and STATUS work from anywhere on the machine: turning things off
 *   is always allowed, and Stop is the headless box's banner button.
 *
 * THE LIMIT, SAID PLAINLY: every check above is made by programs running as
 * this user, from what the client says about itself (an env var, its process
 * tree, its terminal). A paired device typing into a Cookrew terminal already
 * runs code as this user: it can unset the env var and answer the prompt, and on
 * X11 it could run xdotool itself without any switch. The pane refusal closes the
 * obvious path and stops an agent turning it on by accident, nothing more. A real
 * boundary would ask the kernel who the socket's peer is (SO_PEERCRED) and refuse
 * a descendant of the terminal host; that is an open question for the owner.
 */

export const REMOTE_USAGE = 'usage: cookrew remote on|off|status|stop'
export const REMOTE_FROM_PANE =
  'Turn remote control on from a shell on this machine, not from a Cookrew terminal: a paired device can type into a Cookrew terminal, and this switch is only for someone at the machine.'
export const REMOTE_NOT_CONFIRMED = 'cookrew remote on asks before it turns anything on: run it in a terminal on this machine and confirm it there.'
const HOW = 'from a shell on this machine'

export interface RemoteCliDeps {
  readonly platform: string
  access(): Promise<RemoteAccess>
  hostView(): RemoteHostView
  setSwitch(on: boolean, how: string): RemoteAnswer
  /** The machine's own confirmation: Touch ID on a Mac. Elsewhere the terminal's prompt was it. */
  confirmOn(): Promise<boolean>
  stopAll(): void
}

const fromPane = (request: CliRequest): boolean => request.terminalId !== '' || (typeof request.sessionId === 'string' && request.sessionId !== '')

/** The answer's own sentence when it did not save; nothing when it did. */
const unsaved = (answer: RemoteAnswer): readonly string[] => (answer.ok ? [] : [answer.error])

function handLine(access: RemoteAccess, platform: string): string {
  if (access.control.accessibility) return 'Input: ready'
  if (access.state.platform === 'linux') return `Input: ${LINUX_NO_XDOTOOL}`
  return machineCopy('Input: Accessibility is off, so nothing can click or type on this Mac yet.', platform)
}

async function turnOn(request: CliRequest, deps: RemoteCliDeps): Promise<string> {
  const word = (sentence: string): string => machineCopy(sentence, deps.platform)
  if (fromPane(request)) throw new Error(REMOTE_FROM_PANE)
  if (request.flags.confirmed !== true) throw new Error(REMOTE_NOT_CONFIRMED)
  const before = await deps.access()
  if (!before.control.available) throw new Error(word(`Remote control is not available on this Mac: ${remoteView(before.state, 'here').sentence}`))
  if (!(await deps.confirmOn())) throw new Error(word('Remote control stays off: it was not confirmed at the Mac.'))
  const answer = deps.setSwitch(true, HOW)
  const lines = [
    word('Remote control of this Mac is on. Your paired devices can take control of a card for 15 minutes, and agents can click and type here. Turn it off with cookrew remote off.'),
    ...unsaved(answer)
  ]
  if (!before.control.accessibility) lines.push(handLine(before, deps.platform))
  return lines.join('\n')
}

async function status(deps: RemoteCliDeps): Promise<string> {
  const access = await deps.access()
  const view = remoteView(access.state, 'here')
  const rows = hostWords(deps.hostView(), deps.platform)?.rows ?? []
  return [
    machineCopy(`Remote control of this Mac: ${access.control.available ? (access.control.switchOn ? 'on' : 'off') : 'not available'}`, deps.platform),
    `Screen: ${view.title}. ${view.sentence}`,
    ...(access.control.available ? [handLine(access, deps.platform)] : []),
    rows.length > 0 ? `On it now: ${rows.join('; ')}` : 'On it now: nobody'
  ].join('\n')
}

export async function cmdRemote(request: CliRequest, deps: RemoteCliDeps): Promise<string> {
  const [verb = 'status', ...rest] = request.args
  if (rest.length > 0) throw new Error(REMOTE_USAGE)
  const word = (sentence: string): string => machineCopy(sentence, deps.platform)
  switch (verb) {
    case 'on':
      return turnOn(request, deps)
    case 'off':
      return [word('Remote control of this Mac is off. Every grant has ended.'), ...unsaved(deps.setSwitch(false, HOW))].join('\n')
    case 'stop':
      deps.stopAll()
      return word('Stopped: every remote session on this Mac has ended, and devices away stay out for 10 minutes.')
    case 'status':
      return status(deps)
    default:
      throw new Error(REMOTE_USAGE)
  }
}
