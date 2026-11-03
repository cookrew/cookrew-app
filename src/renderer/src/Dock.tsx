import { CANVAS_RETIRED, type ToolId } from './canvas-ui'
import type { AgentRole, CanvasNode } from '../../shared/model'
import { GlobalPrompt, type PromptAgent } from './prompt/GlobalPrompt'
import { SHELL_PRESET } from './prompt/harness-pref'
import type { PromptArtifact } from './prompt/artifact-refs'
import { useKeyboardInset } from './keyboard-inset'
import { CrIcon, type CrIconName } from './icons'
import { AgentSprite } from './nodes/AgentSprite'
import { RoleAvatar } from './nodes/RoleAvatar'

/** What a dock button does: open the preset row, or make its card at once. */
export type DockTool =
  | { id: 'terminal'; label: string; title: string; icon: CrIconName; act: 'arm'; canvasOnly: true }
  | { id: 'note' | 'browser'; label: string; title: string; icon: CrIconName; act: 'make'; canvasOnly: true }
  | { id: 'connect'; label: string; title: string; icon: CrIconName; act: 'arm'; canvasOnly: true }

/**
 * There is no MOVE button: the resting hand is what every tool falls back to
 * — re-clicking the active tool stands it down. TERMINAL opens the preset row
 * and a chip there makes the agent; NOTE and BROWSER make their card at once.
 * CONNECT needs canvas cards to wire, so it is left out while the canvas is
 * retired, and so is the clipboard toggle (not a tool, a pressed TOGGLE over
 * the resting hand, rendered before the tools).
 *
 * NOTE and BROWSER are left out too (owner, 2026-11-01): a note or a browser
 * is made inside an agent, from its full view's browsers-and-notes column
 * (stage/AgentArtifacts.tsx), so it is wired to the agent that holds it.
 *
 * And so is TERMINAL (owner, 2026-11-01): the prompt box's ＋ menu
 * (prompt/HarnessMenu.tsx) carries the harnesses, a bare shell and the roles;
 * the saved teams, the import and ORCH are retired from it (owner, 2026-11-03). Its row below only
 * opens on a canvas brought back, where TERMINAL arms a placement.
 */
const TOOLS: readonly DockTool[] = [
  { id: 'terminal', label: 'TERMINAL', title: 'New agent — pick a harness, role or team', icon: 'terminal', act: 'arm', canvasOnly: true },
  { id: 'note', label: 'NOTE', title: 'New note in this workspace', icon: 'note', act: 'make', canvasOnly: true },
  { id: 'browser', label: 'BROWSER', title: 'New browser in this workspace', icon: 'browser', act: 'make', canvasOnly: true },
  { id: 'connect', label: 'CONNECT', title: 'CONNECT', icon: 'connect', act: 'arm', canvasOnly: true }
]

/** The dock's buttons, minus the ones that only act on a canvas while it is retired. */
export function dockTools(retired: boolean = CANVAS_RETIRED): readonly DockTool[] {
  return retired ? TOOLS.filter((t) => !('canvasOnly' in t)) : TOOLS
}

const HINTS: Partial<Record<ToolId, string>> = {
  terminal: 'PICK ONE TO ADD IT HERE NOW · TICK ORCH FIRST FOR A LEAD'
}

/**
 * What each run of chips IS. Four different acts wore one chip: booting a
 * harness here, opening a session of a team you saved, placing something you
 * installed, and reaching a team that runs on someone else's machine. Naming
 * the families is the whole change — the chips themselves keep their grammar.
 */
const DOCK_FAMILY = {
  harness: 'AGENT',
  roles: 'ROLE',
  teams: 'YOUR TEAMS',
  import: '+ IMPORT A TEAM'
} as const

interface DockProps {
  tool: ToolId
  onSelect: (tool: ToolId) => void
  /** Clipboard selection mode — the toggle sitting beside the tools. */
  clipping: boolean
  onToggleClipping: () => void
  presets: string[]
  /** Which of `presets` are saved TEAMS — placing one opens a session. */
  templates?: readonly string[]
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
  /** NOTE / BROWSER: make the card at once in the active workspace. */
  onMake: (kind: 'note' | 'browser') => void
  /** A card is being made: the chips hold still so one press makes one. */
  making?: boolean
  /** Why the last card could not be made; shown where the hint is. */
  makeError?: string | null
  /** Import a served team by its address — places ONE orch interface card. */
  onImportServed?: () => void
  /** Zoomed-in terminal: the global prompt carries @agent for it. */
  voiceFor: { id: string; remote: boolean } | null
  /** This workspace's agents: the prompt's @names and its targets. */
  agents: readonly PromptAgent[]
  /** This workspace's cards: a new agent is stored beside them. */
  nodes: readonly CanvasNode[]
  /** The workspace's notes and browsers, for the prompt's "#Name". */
  artifacts?: readonly PromptArtifact[]
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
 * Cookrew-style bottom dock: the tool group, then THE GLOBAL PROMPT (owner,
 * 2026-11-01; prompt/GlobalPrompt.tsx) — one prompt box for the whole app,
 * carrying @agent in an agent's full view or open card, and making a new
 * agent from the prompt when there is none. The preset chips and the hint
 * wrap below. The board view still glides the tools out for its clipboard
 * toggle. Zoomed into a browser the bar is absent entirely — see the early
 * return.
 */
export function Dock({
  tool,
  onSelect,
  clipping,
  onToggleClipping,
  presets,
  templates = [],
  preset,
  onPreset,
  roles,
  role,
  onRole,
  orch,
  onOrch,
  connectHint,
  onMake,
  making = false,
  makeError = null,
  onImportServed,
  voiceFor,
  agents,
  nodes,
  artifacts,
  browserFor,
  boardFor
}: DockProps): React.JSX.Element {
  const hint = tool === 'connect' ? connectHint : (HINTS[tool] ?? null)
  /** The board's toggle parks the canvas tools; a full view no longer does. */
  const slidIn = boardFor !== null
  // `presets` arrives as harnesses AND saved teams in one list, because a
  // saved team IS a terminal preset to the placement path. To a person they
  // are not the same act at all — one boots an agent here, the other opens a
  // session of a team — so the row tells them apart by name.
  const savedTeams = presets.filter((name) => templates.includes(name))
  const harnesses = presets.filter((name) => !templates.includes(name))
  // A prompt is for an agent: a bare shell would run its words as a command,
  // so the box's menu offers it as an act, made at once.
  const promptHarnesses = harnesses.filter((name) => name !== SHELL_PRESET)
  const acts = {
    shell: harnesses.includes(SHELL_PRESET),
    roles: roles.map((r) => r.name),
    onPreset,
    onRole,
    making
  }
  const tools = dockTools()
  // Ride above the on-screen keyboard (Defect 2). The lift itself now lives in
  // CSS (`.cr-dock` reads `--kb-inset`), which this hook publishes; the zoomed
  // terminal overlay rises off the SAME variable, so the bar and the transcript
  // cannot drift apart the way a JS offset here and a CSS one there could. The
  // returned value is unused — the hook is called for its effect.
  useKeyboardInset()
  // A zoomed browser has no use for ANY of this — every tool makes something
  // the page would be covering — so the bar leaves entirely and gives its
  // height back to the page. The browser's own controls float over the frame.
  // (After every hook: an early return above one breaks the Rules of Hooks.)
  if (browserFor) return <></>
  return (
    <footer className={`cr-dock${slidIn ? ' zoomed' : ''}`}>
      <div className="dock-pane dock-canvas" aria-hidden={slidIn}>
        {(!CANVAS_RETIRED || tools.length > 0) && (
          <div className="cr-dock-tools">
            {/* The clipboard toggle leads the tools: it is the one control
                that is NOT a tool, so it wears a pressed state instead of
                the active-tool highlight — the same glyph and contract as
                the board view's selection toggle. Canvas cards only. */}
            {!CANVAS_RETIRED && (
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
            )}
            {tools.map((t) => (
              <button
                key={t.id}
                className={`cr-btn tool icon${t.act === 'arm' && tool === t.id ? ' primary' : ''}`}
                title={t.title}
                aria-label={t.label}
                tabIndex={slidIn ? -1 : 0}
                disabled={t.act === 'make' && making}
                onClick={() => (t.act === 'make' ? onMake(t.id) : onSelect(t.id))}
              >
                <CrIcon name={t.icon} className="tool-icon" />
              </button>
            ))}
          </div>
        )}
        {!slidIn && <GlobalPrompt fullAgentId={voiceFor?.id ?? null} agents={agents} harnesses={promptHarnesses} nodes={nodes} orch={orch} artifacts={artifacts} acts={acts} />}
        {!slidIn && tool === 'terminal' && (
          <div className="cr-dock-presets">
            {/* FAMILIES, SAID OUT LOUD.
                The row had grown to twenty-odd identical chips in which a
                harness (boots ONE agent here), a saved team (imports a whole
                session), an installed preset (someone else's, possibly locked)
                and the import entry were indistinguishable — and the entry, at
                the tail, moved every time a team was saved. The chips keep
                their grammar; what changes is that each family says what it is
                and holds its own place. */}
            <span className="cr-dock-family">{DOCK_FAMILY.harness}</span>
            {harnesses.map((name) => (
              <button
                key={name}
                className={`cr-chip clickable${role === null && preset === name ? ' amber' : ''}`}
                disabled={making}
                onClick={() => onPreset(name)}
              >
                <AgentSprite preset={name} /> {name}
              </button>
            ))}
            {roles.length > 0 && <span className="cr-dock-family">{DOCK_FAMILY.roles}</span>}
            {roles.map((r) => (
              <button
                key={r.name}
                className={`cr-chip clickable role-chip${role === r.name ? ' amber' : ''}`}
                title={`Role · boots ${r.preset} with the “${r.name}” prompt`}
                disabled={making}
                onClick={() => onRole(r.name)}
              >
                <RoleAvatar name={r.name} className="role-chip-avatar" /> {r.name}
              </button>
            ))}
            {savedTeams.length > 0 && <span className="cr-dock-family">{DOCK_FAMILY.teams}</span>}
            {savedTeams.map((name) => (
              <button
                key={name}
                className={`cr-chip clickable team-chip${role === null && preset === name ? ' amber' : ''}`}
                title={`${name} — opens a session of this team`}
                disabled={making}
                onClick={() => onPreset(name)}
              >
                <AgentSprite preset={name} /> {name}
              </button>
            ))}
            {/* THE TAIL IS FIXED FURNITURE, not another chip.
                The import entry and the orch switch are not things you own a
                growing number of — they are the two acts available whatever
                the row contains — so they sit apart, at the end, and do not
                drift as teams are saved. */}
            <span className="cr-dock-tail">
              {onImportServed && (
                <button
                  className="cr-chip clickable import-served"
                  title="Import someone else's served team by its address"
                  onClick={() => onImportServed()}
                >
                  {DOCK_FAMILY.import}
                </button>
              )}
              <label className="cr-check">
                <input type="checkbox" checked={orch} onChange={(e) => onOrch(e.target.checked)} />
                ORCH
              </label>
            </span>
          </div>
        )}
        {!slidIn && makeError ? (
          <div className="cr-dock-hint error" role="alert">{makeError}</div>
        ) : (
          !slidIn && hint && <div className="cr-dock-hint">{hint}</div>
        )}
      </div>
      <div className="dock-pane dock-send" aria-hidden={!slidIn}>
        {boardFor && (
          <button
            className={`cr-btn tool icon${boardFor.editing ? ' primary' : ''}`}
            title={
              boardFor.editing
                ? 'Done selecting'
                : 'Select elements to copy, cut or save'
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
