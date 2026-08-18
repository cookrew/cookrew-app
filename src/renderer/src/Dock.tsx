import type { ToolId } from './canvas-ui'
import type { TerminalActivity } from '../../shared/turn'
import type { AgentRole } from '../../shared/model'
import { VoiceBar } from './VoiceBar'
import { CrIcon, type CrIconName } from './icons'
import { AgentSprite } from './nodes/AgentSprite'
import { RoleAvatar } from './nodes/RoleAvatar'

/**
 * Placement tools only. There is no MOVE button: the resting hand (pan,
 * drag, click to zoom) is what every tool falls back to — re-clicking the
 * active tool stands it down. The clipboard is not a tool either but a
 * TOGGLE over the resting hand (the board view's model), rendered next to
 * the tools with a pressed state rather than among them.
 */
const TOOLS: { id: ToolId; label: string; icon: CrIconName }[] = [
  { id: 'terminal', label: 'TERMINAL', icon: 'terminal' },
  { id: 'note', label: 'NOTE', icon: 'note' },
  { id: 'browser', label: 'BROWSER', icon: 'browser' },
  { id: 'connect', label: 'CONNECT', icon: 'connect' }
]

const HINTS: Partial<Record<ToolId, string>> = {
  terminal: 'PICK A PRESET, THEN CLICK THE CANVAS TO PLACE THE TERMINAL',
  note: 'CLICK THE CANVAS TO PLACE A NOTE',
  browser: 'CLICK THE CANVAS TO PLACE A BROWSER'
}

interface DockProps {
  tool: ToolId
  onSelect: (tool: ToolId) => void
  /** Clipboard selection mode — the toggle sitting beside the tools. */
  clipping: boolean
  onToggleClipping: () => void
  presets: string[]
  preset: string
  onPreset: (name: string) => void
  /** Saved roles offered alongside presets for TERMINAL placement. */
  roles: AgentRole[]
  /** Selected role name, or null when a plain preset is selected. */
  role: string | null
  onRole: (name: string) => void
  orch: boolean
  onOrch: (on: boolean) => void
  connectHint: string | null
  /** Zoomed-in terminal: the dock swaps the tool group for its composer. */
  voiceFor: { id: string; activity: TerminalActivity | undefined } | null
  /**
   * Zoomed-in browser: the whole bar stands down so the page keeps its height.
   * The controls that DO apply there (viewport fit, keyboard, open in browser)
   * float translucently over the frame instead.
   */
  browserFor: { id: string; url: string } | null
  /**
   * BOARD view: the canvas tools glide out (same motion as zooming a
   * terminal) and the board's one control glides in — the clipboard
   * selection toggle, wearing the same glyph as the canvas CLIPBOARD tool.
   */
  boardFor: { editing: boolean; onToggle: () => void } | null
}

/**
 * Cookrew-style bottom dock, one bar with two sliding groups. On the
 * canvas: the tool group (left) plus preset chips and hint. Zoomed into a
 * terminal: the tools glide out left and the send group (attach / mic /
 * speak / send — no input box, the terminal itself is the input) glides
 * in from the right. Zoomed into a browser the bar is absent entirely —
 * see the early return.
 */
export function Dock({
  tool,
  onSelect,
  clipping,
  onToggleClipping,
  presets,
  preset,
  onPreset,
  roles,
  role,
  onRole,
  orch,
  onOrch,
  connectHint,
  voiceFor,
  browserFor,
  boardFor
}: DockProps): React.JSX.Element {
  const hint = tool === 'connect' ? connectHint : (HINTS[tool] ?? null)
  /** Either occupant of the slide-in pane parks the canvas tools. */
  const slidIn = voiceFor !== null || boardFor !== null
  // Riding above the keyboard is no longer the dock's own job. It used to lift
  // itself with a `bottom` offset while the shell kept full height, so the dock
  // cleared the keyboard but the stage behind it did not — the terminal stayed
  // tall and its prompt line stayed buried. The shell now gives up the covered
  // band (keyboard auto-rise, .cr-app in styles.css) and the dock comes along
  // as its last flex row. Keeping the old offset too would lift it twice.
  //
  // A zoomed browser has no use for ANY of this — every tool places something
  // on a canvas the page is covering — so the bar leaves entirely and gives its
  // height back to the page. The browser's own controls float over the frame.
  // (This early return is why the keyboard hook cannot live here: it would stop
  // running for a zoomed browser, exactly where the remote keyboard is used.)
  if (browserFor) return <></>
  return (
    <footer className={`cr-dock${slidIn ? ' zoomed' : ''}`}>
      <div className="dock-pane dock-canvas" aria-hidden={slidIn}>
        <div className="cr-dock-tools">
          {/* The clipboard toggle leads the tools: it is the one control
              that is NOT a tool, so it wears a pressed state instead of
              the active-tool highlight — the same glyph and contract as
              the board view's selection toggle. */}
          <button
            className={`cr-btn tool icon${clipping ? ' primary' : ''}`}
            title={clipping ? 'Done selecting' : 'Select cards — click to pick, click again to cancel'}
            aria-label="CLIPBOARD"
            aria-pressed={clipping}
            tabIndex={slidIn ? -1 : 0}
            onClick={onToggleClipping}
          >
            <CrIcon name="clipboard" className="tool-icon" />
          </button>
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`cr-btn tool icon${tool === t.id ? ' primary' : ''}`}
              title={t.label}
              aria-label={t.label}
              tabIndex={slidIn ? -1 : 0}
              onClick={() => onSelect(t.id)}
            >
              <CrIcon name={t.icon} className="tool-icon" />
            </button>
          ))}
        </div>
        {!slidIn && tool === 'terminal' && (
          <div className="cr-dock-presets">
            {presets.map((name) => (
              <button
                key={name}
                className={`cr-chip clickable${role === null && preset === name ? ' amber' : ''}`}
                onClick={() => onPreset(name)}
              >
                <AgentSprite preset={name} /> {name}
              </button>
            ))}
            {roles.map((r) => (
              <button
                key={r.name}
                className={`cr-chip clickable role-chip${role === r.name ? ' amber' : ''}`}
                title={`Role · boots ${r.preset} with the “${r.name}” prompt`}
                onClick={() => onRole(r.name)}
              >
                <RoleAvatar name={r.name} className="role-chip-avatar" /> {r.name}
              </button>
            ))}
            <label className="cr-check">
              <input type="checkbox" checked={orch} onChange={(e) => onOrch(e.target.checked)} />
              ORCH
            </label>
          </div>
        )}
        {!slidIn && hint && <div className="cr-dock-hint">{hint}</div>}      </div>
      <div className="dock-pane dock-send" aria-hidden={!slidIn}>
        {voiceFor && (
          <VoiceBar key={voiceFor.id} terminalId={voiceFor.id} activity={voiceFor.activity} />
        )}
        {!voiceFor && boardFor && (
          <button
            className={`cr-btn tool icon${boardFor.editing ? ' primary' : ''}`}
            title={
              boardFor.editing
                ? 'Done selecting'
                : 'Select elements — the same selection the canvas clipboard toggle uses'
            }
            aria-pressed={boardFor.editing}
            onClick={boardFor.onToggle}
          >
            <CrIcon name="clipboard" />
          </button>
        )}
      </div>
    </footer>
  )
}
