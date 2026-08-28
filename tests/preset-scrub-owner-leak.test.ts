// SEC-S / P1 + P3 — what a CLEAN scrub is still allowed to put on the wire.
//
// Both of these shipped under a SIGNED `secretScan: "clean"`, which is worse
// than an unscrubbed publish: the signature is what a buyer trusts instead of
// looking. Found on this lane's own branch before review.
//
//   P1 — the workdir table masks `dir`, `dirs` and terminal `cwd`s. Every OTHER
//        mention of a home-relative path — in a note, in a command, in a card
//        name — went out verbatim, carrying the owner's username and the shape
//        of their home directory, under a signed `paths: "placeholders"`.
//   P3 — the snapshot's own `name` was neither scanned nor masked. M8 fixed
//        this for a card's name ("author-written text like any other field")
//        and missed the team's.
//
// The paths here are built from the REAL homedir() so the test exercises the
// same value the scrub does, on any machine.
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { scrubForPublish } from '../src/main/preset-scrub'
import type { TeamSnapshot } from '../src/main/teams'
import { canonicalJson } from '../src/shared/preset-manifest'

const HOME = homedir()
const WORKDIR = `${HOME}/workspace/proj`

const terminal = (id: string, over: Record<string, unknown> = {}) =>
  ({
    kind: 'terminal',
    id,
    name: id,
    preset: 'Claude Code',
    command: 'claude',
    cwd: WORKDIR,
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 10, height: 10 },
    ...over
  }) as unknown as TeamSnapshot['nodes'][number]

const note = (id: string, content: string) =>
  ({
    kind: 'note',
    id,
    name: id,
    customName: null,
    content,
    locked: false,
    position: { x: 0, y: 0 },
    size: { width: 10, height: 10 }
  }) as unknown as TeamSnapshot['nodes'][number]

const snap = (
  nodes: TeamSnapshot['nodes'],
  over: Partial<TeamSnapshot> = {}
): TeamSnapshot =>
  ({
    name: 'proj team',
    savedAt: 1,
    dir: WORKDIR,
    nodes,
    connections: [],
    turns: {},
    ...over
  }) as TeamSnapshot

/** The bytes that would actually be hashed, signed and pushed. */
const published = (snapshot: TeamSnapshot): string => {
  const result = scrubForPublish(snapshot)
  expect(result.ok).toBe(true)
  return canonicalJson(result.ok ? result.snapshot : {})
}

describe('P1 — the owner’s home directory never leaves the machine', () => {
  it('masks a home path mentioned in a note', () => {
    const body = published(snap([note('n1', `Key lives at ${HOME}/.ssh/id_rsa`)]))
    expect(body).not.toContain(HOME)
  })

  it('masks a home path mentioned in a command, which the paste engine runs verbatim', () => {
    const body = published(snap([terminal('t1', { command: `bash ${HOME}/.cookrew/deploy.sh` })]))
    expect(body).not.toContain(HOME)
  })

  it('masks a home path in a card name and a note’s custom name', () => {
    const body = published(
      snap([
        terminal('t1', { name: `agent in ${HOME}/other-repo` }),
        note('n1', 'clean body', )
      ])
    )
    expect(body).not.toContain(HOME)
  })

  it('still maps the registered workdirs to installer placeholders', () => {
    const result = scrubForPublish(snap([terminal('t1')]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.dir).toBe('{{dir0}}')
    const node = result.snapshot.nodes[0]
    expect(node.kind === 'terminal' && node.cwd).toBe('{{dir0}}')
  })

  it('leaves a path that says nothing about the owner alone', () => {
    // The gate must match an OWNER-IDENTIFYING path, never a mention. Prose
    // like "installs to /usr/local/bin" has to survive, or authors route
    // around the scrub — the same discipline the secret patterns follow.
    const body = published(snap([note('n1', 'installs to /usr/local/bin')]))
    expect(body).toContain('/usr/local/bin')
  })
})

describe('P3 — the team’s own name is author-written text like any other field', () => {
  it('blocks a publish whose team name carries a credential', () => {
    const result = scrubForPublish(
      snap([terminal('t1')], { name: 'client sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    )
    expect(result.ok).toBe(false)
    expect(result.report.secretScan).toBe('blocked')
    expect(result.report.findings.some((f) => f.where === 'name')).toBe(true)
  })

  it('names the location without ever quoting the secret', () => {
    const result = scrubForPublish(
      snap([terminal('t1')], { name: 'client sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    )
    expect(JSON.stringify(result.report)).not.toContain('sk-ant-')
  })

  it('masks a home path in the team name', () => {
    const body = published(snap([terminal('t1')], { name: `${HOME}/secret-client` }))
    expect(body).not.toContain(HOME)
  })
})
