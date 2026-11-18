import type { CanvasNode } from '../../../../src/shared/model'

/** Agents in the seeded crew: more than a stop shows at once, so the crew scrolls. */
export const AGENTS = 40

/**
 * A workspace the zoom view draws as a crew: AGENTS terminals (the agents) with
 * a handful of notes and browsers beside them (the artifacts). Positions are
 * kept for the store's sake; the zoom view seats agents in creation order.
 */
export function seedNodes(): CanvasNode[] {
  const nodes: CanvasNode[] = []
  const at = (i: number) => ({ position: { x: (i % 8) * 600, y: Math.floor(i / 8) * 400 }, size: { width: 560, height: 360 } })
  for (let i = 0; i < AGENTS; i += 1) {
    nodes.push({ kind: 'terminal', id: `agent-${i}`, name: `Agent ${i}`, preset: 'Claude', command: '', cwd: '~', orch: i === 0, role: null, ...at(i) })
  }
  for (let i = 0; i < 6; i += 1) {
    nodes.push({
      kind: 'note',
      id: `note-${i}`,
      name: `note-${i}`,
      customName: null,
      content: `# Note ${i}\n\nA few lines of **markdown** so the body is real.\n\n- one\n- two`,
      locked: false,
      ...at(AGENTS + i)
    })
    nodes.push({ kind: 'browser', id: `browser-${i}`, name: `Browser ${i}`, url: 'https://example.com', ...at(AGENTS + 6 + i) })
  }
  return nodes
}
