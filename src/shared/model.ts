// Shared data model between main, renderer and CLI protocol.

export type NodeKind = 'terminal' | 'note' | 'browser'

export interface CanvasPosition {
  x: number
  y: number
}

export interface CanvasSize {
  width: number
  height: number
}

export interface TerminalNodeData {
  kind: 'terminal'
  id: string
  name: string
  preset: string
  command: string
  cwd: string
  orch: boolean
  role: string | null
  position: CanvasPosition
  size: CanvasSize
}

export interface NoteNodeData {
  kind: 'note'
  id: string
  /** Slug name derived from first line unless customName is set. */
  name: string
  customName: string | null
  /** Markdown body. Persisted as a real .md file on disk. */
  content: string
  locked: boolean
  position: CanvasPosition
  size: CanvasSize
}

export interface BrowserTab {
  id: string
  url: string
  /** Last page title reported by the webview; empty until first load. */
  title: string
}

export interface BrowserNodeData {
  kind: 'browser'
  id: string
  name: string
  /** URL of the active tab (kept in sync for cards, `cookrew list`, older readers). */
  url: string
  /** Tab group; absent on workspaces saved before tabs existed — normalize via browserTabs(). */
  tabs?: BrowserTab[]
  activeTabId?: string
  position: CanvasPosition
  size: CanvasSize
}

export type CanvasNode = TerminalNodeData | NoteNodeData | BrowserNodeData

export interface Connection {
  id: string
  a: string
  b: string
}

export interface WorkspaceState {
  name: string
  dir: string
  nodes: CanvasNode[]
  connections: Connection[]
}

/** Sidebar entry for a workspace — its canvas lives in a separate file. */
export interface WorkspaceMeta {
  id: string
  name: string
  dir: string
  /** One emoji shown in the switcher. */
  icon: string
}

/** What the renderer needs to render the workspace switcher. */
export interface WorkspaceList {
  workspaces: WorkspaceMeta[]
  activeId: string
}

export interface RoutineSpec {
  id: string
  name: string
  command: string
  schedule: { type: 'every'; ms: number } | { type: 'daily'; time: string }
  terminalId: string | null
  enabled: boolean
  fireCount: number
}

/** A single request over the cookrew Unix socket (newline-delimited JSON). */
export interface CliRequest {
  id: string
  terminalId: string
  cmd: string
  args: string[]
  flags: Record<string, string | boolean>
}

export interface CliResponse {
  id: string
  ok: boolean
  output?: string
  error?: string
}

export const DEFAULT_TERMINAL_SIZE: CanvasSize = { width: 640, height: 420 }
export const DEFAULT_NOTE_SIZE: CanvasSize = { width: 280, height: 220 }
export const DEFAULT_BROWSER_SIZE: CanvasSize = { width: 720, height: 560 }

/** Tabs of a browser, synthesizing a single tab for pre-tabs workspaces. */
export function browserTabs(node: BrowserNodeData): BrowserTab[] {
  if (node.tabs && node.tabs.length > 0) return node.tabs
  return [{ id: `${node.id}-tab-0`, url: node.url, title: '' }]
}

export function activeBrowserTab(node: BrowserNodeData): BrowserTab {
  const tabs = browserTabs(node)
  return tabs.find((t) => t.id === node.activeTabId) ?? tabs[0]
}

/** Derive a Maestri-style note name from its first content line. */
export function noteNameFromContent(content: string): string {
  const firstLine = content.split('\n')[0] ?? ''
  const slug = firstLine
    .toLowerCase()
    .replace(/[#*`>\-\[\]()!]/g, ' ')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : 'untitled'
}

/** Ensure a name is unique among existing names by appending (2), (3)... */
export function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base
  let n = 2
  while (existing.includes(`${base} (${n})`)) n += 1
  return `${base} (${n})`
}
