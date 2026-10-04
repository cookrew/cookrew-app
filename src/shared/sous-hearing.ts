/**
 * WHAT THE EARS HEARD, WEIGHED AGAINST WHAT IS ACTUALLY ON THE CANVAS.
 *
 * The Mac listens with one recognizer PER LOCALE, all on the same microphone
 * (listen.ts explains why they are separate processes). They do not disagree
 * like a coin toss — they disagree about PROPER NOUNS, in one direction: an
 * ear tuned to the language being spoken renders the sentence well and the
 * names badly, and the ear beside it does the opposite. Measured 2026-09-06:
 * zh-CN renders "Conductor" as 双球, two unrelated syllables, with or without
 * a hint; en-US hears it exactly.
 *
 * The controller used to take the PRIMARY ear and, only if its parse came up
 * empty-handed, try the others IN ORDER and keep the first that resolved.
 * First, not best — so which ear won a disagreement depended on the order they
 * were spawned in. And a name that came back slightly wrong from the RIGHT ear
 * could not be recovered at all: resolution went exact → hand-written alias →
 * unique prefix, so every mishearing had to be typed into `~/.cookrew/sous.json`
 * by hand, one alias per locale per mangling, forever.
 *
 * TWO MECHANISMS, ANSWERING DIFFERENT HALVES.
 *
 *   RERANKING is for the cross-script half. No edit distance bridges 双球 and
 *   Conductor, and a module that claimed one would be guessing. But one ear DID
 *   hear the name and the roster is right there to say which — so the
 *   hypothesis that names something real is preferred over the one that names
 *   nothing. The evidence is the canvas, not a language model.
 *
 *   SNAPPING is for the within-script half: conducter, konductor, claude kode.
 *   A near miss becomes the roster entry it is nearest, and only when that
 *   entry is unambiguously the nearest.
 *
 * THE LINE BOTH HOLD: prose is never rewritten. Snapping is a tier inside NAME
 * resolution, so the only span it can touch is one the parser was already
 * going to resolve to an agent; reranking chooses between whole hypotheses and
 * changes none of them. A dictated sentence reaches its agent in the words
 * that were said — which is the guard the polish path is built around too.
 */

/** Anything with a name the owner might say. */
export interface Named {
  readonly name: string
  readonly aliases?: readonly string[]
}

/**
 * The same folding the resolver uses: case, and the punctuation ASR never
 * spells the same way twice. Spaces go too, which is why "mag pie" needs no
 * tier of its own — it normalises onto "magpie" exactly.
 */
export const fold = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[\s_\-·.]+/g, '')
    .trim()

/**
 * HOW WRONG A NAME MAY BE AND STILL BE THAT NAME.
 *
 * Scaled to the target's length, because the risk is not symmetric. Two edits
 * on "conductor" still names Conductor and nothing else; two edits on "pi"
 * names half the dictionary. A crew is a handful of short words, so a
 * generous rule here does not produce a friendlier assistant — it produces
 * dictation typed into the wrong agent's terminal, which is the one failure
 * this whole path must not have.
 */
export function editsAllowed(length: number): number {
  if (length <= 4) return 0
  if (length <= 8) return 1
  return 2
}

/** Levenshtein, two rows. Names are short; this is not the expensive part. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i]
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    previous = row
  }
  return previous[b.length]
}

/**
 * The one roster entry a mishearing unambiguously meant, or null.
 *
 * Null for every interesting doubt: nothing near enough, two entries equally
 * near, or a target too short to have a margin. An ambiguity that reaches the
 * parser as a miss becomes "which one?" out loud, which is the right answer;
 * an ambiguity resolved here would be a choice made for the owner in silence.
 */
export function nearestName<T extends Named>(said: string, pool: readonly T[]): T | null {
  const wanted = fold(said)
  if (wanted === '') return null
  let best: { entry: T; distance: number } | null = null
  let tied = false
  for (const entry of pool) {
    // Aliases are candidates too: a mishearing of a nickname is still a
    // mishearing of that agent.
    for (const candidate of [entry.name, ...(entry.aliases ?? [])]) {
      const target = fold(candidate)
      if (target === '') continue
      const distance = editDistance(wanted, target)
      if (distance > editsAllowed(target.length)) continue
      if (best === null || distance < best.distance) {
        best = { entry, distance }
        tied = false
      } else if (distance === best.distance && best.entry !== entry) {
        tied = true
      }
    }
  }
  return best === null || tied ? null : best.entry
}

/** The names on the canvas right now — what an ear can be checked against. */
export interface HearingVocabulary {
  /** Folded name → its length in characters, which is its weight. */
  readonly terms: ReadonlyMap<string, number>
}

/**
 * Build the vocabulary from the roster the controller already holds. Agents
 * and their aliases, and the workspaces, because "switch to Cookrew Dev" is
 * exactly as much evidence about which ear was right as an agent's name is.
 */
export function vocabularyOf(roster: {
  readonly agents: readonly Named[]
  readonly workspaces: readonly Named[]
}): HearingVocabulary {
  const terms = new Map<string, number>()
  const add = (value: string): void => {
    const folded = fold(value)
    // A one or two character term matches inside almost any sentence and would
    // be evidence of nothing.
    if (folded.length < 3) return
    terms.set(folded, Math.max(terms.get(folded) ?? 0, folded.length))
  }
  for (const entry of [...roster.agents, ...roster.workspaces]) {
    add(entry.name)
    for (const alias of entry.aliases ?? []) add(alias)
  }
  return { terms }
}

/**
 * How much of the canvas an ear actually named.
 *
 * Length-weighted: a long name matched is stronger evidence than a short one,
 * because a long one is far less likely to have turned up by accident. Scored
 * on the FOLDED sentence so it reads a name the same way the resolver will —
 * a score that disagreed with the resolver would rank an ear first and then
 * fail to parse it.
 */
export function vocabularyScore(text: string, vocabulary: HearingVocabulary): number {
  const folded = fold(text)
  if (folded === '') return 0
  let score = 0
  for (const [term, weight] of vocabulary.terms) {
    if (folded.includes(term)) score += weight
  }
  return score
}

/**
 * The hypotheses, best-heard first.
 *
 * STABLE: equal evidence keeps the order the ears came in, so the primary
 * stays primary unless another ear can show it heard more of the canvas. A
 * rerank that churned on ties would make which ear wins depend on the sort,
 * which is the failure being fixed, wearing a different hat.
 *
 * Nothing is dropped. The controller still decides what a better hypothesis is
 * allowed to change — only a COMMAND is worth switching an ear for, and
 * dictated prose stays the primary's words whatever this returns.
 */
export function rankHearings(
  hypotheses: readonly string[],
  vocabulary: HearingVocabulary
): string[] {
  return hypotheses
    .map((text, at) => ({ text, at, score: vocabularyScore(text, vocabulary) }))
    .sort((a, b) => (b.score - a.score) || (a.at - b.at))
    .map((entry) => entry.text)
}
