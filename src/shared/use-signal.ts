import type { CardControl, RemoteState } from './remote-access'
import type { Use } from './use-url'

/**
 * WHAT A USE LOOKS LIKE WHILE IT HAPPENS.
 *
 * The owner's picture: when an agent acts on a resource, its cursor leaves
 * the agent (the pet) and moves over the screen it is acting on; idle, it
 * goes back. Two sources feed that:
 *
 *   A UseSignal, minted by Cookrew itself when an agent drives a card through
 *   `cookrew browser` (headless-browser-command.ts). It knows the card and,
 *   for a pointed action, the point in the card's viewport — so the cursor
 *   lands where the click landed.
 *
 *   useOfToolCall, for uses Cookrew does not carry: a Chrome MCP, a
 *   computer-use tool, `adb`, a serial console, a flasher. Those never touch
 *   a card, so there is no point — only "agent X is using a phone right now",
 *   which the pet shows on itself. That is the honest fidelity of an action
 *   Cookrew only reads about in the transcript.
 */

export interface UsePoint {
  readonly x: number
  readonly y: number
}

export interface UseSignal {
  /** The acting terminal's node id. */
  readonly agent: string
  /** The browser card acted on. */
  readonly card: string
  readonly use: Use
  /** tap, type, key, scroll, navigate, screenshot, click, fill… */
  readonly verb: string
  /** In the card's viewport points; null for an action with no place (a key, a navigate). */
  readonly point: UsePoint | null
  /** The viewport the point is in, so a viewer of any size can place it. */
  readonly viewport: { readonly width: number; readonly height: number } | null
  readonly at: number
}

/** A card's device, as the cast tells its viewers (`{t: 'status'}`). */
export interface UseStatus {
  readonly state: 'connecting' | 'live' | 'offline'
  /** Why it is offline, in a sentence the owner can act on. */
  readonly message: string | null
  readonly use: Exclude<Use, 'browser'>
  /** Whether this card takes input from a viewer at all. */
  readonly input: boolean
  /** What this card was bound to has gone for good: it will not come back, so the viewer offers something else. */
  readonly gone?: 'window'
  /** A computer's screen: where it stands, for the card to say in full (shared/remote-access.ts). */
  readonly remote?: RemoteState
  /** What this viewer may do with this card. Its own: main fills it in per viewer. */
  readonly control?: CardControl
}

const USES: readonly Use[] = ['browser', 'computer', 'phone', 'hardware']
const VERB = /^[a-z][a-z-]{0,23}$/

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function isUseSignal(value: unknown): value is UseSignal {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  if (typeof s.agent !== 'string' || s.agent.length === 0 || s.agent.length > 128) return false
  if (typeof s.card !== 'string' || s.card.length === 0 || s.card.length > 128) return false
  if (!USES.includes(s.use as Use)) return false
  if (typeof s.verb !== 'string' || !VERB.test(s.verb)) return false
  if (!finite(s.at)) return false
  if (s.point !== null) {
    const p = s.point as Record<string, unknown> | undefined
    if (!p || !finite(p.x) || !finite(p.y)) return false
  }
  if (s.viewport !== null) {
    const v = s.viewport as Record<string, unknown> | undefined
    if (!v || !finite(v.width) || !finite(v.height) || v.width <= 0 || v.height <= 0) return false
  }
  return true
}

/** Where a point sits in the viewport, as fractions — what a viewer of any size draws from. */
export function useFraction(signal: Pick<UseSignal, 'point' | 'viewport'>): UsePoint | null {
  if (!signal.point || !signal.viewport) return null
  const clamp = (n: number): number => Math.min(1, Math.max(0, n))
  return { x: clamp(signal.point.x / signal.viewport.width), y: clamp(signal.point.y / signal.viewport.height) }
}

export interface ToolUse {
  readonly use: Use
  /** A short word for the pet's badge: "adb", "chrome", "serial"… */
  readonly via: string
}

const TOOL_RULES: ReadonlyArray<{ re: RegExp; use: Use; via: string }> = [
  { re: /^mcp__(claude-in-chrome|chrome-devtools|playwright|puppeteer|browserbase|browser-use)__/i, use: 'browser', via: 'chrome' },
  { re: /^mcp__[\w-]*computer[\w-]*__|^computer$/i, use: 'computer', via: 'computer' },
  { re: /^mcp__[\w-]*(android|adb|mobile|ios-simulator|appium)[\w-]*__/i, use: 'phone', via: 'phone' },
  { re: /^mcp__[\w-]*(serial|arduino|esp|gpio|hardware|robot)[\w-]*__/i, use: 'hardware', via: 'hardware' }
]

/** Shell commands, matched at the start of the command or after a pipe, `&&`, `;` or `sudo`. */
const COMMAND_RULES: ReadonlyArray<{ re: RegExp; use: Use; via: string }> = [
  { re: /(?:^|[|&;]\s*|sudo\s+)(?:cookrew|opencli)\s+browser\b|(?:^|[|&;]\s*)(?:npx\s+)?(?:agent-browser|playwright)\b/, use: 'browser', via: 'browser' },
  { re: /(?:^|[|&;]\s*|sudo\s+)(?:adb|scrcpy|maestro)\b/, use: 'phone', via: 'adb' },
  { re: /(?:^|[|&;]\s*|sudo\s+)(?:idevice\w*|vphone-cli|xcrun\s+simctl|xcrun\s+devicectl)\b/, use: 'phone', via: 'ios' },
  { re: /(?:^|[|&;]\s*|sudo\s+)(?:esptool(?:\.py)?|arduino-cli|pio|platformio|openocd|probe-rs|mpremote|ampy|avrdude|st-flash|dfu-util)\b/, use: 'hardware', via: 'flash' },
  { re: /(?:^|[|&;]\s*|sudo\s+)(?:picocom|minicom|screen|cu|tio)\s+\/dev\/|\/dev\/(?:tty|cu)\.(?:usb|wch|SLAB)/, use: 'hardware', via: 'serial' },
  { re: /(?:^|[|&;]\s*|sudo\s+)(?:screencapture|cliclick)\b|osascript\b.*\b(?:click|keystroke|System Events)\b/, use: 'computer', via: 'mac' }
]

/** The use a tool call is, or null when it is not one (reading a file, editing code). */
export function useOfToolCall(tool: string, args: string): ToolUse | null {
  for (const rule of TOOL_RULES) if (rule.re.test(tool)) return { use: rule.use, via: rule.via }
  if (tool !== 'Bash' && tool !== 'bash' && tool !== 'shell' && tool !== 'exec_command') return null
  const command = args.trim()
  for (const rule of COMMAND_RULES) if (rule.re.test(command)) return { use: rule.use, via: rule.via }
  return null
}

/**
 * The same, read off a tool line as the agent's terminal shows it — the
 * glance the live tracker keeps (shared/turn.ts · parseAgentGlance):
 * `Bash(adb shell input tap 10 20)`, `claude-in-chrome - navigate (MCP)(…)`,
 * Codex's `Ran adb shell …`. This is what a pet can know while the agent
 * works, before any transcript is read.
 */
export function useOfToolLine(line: string): ToolUse | null {
  const text = line.trim()
  const mcp = /^([\w.-]+) - ([\w.-]+) \(MCP\)/.exec(text)
  if (mcp) return useOfToolCall(`mcp__${mcp[1]}__${mcp[2]}`, '')
  const ran = /^Ran\s+(.+)$/.exec(text)
  if (ran) return useOfToolCall('Bash', ran[1])
  const call = /^([\w.-]+)\((.*)\)?$/s.exec(text)
  if (call) return useOfToolCall(call[1], call[2] ?? '')
  return null
}

