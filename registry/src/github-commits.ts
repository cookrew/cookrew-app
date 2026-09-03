/**
 * BUILT IN THE OPEN — the last commits on the dev branch, from GitHub, cached.
 *
 * The homepage's "built by its own crew" section shows real, dated work:
 * the commit titles of the branch cookrew.dev is built from. It is the
 * cheapest fresh content there is — nobody writes it for the page — and a
 * crawler that sees a dated line change every day reads a living project.
 * Cached for ten minutes; a miss keeps the last answer, like releases.ts.
 */

export const COMMITS_API = 'https://api.github.com/repos/cookrew/cookrew-app/commits?sha=dev&per_page=12'
export const COMMITS_PAGE = 'https://github.com/cookrew/cookrew-app/commits/dev'

export interface Commit {
  sha: string
  /** First line of the message. */
  title: string
  /** ISO date, from the committer. */
  date: string
  url: string
}

const HTTPS = /^https:\/\/[a-z0-9.-]+\//i

export class CommitsCache {
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
  private readonly ttlMs: number
  private readonly missTtlMs: number
  private last: Commit[] | null = null
  private readAt = 0
  private inflight: Promise<Commit[] | null> | null = null

  constructor(options: { fetch?: typeof fetch; ttlMs?: number; missTtlMs?: number } = {}) {
    this.fetchImpl = options.fetch ?? fetch
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000
    this.missTtlMs = options.missTtlMs ?? Math.min(this.ttlMs, 60 * 1000)
  }

  async latest(): Promise<Commit[] | null> {
    const age = Date.now() - this.readAt
    const due = this.last === null ? age >= this.missTtlMs : age >= this.ttlMs
    if (!due) return this.last
    if (!this.inflight) {
      this.inflight = this.read().finally(() => {
        this.inflight = null
      })
    }
    return this.last === null ? this.inflight : this.last
  }

  private async read(): Promise<Commit[] | null> {
    this.readAt = Date.now()
    try {
      const res = await this.fetchImpl(COMMITS_API, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'cookrew-registry' },
        signal: AbortSignal.timeout(8000)
      })
      if (!res.ok) return this.miss()
      const parsed = parseCommits(await res.json())
      if (parsed.length === 0) return this.miss()
      this.last = parsed
      return parsed
    } catch {
      return this.miss()
    }
  }

  /** After a miss there is an answer — an empty one — so no render ever waits on GitHub again. */
  private miss(): Commit[] {
    this.last ??= []
    return this.last
  }
}

export function parseCommits(body: unknown): Commit[] {
  if (!Array.isArray(body)) return []
  const out: Commit[] = []
  for (const raw of body as { sha?: unknown; html_url?: unknown; commit?: { message?: unknown; committer?: { date?: unknown } } }[]) {
    if (typeof raw.sha !== 'string' || typeof raw.commit?.message !== 'string') continue
    const title = raw.commit.message.split('\n')[0].trim().slice(0, 140)
    if (!title) continue
    out.push({
      sha: raw.sha.slice(0, 7),
      title,
      date: typeof raw.commit.committer?.date === 'string' ? raw.commit.committer.date.slice(0, 10) : '',
      url: typeof raw.html_url === 'string' && HTTPS.test(raw.html_url) ? raw.html_url : COMMITS_PAGE
    })
  }
  return out
}
