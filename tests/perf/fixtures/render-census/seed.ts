import type { CanvasNode } from '../../../../src/shared/model'

/**
 * A canvas the gate can see whole: 24 cards of the three kinds on a 4 x 6
 * grid, sized so that fitView on a 1600 x 1000 stage lands above the mini
 * threshold (card mode, the fuller rendering) with every card on stage — so a
 * small pan changes NO card's visibility and the only honest render count for
 * the cards is zero.
 */
export function seedNodes(): CanvasNode[] {
  const nodes: CanvasNode[] = []
  for (let i = 0; i < 24; i += 1) {
    const col = i % 4
    const row = Math.floor(i / 4)
    const position = { x: col * 600, y: row * 400 }
    const size = { width: 560, height: 360 }
    const id = `card-${i}`
    if (i % 3 === 0) {
      nodes.push({
        kind: 'terminal',
        id,
        name: `Agent ${i}`,
        preset: 'Claude',
        command: '',
        cwd: '~',
        orch: i === 0,
        role: null,
        position,
        size
      })
    } else if (i % 3 === 1) {
      nodes.push({
        kind: 'note',
        id,
        name: `note-${i}`,
        customName: null,
        content: `# Note ${i}\n\nA few lines of **markdown** so the body is real.\n\n- one\n- two`,
        locked: false,
        position,
        size
      })
    } else {
      nodes.push({ kind: 'browser', id, name: `Browser ${i}`, url: 'https://example.com', position, size })
    }
  }
  return nodes
}
