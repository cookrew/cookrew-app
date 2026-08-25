import type { ToolId } from './canvas-ui'
import type { TerminalActivity } from '../../shared/turn'
import type { AgentRole } from '../../shared/model'
import { useEffect } from 'react'
import { VoiceBar } from './VoiceBar'
import { useKeyboardInset } from './keyboard-inset'
import {
  chipAction,
  presetChips,
  presetsNeedingUpdateCheck,
  type InstalledPreset
} from '../../shared/preset-chip'
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
  /**
   * Marketplace presets — the third chip family (§8). Defaults to empty, so
   * the dock is unchanged on a machine that has installed none.
   */
  installedPresets?: InstalledPreset[]
  /** Selected marketplace preset id, or null when a harness/role chip owns it. */
  presetId?: string | null
  /** Owned chip: arm placement. The canvas click is the confirm (R2). */
  onPresetChip?: (id: string) => void
  /** Locked chip: the chip is the gate's UI — open the 401/402/403 sheet. */
  onPresetGate?: (id: string) => void
  /** Chip that just refused a click, so it can say so (N4). */
  gatedPresetId?: string | null
  /** R3: ids whose version the dock should HEAD, emitted once on open. */
  onCheckUpdates?: (ids: string[]) => void
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
  installedPresets = [],
  presetId = null,
  onPresetChip,
  onPresetGate,
  gatedPresetId = null,
  onCheckUpdates,
  voiceFor,
  browserFor,
  boardFor
}: DockProps): React.JSX.Element {
  const hint = tool === 'connect' ? connectHint : (HINTS[tool] ?? null)
  /** Either occupant of the slide-in pane parks the canvas tools. */
  const slidIn = voiceFor !== null || boardFor !== null
  const chips = presetChips(installedPresets)
  // R3: the update check runs when the dock OPENS, not on a timer. "Open" here
  // is the terminal chip row becoming visible — a background poll would spend
  // requests on a dock nobody is looking at, and the answer is only ever acted
  // on while it is. Re-renders do not re-ask: presetsNeedingUpdateCheck returns
  // only the ones still unanswered.
  const chipRowOpen = !slidIn && tool === 'terminal'
  useEffect(() => {
    if (!chipRowOpen || !onCheckUpdates) return
    const pending = presetsNeedingUpdateCheck(installedPresets)
    if (pending.length > 0) onCheckUpdates(pending)
  }, [chipRowOpen, installedPresets, onCheckUpdates])
  // Ride above the on-screen keyboard (Defect 2). The lift itself now lives in
  // CSS (`.cr-dock` reads `--kb-inset`), which this hook publishes; the zoomed
  // terminal overlay rises off the SAME variable, so the bar and the transcript
  // cannot drift apart the way a JS offset here and a CSS one there could. The
  // returned value is unused — the hook is called for its effect.
  useKeyboardInset()
  // A zoomed browser has no use for ANY of this — every tool places something
  // on a canvas the page is covering — so the bar leaves entirely and gives its
  // height back to the page. The browser's own controls float over the frame.
  // (After every hook: an early return above one breaks the Rules of Hooks.)
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
            {/* THIRD FAMILY (§8): marketplace presets. Same chip grammar as the
                two groups above — a locked chip is not a disabled chip, it is
                the gate's own UI, so it stays clickable and opens the sheet. */}
            {chips.map((chip) => (
              <button
                key={chip.id}
                className={`cr-chip clickable preset-chip${presetId === chip.id ? ' amber' : ''}${
                  chip.badge === 'lock' ? ' locked' : ''
                }${gatedPresetId === chip.id ? ' gate-denied' : ''}`}
                title={
                  chip.badge === 'lock'
                    ? `${chip.label} — locked`
                    : chip.badge === 'update'
                      ? `${chip.label} — v${chip.headVersion} available`
                      : chip.label
                }
                aria-label={chip.label}
                onClick={() =>
                  chipAction(chip) === 'gate' ? onPresetGate?.(chip.id) : onPresetChip?.(chip.id)
                }
              >
                <span className={`preset-chip-sprites${chip.kind === 'team' ? ' stacked' : ''}`}>
                  {/* A team wears a STACK; more than three would stop reading as
                      a stack and start reading as a row, so the rest are a count
                      in the title instead. */}
                  {chip.sprites.slice(0, 3).map((sprite, i) => (
                    <AgentSprite key={`${chip.id}-${i}`} preset={sprite} />
                  ))}
                </span>
                {chip.label}
                {/* The acknowledgement a locked click gets until the gate sheet
                    exists. aria-live so it is announced, not just drawn. */}
                {gatedPresetId === chip.id && (
                  <span className="preset-chip-gate-note" role="status" aria-live="polite">
                    LOCKED
                  </span>
                )}
                {chip.badge === 'lock' && <CrIcon name="lock" className="preset-chip-badge lock" />}
                {chip.badge === 'update' && <span className="preset-chip-badge update" />}
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
