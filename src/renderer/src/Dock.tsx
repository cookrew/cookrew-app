import type { ToolId } from './canvas-ui'
import type { TerminalActivity } from '../../shared/turn'
import { VoiceBar } from './VoiceBar'
import { CrIcon, type CrIconName } from './icons'

const TOOLS: { id: ToolId; label: string; icon: CrIconName }[] = [
  { id: 'select', label: 'SELECT', icon: 'select' },
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
  presets: string[]
  preset: string
  onPreset: (name: string) => void
  orch: boolean
  onOrch: (on: boolean) => void
  connectHint: string | null
  /** Zoomed-in terminal: the dock swaps the tool group for its composer. */
  voiceFor: { id: string; activity: TerminalActivity | undefined } | null
}

/**
 * Cookrew-style bottom dock, one bar with two sliding groups. On the
 * canvas: the tool group (left) plus preset chips and hint. Zoomed into a
 * terminal: the tools glide out left and the send group (attach / mic /
 * speak / send — no input box, the terminal itself is the input) glides
 * in from the right.
 */
export function Dock({
  tool,
  onSelect,
  presets,
  preset,
  onPreset,
  orch,
  onOrch,
  connectHint,
  voiceFor
}: DockProps): React.JSX.Element {
  const hint = tool === 'connect' ? connectHint : (HINTS[tool] ?? null)
  return (
    <footer className={`cr-dock${voiceFor ? ' zoomed' : ''}`}>
      <div className="dock-pane dock-canvas" aria-hidden={voiceFor !== null}>
        <div className="cr-dock-tools">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`cr-btn tool icon${tool === t.id ? ' primary' : ''}`}
              title={t.label}
              aria-label={t.label}
              tabIndex={voiceFor ? -1 : 0}
              onClick={() => onSelect(t.id)}
            >
              <CrIcon name={t.icon} className="tool-icon" />
            </button>
          ))}
        </div>
        {!voiceFor && tool === 'terminal' && (
          <div className="cr-dock-presets">
            {presets.map((name) => (
              <button
                key={name}
                className={`cr-chip clickable${preset === name ? ' amber' : ''}`}
                onClick={() => onPreset(name)}
              >
                {name}
              </button>
            ))}
            <label className="cr-check">
              <input type="checkbox" checked={orch} onChange={(e) => onOrch(e.target.checked)} />
              ORCH
            </label>
          </div>
        )}
        {!voiceFor && hint && <div className="cr-dock-hint">{hint}</div>}
      </div>
      <div className="dock-pane dock-send" aria-hidden={voiceFor === null}>
        {voiceFor && (
          <VoiceBar key={voiceFor.id} terminalId={voiceFor.id} activity={voiceFor.activity} />
        )}
      </div>
    </footer>
  )
}
