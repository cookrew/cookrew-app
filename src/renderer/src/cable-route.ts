/**
 * THE HARNESS ROUTER — cables routed around cards, shared runs drawn once.
 *
 * WHY. A cable drawn centre to centre goes through whatever is in the way, and
 * on a board of 200 cards most of them are in the way: measured on the live
 * workspace, 297 such cables crossed each other 3,112 times. The relationships
 * are real; the drawing is what makes them unreadable. This routes each cable
 * orthogonally through the gaps between cards — the way a wiring duct does —
 * and then draws every grid edge ONCE, however many cables share it, so 65
 * cables that leave one agent going the same way are one trunk until they
 * part. Same information, a quarter of the ink, and the structure visible.
 *
 * A cable longer than `farPx` is not routed at all: at any zoom where you can
 * read the card, its partner is off the stage, so a line carries nothing a
 * name at each end does not carry better. The caller draws those as chips.
 *
 * Pure and deterministic. No DOM, no React, no viewport: the input is card
 * geometry and links, so the result is memoisable on `geometryKey` and never
 * recomputes for a pan or a zoom — the render-count gate depends on that.
 */

export interface CableRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface CableLink {
  id: string
  a: string
  b: string
}

export interface RouteOptions {
  /** Grid cell in flow px. Two cards closer than this have no channel between them. */
  cell?: number
  /** Centre-to-centre distance beyond which a cable is named rather than drawn. */
  farPx?: number
  /** Extra cost of changing heading, in cells — what keeps a route from staircasing. */
  turnPenalty?: number
}

/** One drawn run of the harness: a grid edge and every cable that shares it. */
export interface Trunk {
  x1: number
  y1: number
  x2: number
  y2: number
  count: number
  links: readonly string[]
}

/** The short lead from a card's edge to the first cell of its route. */
export interface Stub {
  link: string
  card: string
  from: { x: number; y: number }
  to: { x: number; y: number }
}

export interface FarLink {
  link: string
  a: string
  b: string
  distance: number
}

export interface Harness {
  trunks: readonly Trunk[]
  stubs: readonly Stub[]
  far: readonly FarLink[]
  /** Links with no free cell beside one of their cards — the board is tangled there. */
  unrouted: readonly string[]
  cell: number
}

const DEFAULTS: Required<RouteOptions> = { cell: 110, farPx: 1500, turnPenalty: 4 }

/**
 * A string that changes exactly when the routing input changes: every card's
 * rect and every link, in order. A pan or zoom leaves it alone; a dragged card
 * or a new cable does not. Cheap enough to build on every render of the layer
 * that owns it, which is the point — the expensive thing hangs off it.
 */
export function geometryKey(rects: readonly CableRect[], links: readonly CableLink[]): string {
  const parts: string[] = []
  for (const r of rects) parts.push(`${r.id}:${r.x}:${r.y}:${r.width}:${r.height}`)
  parts.push('|')
  for (const l of links) parts.push(`${l.id}:${l.a}:${l.b}`)
  return parts.join(';')
}

/** Right, left, down, up — the four headings a route can hold. */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
]

interface Grid {
  cell: number
  originX: number
  originY: number
  cols: number
  rows: number
  blocked: Uint8Array
}

function gridFor(rects: readonly CableRect[], cell: number): Grid {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  if (!Number.isFinite(minX)) {
    return { cell, originX: 0, originY: 0, cols: 1, rows: 1, blocked: new Uint8Array(1) }
  }
  // Two cells of margin so a route can go round the outermost card.
  const originX = minX - 2 * cell
  const originY = minY - 2 * cell
  const cols = Math.ceil((maxX - originX) / cell) + 2
  const rows = Math.ceil((maxY - originY) / cell) + 2
  const blocked = new Uint8Array(cols * rows)
  for (const r of rects) {
    const x0 = Math.floor((r.x - originX) / cell)
    const y0 = Math.floor((r.y - originY) / cell)
    const x1 = Math.floor((r.x + r.width - 1 - originX) / cell)
    const y1 = Math.floor((r.y + r.height - 1 - originY) / cell)
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) blocked[y * cols + x] = 1
  }
  return { cell, originX, originY, cols, rows, blocked }
}

const centreOf = (r: CableRect): { x: number; y: number } => ({
  x: r.x + r.width / 2,
  y: r.y + r.height / 2
})

/**
 * The free cell just outside `from`, nearest to `toward` — where the cable
 * leaves the card. Null when the card is walled in on every side, which is a
 * fact about the board the caller reports rather than hides.
 */
function port(g: Grid, from: CableRect, toward: CableRect): { x: number; y: number } | null {
  const x0 = Math.floor((from.x - g.originX) / g.cell)
  const y0 = Math.floor((from.y - g.originY) / g.cell)
  const x1 = Math.floor((from.x + from.width - 1 - g.originX) / g.cell)
  const y1 = Math.floor((from.y + from.height - 1 - g.originY) / g.cell)
  const t = centreOf(toward)
  const tx = Math.floor((t.x - g.originX) / g.cell)
  const ty = Math.floor((t.y - g.originY) / g.cell)
  let best: { x: number; y: number; d: number } | null = null
  const consider = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= g.cols || y >= g.rows || g.blocked[y * g.cols + x]) return
    const d = Math.abs(x - tx) + Math.abs(y - ty)
    if (best === null || d < best.d) best = { x, y, d }
  }
  for (let x = x0 - 1; x <= x1 + 1; x += 1) {
    consider(x, y0 - 1)
    consider(x, y1 + 1)
  }
  for (let y = y0; y <= y1; y += 1) {
    consider(x0 - 1, y)
    consider(x1 + 1, y)
  }
  return best
}

/** A binary heap keyed on (f, then arrival order) — the order term is what makes ties deterministic. */
class Heap {
  private readonly f: number[] = []
  private readonly seq: number[] = []
  private readonly key: number[] = []
  private n = 0
  get size(): number {
    return this.f.length
  }
  push(key: number, f: number): void {
    this.f.push(f)
    this.seq.push(this.n++)
    this.key.push(key)
    let i = this.f.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.less(i, p)) break
      this.swap(i, p)
      i = p
    }
  }
  pop(): number {
    const top = this.key[0]
    const lastF = this.f.pop() as number
    const lastS = this.seq.pop() as number
    const lastK = this.key.pop() as number
    if (this.f.length > 0) {
      this.f[0] = lastF
      this.seq[0] = lastS
      this.key[0] = lastK
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < this.f.length && this.less(l, m)) m = l
        if (r < this.f.length && this.less(r, m)) m = r
        if (m === i) break
        this.swap(i, m)
        i = m
      }
    }
    return top
  }
  private less(i: number, j: number): boolean {
    return this.f[i] < this.f[j] || (this.f[i] === this.f[j] && this.seq[i] < this.seq[j])
  }
  private swap(i: number, j: number): void {
    ;[this.f[i], this.f[j]] = [this.f[j], this.f[i]]
    ;[this.seq[i], this.seq[j]] = [this.seq[j], this.seq[i]]
    ;[this.key[i], this.key[j]] = [this.key[j], this.key[i]]
  }
}

/**
 * A* over (cell, heading) with a turn penalty. The Manhattan heuristic is
 * admissible because a step costs at least 1, so the first time the goal is
 * popped is the cheapest way there. Returns the cells of the route, or null.
 */
function route(
  g: Grid,
  from: { x: number; y: number },
  to: { x: number; y: number },
  turnPenalty: number
): number[] | null {
  const states = g.cols * g.rows * 4
  const dist = new Float64Array(states).fill(Infinity)
  const prev = new Int32Array(states).fill(-1)
  const goal = to.y * g.cols + to.x
  const heap = new Heap()
  const h = (c: number): number => Math.abs((c % g.cols) - to.x) + Math.abs(Math.floor(c / g.cols) - to.y)
  const start = from.y * g.cols + from.x
  for (let d = 0; d < 4; d += 1) {
    dist[start * 4 + d] = 0
    heap.push(start * 4 + d, h(start))
  }
  while (heap.size > 0) {
    const k = heap.pop()
    const c = k >> 2
    const heading = k & 3
    const d = dist[k]
    if (c === goal) {
      const cells: number[] = []
      for (let at = k; at >= 0; at = prev[at]) cells.push(at >> 2)
      return cells.reverse()
    }
    const cx = c % g.cols
    const cy = Math.floor(c / g.cols)
    for (let nd = 0; nd < 4; nd += 1) {
      const nx = cx + DIRS[nd][0]
      const ny = cy + DIRS[nd][1]
      if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue
      const nc = ny * g.cols + nx
      if (g.blocked[nc] && nc !== goal) continue
      const nk = nc * 4 + nd
      const cost = d + 1 + (nd === heading ? 0 : turnPenalty)
      if (cost < dist[nk]) {
        dist[nk] = cost
        prev[nk] = k
        heap.push(nk, cost + h(nc))
      }
    }
  }
  return null
}

/** Nearest point on the card's boundary to a point outside it. */
function boundaryPoint(r: CableRect, p: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.min(Math.max(p.x, r.x), r.x + r.width),
    y: Math.min(Math.max(p.y, r.y), r.y + r.height)
  }
}

export function routeCables(
  rects: readonly CableRect[],
  links: readonly CableLink[],
  options: RouteOptions = {}
): Harness {
  const opts = { ...DEFAULTS, ...options }
  const byId = new Map(rects.map((r) => [r.id, r]))
  const g = gridFor(rects, opts.cell)
  const cellCentre = (c: number): { x: number; y: number } => ({
    x: g.originX + ((c % g.cols) + 0.5) * g.cell,
    y: g.originY + (Math.floor(c / g.cols) + 0.5) * g.cell
  })

  const far: FarLink[] = []
  const unrouted: string[] = []
  const stubs: Stub[] = []
  // grid edge (lower cell id first) → the links that run along it
  const runs = new Map<string, string[]>()

  for (const link of links) {
    const A = byId.get(link.a)
    const B = byId.get(link.b)
    if (!A || !B) continue
    const ca = centreOf(A)
    const cb = centreOf(B)
    const distance = Math.hypot(ca.x - cb.x, ca.y - cb.y)
    if (distance > opts.farPx) {
      far.push({ link: link.id, a: link.a, b: link.b, distance })
      continue
    }
    const pa = port(g, A, B)
    const pb = port(g, B, A)
    if (pa === null || pb === null) {
      unrouted.push(link.id)
      continue
    }
    const cells = route(g, pa, pb, opts.turnPenalty)
    if (cells === null) {
      unrouted.push(link.id)
      continue
    }
    for (let i = 0; i + 1 < cells.length; i += 1) {
      const lo = Math.min(cells[i], cells[i + 1])
      const hi = Math.max(cells[i], cells[i + 1])
      const key = `${lo}-${hi}`
      const list = runs.get(key)
      if (list) list.push(link.id)
      else runs.set(key, [link.id])
    }
    const first = cellCentre(cells[0])
    const last = cellCentre(cells[cells.length - 1])
    stubs.push({ link: link.id, card: link.a, from: boundaryPoint(A, first), to: first })
    stubs.push({ link: link.id, card: link.b, from: boundaryPoint(B, last), to: last })
  }

  const trunks: Trunk[] = []
  for (const [key, list] of runs) {
    const [lo, hi] = key.split('-').map(Number)
    const p = cellCentre(lo)
    const q = cellCentre(hi)
    trunks.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, count: list.length, links: list })
  }
  // Sorted, so two identical boards produce byte-identical harnesses whatever
  // order the links arrived in.
  trunks.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1 || a.y2 - b.y2 || a.x2 - b.x2)

  return { trunks, stubs, far, unrouted, cell: opts.cell }
}
