import type { ToolId } from './canvas-ui'

const TOOLS: { id: ToolId; label: string; icon: string }[] = [
  { id: 'select', label: 'SELECT', icon: '▲' },
  { id: 'terminal', label: 'TERMINAL', icon: '▮' },
  { id: 'note', label: 'NOTE', icon: '✎' },
  { id: 'browser', label: 'BROWSER', icon: '◍' },
  { id: 'connect', label: 'CONNECT', icon: '∿' }
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
}

/** Cookrew-style bottom dock: tool dial + preset chips + contextual hint. */
export function Dock({
  tool,
  onSelect,
  presets,
  preset,
  onPreset,
  orch,
  onOrch,
  connectHint
}: DockProps): React.JSX.Element {
  const hint = tool === 'connect' ? connectHint : (HINTS[tool] ?? null)
  return (
    <footer className="cr-dock">
      <div className="cr-dock-tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`cr-btn tool icon${tool === t.id ? ' primary' : ''}`}
            title={t.label}
            aria-label={t.label}
            onClick={() => onSelect(t.id)}
          >
            <span className="tool-icon">{t.icon}</span>
          </button>
        ))}
      </div>
      {tool === 'terminal' && (
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
      {hint && <div className="cr-dock-hint">{hint}</div>}
    </footer>
  )
}
