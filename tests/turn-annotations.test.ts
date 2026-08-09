// The annotation split (step 2 of checkpoint-as-identity).
//
// The whole point of this refactor is that it is INVISIBLE: every existing
// TurnStore test passes untouched. So the assertions here are the ones those
// tests cannot make — that the split actually happened on disk, that the two
// halves have the right owners, and that files written before the split still
// read back whole.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TurnStore } from '../src/main/turn-store'
import { AnnotationStore } from '../src/main/turn-annotations'
import {
  hasAnnotation,
  mergeAnnotation,
  splitAnnotation,
  type TurnRecord,
} from '../src/shared/turn'

let dir: string
let annDir: string
let store: TurnStore

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'cookrew-ann-'))
  // Both directories are passed EXPLICITLY. The sibling default is asserted on
  // its own below; every other test states where each half lives, so none of
  // them depends on that default staying what it is.
  dir = path.join(root, 'turns')
  annDir = path.join(root, 'checkpoint-annotations')
  mkdirSync(dir, { recursive: true })
  mkdirSync(annDir, { recursive: true })
  store = new TurnStore(dir, annDir)
})
afterEach(() => rmSync(path.dirname(dir), { recursive: true, force: true }))

const rec = (index: number, over: Partial<TurnRecord> = {}): TurnRecord => ({
  index,
  prompt: `ask ${index}`,
  reply: `reply ${index}`,
  startedAt: index * 10,
  endedAt: index * 10 + 5,
  ...over,
})

const save = (records: TurnRecord[], id = 't1'): void => {
  store.scheduleSave(id, records)
  store.flushAll()
}

const conversationText = (id = 't1'): string =>
  readFileSync(path.join(dir, `${id}.jsonl`), 'utf8')

const annotationFile = (id = 't1'): string => path.join(annDir, `${id}.json`)

/**
 * THE invariant. Step 3 documents the ledger as derived and safe to delete, so
 * `rm -rf ~/.cookrew/turns` is a thing someone will eventually run. Nothing in
 * the annotations directory can be rebuilt from a transcript, so it must not be
 * reachable by that command — and a comment saying so is not a mechanism.
 */
describe('annotations live OUTSIDE the ledger, structurally', () => {
  const isInside = (child: string, parent: string): boolean => {
    const rel = path.relative(parent, child)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  it('never puts the annotations directory inside the turns directory', () => {
    for (const turns of [
      path.join(homedir(), '.cookrew', 'turns'),
      '/var/data/cookrew/turns',
      dir,
    ]) {
      const store = new TurnStore(turns)
      expect(isInside(store.annotationsDir, turns)).toBe(false)
    }
  })

  it('defaults to the sibling of the turns directory it was given', () => {
    // path.resolve() inside TurnStore absolutises against the cwd, which on
    // Windows prepends a drive letter. Compare the resolved forms so the
    // assertion is about the SIBLING relationship, not about how the platform
    // spells an absolute path.
    expect(new TurnStore(path.join('/var/data/cookrew/turns')).annotationsDir).toBe(
      path.resolve('/var/data/cookrew', 'checkpoint-annotations'),
    )
  })

  it('puts the real ledger’s annotations at ~/.cookrew/checkpoint-annotations', () => {
    expect(new TurnStore().annotationsDir).toBe(
      path.join(homedir(), '.cookrew', 'checkpoint-annotations'),
    )
  })

  it('survives deleting the whole turns directory', () => {
    save([rec(1, { title: 'recap', seenAt: 999, scrollLine: 42 }), rec(2)])
    // Exactly what step 3 tells people they may do.
    rmSync(dir, { recursive: true, force: true })

    expect(existsSync(annotationFile())).toBe(true)
    // The conversation is gone — a transcript can regenerate that. What no
    // transcript ever knew is still on disk, keyed by checkpoint index and
    // ready for the rebuild to re-attach.
    expect(new TurnStore(dir, annDir).load('t1')).toEqual([])
    expect(JSON.parse(readFileSync(annotationFile(), 'utf8'))).toEqual({
      '1': { title: 'recap', seenAt: 999, scrollLine: 42 },
    })
  })
})

describe('splitAnnotation / mergeAnnotation — the field partition', () => {
  it('sends title, seenAt and scrollLine to the annotation half', () => {
    const { annotation } = splitAnnotation(rec(1, { title: 'recap', seenAt: 9, scrollLine: 42 }))
    expect(annotation).toEqual({ title: 'recap', seenAt: 9, scrollLine: 42 })
  })

  it('keeps the conversation — including the session uuid, which binds it', () => {
    const { conversation } = splitAnnotation(
      rec(1, { uuid: 'u-1', title: 'recap', seenAt: 9, scrollLine: 42 }),
    )
    expect(conversation).toEqual({
      index: 1,
      prompt: 'ask 1',
      reply: 'reply 1',
      uuid: 'u-1',
      startedAt: 10,
      endedAt: 15,
    })
  })

  it('leaves absent fields absent, so an un-annotated record serializes identically', () => {
    const { conversation, annotation } = splitAnnotation(rec(1))
    expect(JSON.stringify(conversation)).toBe(JSON.stringify(rec(1)))
    expect(hasAnnotation(annotation)).toBe(false)
  })

  it('round-trips through split then merge', () => {
    const original = rec(1, { title: 'recap', seenAt: 9, scrollLine: 42 })
    const { conversation, annotation } = splitAnnotation(original)
    expect(mergeAnnotation(conversation, annotation)).toEqual(original)
  })

  it('lets the record keep what the annotation does not carry', () => {
    // A pre-split line still has title inline; the sidecar only knows seenAt.
    const inline = rec(1, { title: 'from the line' })
    expect(mergeAnnotation(inline, { seenAt: 5 })).toEqual(
      rec(1, { title: 'from the line', seenAt: 5 }),
    )
  })

  it('lets the annotation win where both have a value', () => {
    expect(mergeAnnotation(rec(1, { title: 'stale' }), { title: 'fresh' }).title).toBe('fresh')
  })
})

describe('TurnStore — the split is real on disk', () => {
  it('writes no annotation field onto a conversation line', () => {
    save([rec(1), rec(2, { title: 'recap', seenAt: 999, scrollLine: 42 })])
    expect(conversationText()).not.toMatch(/title|seenAt|scrollLine/)
  })

  it('writes them to a sidecar keyed by CHECKPOINT INDEX, not array position', () => {
    save([rec(7), rec(8, { title: 'recap', seenAt: 999 })])
    expect(JSON.parse(readFileSync(annotationFile(), 'utf8'))).toEqual({
      '8': { title: 'recap', seenAt: 999 },
    })
  })

  it('keeps the sidecar out of the ledger walk', () => {
    save([rec(1, { title: 'recap' })])
    // The turns directory holds conversations and nothing else, so the walk
    // cannot mistake an annotation file for an agent's history.
    expect(readdirSync(dir)).toEqual(['t1.jsonl'])
    expect([...store.loadAll().keys()]).toEqual(['t1'])
  })

  it('writes no sidecar at all for an agent that has no annotations', () => {
    save([rec(1), rec(2)])
    expect(existsSync(annotationFile())).toBe(false)
  })

  it('drops an annotation when its CHECKPOINT disappears, so a rewind takes effect', () => {
    save([rec(1, { title: 'one' }), rec(2, { title: 'two', seenAt: 5 })])
    save([rec(1, { title: 'one' })])
    expect(JSON.parse(readFileSync(annotationFile(), 'utf8'))).toEqual({ '1': { title: 'one' } })
  })

  it('clears an annotation the history stopped carrying', () => {
    // The caller hands over the WHOLE history, so absence is authoritative —
    // a store that inherited whatever was on disk could never clear anything.
    save([rec(1, { title: 'recap', seenAt: 5 })])
    save([rec(1)])
    expect(store.load('t1')[0]).toEqual(rec(1))
    expect(existsSync(annotationFile())).toBe(false)
  })

  it('replaces a changed annotation rather than merging into it', () => {
    save([rec(1, { title: 'first', seenAt: 5 })])
    save([rec(1, { title: 'second' })])
    expect(store.load('t1')[0]).toEqual(rec(1, { title: 'second' }))
  })
})

/**
 * The reason the split is worth doing: acknowledging a result used to rewrite
 * the entire conversation file to record that someone looked at it.
 */
describe('TurnStore — an annotation-only edit does not touch the conversation', () => {
  it('leaves the conversation bytes identical when seenAt is stamped', () => {
    save([rec(1), rec(2)])
    const before = conversationText()
    save([rec(1), rec(2, { seenAt: 999 })])
    expect(conversationText()).toBe(before)
    expect(store.load('t1')[1].seenAt).toBe(999)
  })

  it('leaves them identical when a Sous title lands late', () => {
    save([rec(1), rec(2)])
    const before = conversationText()
    save([rec(1), rec(2, { title: 'recap' })])
    expect(conversationText()).toBe(before)
    expect(store.load('t1')[1].title).toBe('recap')
  })

  it('still rewrites the conversation when the conversation itself changed', () => {
    // Dedupe and reconcile edit prompts/replies, which is why the store's
    // conservative fallback has to stay.
    save([rec(1), rec(2)])
    save([rec(1), rec(2, { reply: 'corrected' })])
    expect(store.load('t1')[1].reply).toBe('corrected')
  })
})

describe('TurnStore — files written before the split', () => {
  it('reads inline annotations back unchanged, before any rewrite', () => {
    const records = [rec(1), rec(2, { title: 'recap', seenAt: 999, scrollLine: 42 })]
    writeFileSync(
      path.join(dir, 'old.jsonl'),
      records.map((r) => `${JSON.stringify(r)}\n`).join(''),
      'utf8',
    )
    expect(new TurnStore(dir).load('old')).toEqual(records)
  })

  it('carries a legacy .json array’s annotations across the migration', () => {
    const records = [rec(1), rec(2, { title: 'recap', seenAt: 999 })]
    writeFileSync(path.join(dir, 'leg.json'), JSON.stringify(records), 'utf8')
    // First read migrates to lines; the SECOND is the one that would expose a
    // migration that stripped annotations without saving them.
    expect(store.load('leg')).toEqual(records)
    expect(new TurnStore(dir).load('leg')).toEqual(records)
  })
})

describe('TurnStore — annotations survive the same journeys as the history', () => {
  it('round-trips through a fresh store instance', () => {
    save([rec(1), rec(2, { title: 'recap', seenAt: 999, scrollLine: 42 })])
    expect(new TurnStore(dir).load('t1')).toEqual([
      rec(1),
      rec(2, { title: 'recap', seenAt: 999, scrollLine: 42 }),
    ])
  })

  it('comes back through loadAll and loadTail too', () => {
    save([rec(1), rec(2, { title: 'recap' })])
    const fresh = new TurnStore(dir)
    expect(fresh.loadAll().get('t1')?.[1].title).toBe('recap')
    expect(fresh.loadTail('t1', 1)[0].title).toBe('recap')
  })

  it('does not leak one agent’s annotations onto another', () => {
    save([rec(1, { title: 'mine' })], 't1')
    save([rec(1)], 't2')
    expect(new TurnStore(dir).load('t2')[0].title).toBeUndefined()
  })

  it('is dropped with the terminal', () => {
    save([rec(1, { title: 'recap' })])
    expect(existsSync(annotationFile())).toBe(true)
    store.remove('t1')
    expect(existsSync(annotationFile())).toBe(false)
  })

  it('sanitizes the terminal id for the sidecar filename too', () => {
    save([rec(1, { title: 'recap' })], '../evil/../../id')
    expect(existsSync(path.join(annDir, 'evilid.json'))).toBe(true)
  })
})

describe('AnnotationStore — a bad sidecar costs recaps, never history', () => {
  it('reads a corrupt file as no annotations', () => {
    const annotations = new AnnotationStore(annDir)
    writeFileSync(path.join(annDir, 'x.json'), '{not json', 'utf8')
    expect(annotations.load('x').size).toBe(0)
  })

  it('ignores entries that are not annotation-shaped', () => {
    const annotations = new AnnotationStore(annDir)
    writeFileSync(
      path.join(annDir, 'y.json'),
      JSON.stringify({ '1': { title: 'ok' }, '2': { title: 42 }, three: { seenAt: 1 } }),
      'utf8',
    )
    const loaded = annotations.load('y')
    expect(loaded.get(1)).toEqual({ title: 'ok' })
    expect(loaded.has(2)).toBe(false)
  })

  it('leaves the history readable when the sidecar is unusable', () => {
    save([rec(1), rec(2, { title: 'recap' })])
    writeFileSync(annotationFile(), 'garbage', 'utf8')
    expect(new TurnStore(dir).load('t1').map((r) => r.index)).toEqual([1, 2])
  })
})
