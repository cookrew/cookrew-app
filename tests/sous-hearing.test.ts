import { describe, expect, it } from 'vitest'
import {
  nearestName,
  rankHearings,
  vocabularyOf,
  vocabularyScore
} from '../src/shared/sous-hearing'
import { resolveName } from '../src/shared/sous-intent'

/**
 * WHAT THE EARS HEARD, RERANKED AGAINST WHAT IS ACTUALLY ON THE CANVAS.
 *
 * The Mac listens with one recognizer PER LOCALE, all on the same microphone,
 * and they disagree about proper nouns in a way that is not a tie: a zh-CN ear
 * renders "Conductor" as two unrelated Chinese syllables (双球, measured
 * 2026-09-06) while the en-US ear beside it hears it exactly. Until now the
 * controller took the PRIMARY ear, and only if its parse came up empty did it
 * try the others IN ORDER, keeping the first that happened to resolve. First,
 * not best — so which ear won depended on the order they were spawned in.
 *
 * And a name that came back slightly wrong from the right ear could not be
 * recovered at all: resolution was exact → hand-written alias → unique prefix,
 * so every mishearing had to be typed into `~/.cookrew/sous.json` by hand,
 * one alias per locale per mangling, forever.
 *
 * Two mechanisms, and they answer different halves:
 *
 *   RERANKING answers the cross-script half. No edit distance bridges 双球 and
 *   Conductor, and pretending one does would be a guess. But one ear DID hear
 *   the name, and the roster is right there to say which — so the hypothesis
 *   that names something real is preferred over the one that names nothing.
 *
 *   SNAPPING answers the within-script half: conducter, konductor, magpye. A
 *   near miss is snapped to the roster entry it is nearest, and ONLY when that
 *   entry is unambiguously the nearest.
 *
 * The line both of them hold: prose is never touched. Only a name — a span the
 * parser was already going to resolve — may be rewritten, and an ambiguity
 * stays an ambiguity rather than becoming a choice made for the owner.
 */

const agent = (name: string, extra: { aliases?: string[] } = {}) => ({ name, ...extra })

const CREW = [
  agent('Conductor'),
  agent('Velvet'),
  agent('Magpie'),
  agent('Atlas'),
  agent('Pi'),
  agent('Claude Code')
]

describe('snapping a near miss to a name that exists', () => {
  it('snaps a one-letter mishearing of a long name', () => {
    expect(nearestName('conducter', CREW)?.name).toBe('Conductor')
    expect(nearestName('konductor', CREW)?.name).toBe('Conductor')
  })

  it('snaps through the punctuation ASR never spells twice', () => {
    // normalize already folds spaces and hyphens, so this tier only ever sees
    // what is left: real substitutions.
    expect(nearestName('claude kode', CREW)?.name).toBe('Claude Code')
  })

  it('REFUSES a short name — two letters apart is a different agent', () => {
    // "Pi" is three edits from "Magpie" and one from countless words. A pool
    // this small cannot afford charity on a two-character name.
    expect(nearestName('pie', CREW)).toBeNull()
    expect(nearestName('py', CREW)).toBeNull()
  })

  it('REFUSES a word that is merely in the neighbourhood', () => {
    expect(nearestName('velocity', CREW)).toBeNull()
    expect(nearestName('atlantic', CREW)).toBeNull()
    expect(nearestName('magnify', CREW)).toBeNull()
  })

  it('leaves a plain truncation to the prefix tier, and agrees with it anyway', () => {
    // "conduct" is a PREFIX of Conductor, so resolveName settles it one tier
    // earlier — and settles it as an ambiguity when two names share the stem,
    // which is why this tier never sees the dangerous version of the case.
    expect(nearestName('conduct', CREW)?.name).toBe('Conductor')
  })

  it('REFUSES across scripts — no edit distance bridges 双球 and Conductor', () => {
    // This is the case reranking exists for. Snapping must not pretend to it:
    // a phonetic leap that big is a guess, and a guess that types into the
    // wrong agent is worse than asking.
    expect(nearestName('双球', CREW)).toBeNull()
  })

  it('REFUSES when two names are equally near — an ambiguity is not a choice', () => {
    // One edit from each. Picking either would be a coin toss typed into
    // somebody's terminal; a miss becomes "which one?" out loud instead.
    const twins = [agent('Marla'), agent('Karla')]
    expect(nearestName('narla', twins)).toBeNull()
  })

  it('still finds the name when it was said exactly', () => {
    expect(nearestName('Conductor', CREW)?.name).toBe('Conductor')
  })
})

describe('resolveName, with the near tier behind the ones that were already there', () => {
  it('resolves a near miss that used to be a flat miss', () => {
    const hit = resolveName('conducter', CREW)
    expect('hit' in hit && hit.hit.name).toBe('Conductor')
  })

  it('leaves exact, alias and prefix answering exactly as before', () => {
    const pool = [agent('Conductor', { aliases: ['指挥'] }), agent('Velvet')]
    expect('hit' in resolveName('conductor', pool) && resolveName('conductor', pool)).toBeTruthy()
    const byAlias = resolveName('指挥', pool)
    expect('hit' in byAlias && byAlias.hit.name).toBe('Conductor')
    const byPrefix = resolveName('vel', pool)
    expect('hit' in byPrefix && byPrefix.hit.name).toBe('Velvet')
  })

  it('keeps an ambiguity ambiguous rather than snapping out of it', () => {
    const twins = [agent('Marker'), agent('Marple')]
    const answer = resolveName('mar', twins)
    expect('ambiguous' in answer && answer.ambiguous).toHaveLength(2)
  })

  it('still misses what is genuinely not here', () => {
    expect('miss' in resolveName('nobody at all', CREW)).toBe(true)
  })
})

describe('scoring what an ear heard against the canvas', () => {
  const vocabulary = vocabularyOf({
    agents: [agent('Conductor'), agent('Velvet')],
    workspaces: [{ name: 'Cookrew Dev' }]
  })

  it('scores an ear that named a real agent above one that named nothing', () => {
    expect(vocabularyScore('ask Conductor to build it', vocabulary)).toBeGreaterThan(
      vocabularyScore('问双球去做这个', vocabulary)
    )
  })

  it('scores nothing for an utterance with no names at all', () => {
    expect(vocabularyScore('just some words', vocabulary)).toBe(0)
  })

  it('weighs a long name above a short one — it is the stronger evidence', () => {
    const pool = vocabularyOf({ agents: [agent('Pi'), agent('Conductor')], workspaces: [] })
    expect(vocabularyScore('Conductor', pool)).toBeGreaterThan(vocabularyScore('Pi', pool))
  })

  it('reads a name through the same normalisation the resolver uses', () => {
    expect(vocabularyScore('open claude-code please', vocabularyOf({
      agents: [agent('Claude Code')],
      workspaces: []
    }))).toBeGreaterThan(0)
  })

  it('counts a workspace name too — "switch to Cookrew Dev" is evidence', () => {
    expect(vocabularyScore('switch to Cookrew Dev', vocabulary)).toBeGreaterThan(0)
  })
})

describe('ranking the ears', () => {
  const vocabulary = vocabularyOf({
    agents: [agent('Conductor'), agent('Velvet')],
    workspaces: []
  })

  it('puts the ear that named a real agent first, even when it is not primary', () => {
    const ranked = rankHearings(['问双球去做这个', 'ask Conductor to do this'], vocabulary)
    expect(ranked[0]).toBe('ask Conductor to do this')
  })

  it('leaves the primary first when no ear knows better — order is not churn', () => {
    const ranked = rankHearings(['first thing', 'second thing'], vocabulary)
    expect(ranked).toEqual(['first thing', 'second thing'])
  })

  it('keeps the primary first when both ears heard the name — a tie is not a swap', () => {
    const ranked = rankHearings(['ask Conductor now', 'ask Conductor now please'], vocabulary)
    expect(ranked[0]).toBe('ask Conductor now')
  })

  it('never drops an ear — every hypothesis survives the ranking', () => {
    const heard = ['one', 'ask Velvet', 'three']
    expect(rankHearings(heard, vocabulary)).toHaveLength(3)
    expect([...rankHearings(heard, vocabulary)].sort()).toEqual([...heard].sort())
  })

  it('is a no-op with nothing on the canvas to recognise', () => {
    const empty = vocabularyOf({ agents: [], workspaces: [] })
    expect(rankHearings(['a', 'b', 'c'], empty)).toEqual(['a', 'b', 'c'])
  })
})
