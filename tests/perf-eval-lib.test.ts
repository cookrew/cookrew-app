import { describe, expect, it } from 'vitest'
import { latencyStats } from '../src/shared/stats'
import {
  bucketOf,
  bucketStorage,
  judge,
  latencyFromEvents,
  orphanSidecars,
  parseEtime,
  parsePsTable,
  percentiles,
  pickAppProcesses,
  renderTable,
  slopePerHour,
  worstOf
} from '../scripts/perf-eval-lib.mjs'

// The live-machine perf eval (scripts/perf-eval.mjs) is plain JS so launchd
// can run a copy of it with no checkout behind it. These pin its helpers —
// above all that its percentile agrees with the one the product renders.

describe('percentiles — the same number the board shows', () => {
  it('matches latencyStats on random samples, every rank', () => {
    let seed = 42
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    for (let round = 0; round < 50; round += 1) {
      const n = 1 + Math.floor(rand() * 40)
      const values = Array.from({ length: n }, () => Math.round(rand() * 5000))
      expect(percentiles(values)).toEqual(latencyStats(values))
    }
  })

  it('drops what would poison a rank, and answers null to nothing', () => {
    expect(percentiles([])).toBeNull()
    expect(percentiles([NaN, -1, Infinity])).toBeNull()
    expect(percentiles([NaN, 10, -1, 20])).toEqual(latencyStats([10, 20]))
  })
})

describe('judge', () => {
  it('grades against warn then fail, and passes what it cannot grade', () => {
    expect(judge(5, { warn: 10, fail: 20 })).toBe('ok')
    expect(judge(15, { warn: 10, fail: 20 })).toBe('warn')
    expect(judge(25, { warn: 10, fail: 20 })).toBe('fail')
    expect(judge(25, { warn: 10 })).toBe('warn')
    expect(judge(null, { warn: 10 })).toBe('ok')
    expect(judge(25, undefined)).toBe('ok')
  })

  it('a zero-warn budget flags any positive amount — the orphan-bytes rule', () => {
    expect(judge(0, { warn: 0 })).toBe('ok')
    expect(judge(0.1, { warn: 0 })).toBe('warn')
  })
})

describe('slopePerHour — a rise needs enough points to be one', () => {
  const MIN = 60_000
  it('refuses fewer than three samples or under thirty minutes of span', () => {
    expect(slopePerHour([{ t: 0, value: 1 }, { t: 60 * MIN, value: 100 }])).toBeNull()
    expect(slopePerHour([{ t: 0, value: 1 }, { t: 10 * MIN, value: 2 }, { t: 20 * MIN, value: 3 }])).toBeNull()
  })

  it('reports a clean rise in units per hour', () => {
    const line = [0, 20, 40, 60].map((m) => ({ t: m * MIN, value: 100 + m * 0.5 })) // +30/hour
    expect(slopePerHour(line)).toBeCloseTo(30, 6)
  })

  it('reports a flat line as zero, not as noise', () => {
    expect(slopePerHour([0, 30, 60].map((m) => ({ t: m * MIN, value: 250 })))).toBe(0)
  })
})

describe('storage buckets', () => {
  it('names the buckets the live machine actually has', () => {
    expect(bucketOf('teams/cookrew-core-sessions/abc.jsonl')).toBe('team-sidecars')
    expect(bucketOf('teams/cookrew-core.json')).toBe('teams')
    expect(bucketOf('sessions/svc-qa-orch-door/x.jsonl')).toBe('served-sessions')
    expect(bucketOf('events.jsonl')).toBe('events')
    expect(bucketOf('events.3.jsonl')).toBe('events')
    expect(bucketOf('turns/t1.jsonl')).toBe('turns')
    expect(bucketOf('attachments/a.png')).toBe('attachments')
    expect(bucketOf('agents.json')).toBe('other')
  })

  it('names backup residue BEFORE the store it shadows', () => {
    expect(bucketOf('turns.bak-20260807-011637/t1.jsonl')).toBe('backups')
    expect(bucketOf('checkpoint-annotations.bak-20260823-103208/x.json')).toBe('backups')
    expect(bucketOf('lineage-restore-backup-20260823-222123/turns/x.jsonl')).toBe('backups')
    expect(bucketOf('lineage-postwrite-snapshot-222633/x')).toBe('backups')
    expect(bucketOf('session-backups/x.jsonl')).toBe('session-backups')
  })

  it('sums by bucket and in total', () => {
    const out = bucketStorage([
      { path: 'turns/a.jsonl', bytes: 10 },
      { path: 'turns/b.jsonl', bytes: 5 },
      { path: 'events.jsonl', bytes: 7 }
    ])
    expect(out).toEqual({ buckets: { turns: 15, events: 7 }, total: 22 })
  })
})

describe('orphanSidecars', () => {
  it('reports a sidecar file its team no longer names, and a sidecar with no team at all', () => {
    const teams = [{ slug: 'crew', sessions: { a: 'a.jsonl' } }]
    const sidecars = [
      { slug: 'crew', files: [{ name: 'a.jsonl', bytes: 1 }, { name: 'b.jsonl', bytes: 2 }] },
      { slug: 'gone', files: [{ name: 'c.jsonl', bytes: 3 }] }
    ]
    expect(orphanSidecars(teams, sidecars)).toEqual([
      { slug: 'crew', file: 'b.jsonl', bytes: 2, teamMissing: false },
      { slug: 'gone', file: 'c.jsonl', bytes: 3, teamMissing: true }
    ])
  })

  it('reports nothing when every file is named', () => {
    expect(orphanSidecars([{ slug: 'crew', sessions: { a: 'a.jsonl' } }], [{ slug: 'crew', files: [{ name: 'a.jsonl', bytes: 1 }] }])).toEqual([])
  })
})

describe('app processes out of ps', () => {
  const DEV = '/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .'
  const HELPER = '/x/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)'
  const table = [
    '  PID  PPID   RSS ELAPSED ARGS',
    // The dev main: nothing in its args says "cookrew" — it is the main
    // process because the helpers below are its children.
    `81138 81100 238560 02:23:18 ${DEV}`,
    `81289 81138 213488 02:23:12 ${HELPER} --type=renderer --user-data-dir=/Users/x/Library/Application Support/cookrew`,
    `81252 81138 203856 1-02:23:14 ${HELPER} --type=gpu-process --user-data-dir=/Users/x/Library/Application Support/cookrew`,
    // Another Electron app entirely, with its own renderer: not ours.
    `5000 1 90000 03:00 ${DEV}`,
    `5001 5000 80000 03:00 ${HELPER} --type=renderer --user-data-dir=/Users/x/Library/Application Support/other-app`,
    '3264 1 3000 05:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --user-data-dir=/tmp/cookrew-x',
    '999 1 1000 00:01 node /x/scripts/perf-eval.mjs',
    '777 1 5000 00:10 /Applications/Cookrew.app/Contents/MacOS/Cookrew'
  ].join('\n')

  it('parses etime in every shape ps prints', () => {
    expect(parseEtime('23:18')).toBe(23 * 60 + 18)
    expect(parseEtime('02:23:18')).toBe(2 * 3600 + 23 * 60 + 18)
    expect(parseEtime('1-02:23:14')).toBe(86400 + 2 * 3600 + 23 * 60 + 14)
    expect(parseEtime('garbage')).toBeNull()
  })

  it('keeps the app, roles it, and drops another Electron app, the headless Chrome and the eval itself', () => {
    const picked = pickAppProcesses(parsePsTable(table))
    expect(picked.map((p: { pid: number; role: string }) => [p.pid, p.role])).toEqual([
      [81138, 'main'],
      [81289, 'renderer'],
      [81252, 'gpu'],
      [777, 'main']
    ])
    expect(picked[0].rssMb).toBeCloseTo(233, 0)
    expect(picked[2].uptimeSec).toBe(86400 + 2 * 3600 + 23 * 60 + 14)
  })
})

describe('latencyFromEvents', () => {
  const line = (over: Record<string, unknown>): string =>
    JSON.stringify({ type: 'workspace.switched', timestamp: 1000, durationMs: 100, ...over })

  it('groups durations by type, skipping untimed, malformed and too-old events', () => {
    const out = latencyFromEvents(
      [
        line({}),
        line({ durationMs: 300 }),
        line({ type: 'turn.completed', durationMs: 5000 }),
        line({ durationMs: undefined }),
        line({ durationMs: -1 }),
        line({ durationMs: '9' }),
        line({ timestamp: 1 }),
        '{torn',
        ''
      ],
      500
    )
    expect(out['workspace.switched']).toEqual(latencyStats([100, 300]))
    expect(out['turn.completed']).toEqual(latencyStats([5000]))
  })
})

describe('report helpers', () => {
  it('pads a table to its widest cell', () => {
    expect(renderTable([['ok', 'total', '1.0 MB'], ['WARN', 'growth', '—']])).toBe('ok    total   1.0 MB\nWARN  growth  —')
  })

  it('the worst verdict wins', () => {
    expect(worstOf(['ok', 'warn', 'ok'])).toBe('warn')
    expect(worstOf(['ok', 'fail', 'warn'])).toBe('fail')
    expect(worstOf([])).toBe('ok')
  })
})
