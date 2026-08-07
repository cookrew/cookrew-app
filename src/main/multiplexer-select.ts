// Which backend hosts terminals, and which one answers reads.
//
// These are DIFFERENT questions, and conflating them is how a migration goes
// wrong. Hosting a terminal requires a transparent PTY attach. Answering a
// read — "what is on this pane" — does not, and the better reader may be the
// backend that cannot host anything.
//
// So the selector returns two roles. The invariant it enforces is simple and
// worth stating out loud: a backend whose `capabilities.attach` is false can
// NEVER become the host, no matter how it is configured. That is a structural
// guarantee rather than a convention, because the failure it prevents is
// silent — node-pty would happily consume a TUI stream and the damage would
// surface much later, as a scraper producing nonsense.

import type { Multiplexer } from './multiplexer'

export interface MultiplexerRoles {
  /** Hosts terminals. Must be able to attach transparently. */
  host: Multiplexer
  /**
   * Answers scrollback reads for the board probe. Often the same object as
   * `host`; differs only when a read-only backend is both available and
   * better at it.
   */
  reader: Multiplexer
  /** Why the reader is what it is — surfaced in diagnostics, not inferred. */
  readerReason: string
}

export interface SelectInput {
  /** Backends in preference order; the first attach-capable one hosts. */
  candidates: Multiplexer[]
  /**
   * Opt-in for a read-only accelerator. Off by default: a new backend on the
   * read path changes what the Activity Board shows, and that should be a
   * decision rather than a side effect of installing something.
   */
  preferReadAccelerator?: boolean
}

export class NoHostMultiplexerError extends Error {}

/**
 * Pick the host and the reader.
 *
 * Preference order decides the host among attach-capable, available backends.
 * The reader is the host unless an accelerator is explicitly enabled AND
 * available AND not already the host.
 */
export function selectMultiplexers(input: SelectInput): MultiplexerRoles {
  const available = input.candidates.filter((m) => m.available())

  const host = available.find((m) => m.capabilities.attach)
  if (!host) {
    const seen = input.candidates
      .map((m) => `${m.id}(available=${m.available()}, attach=${m.capabilities.attach})`)
      .join(', ')
    throw new NoHostMultiplexerError(
      `No multiplexer can host a terminal. Tried: ${seen || 'none'}. ` +
        'Cookrew needs one that supports a transparent PTY attach.'
    )
  }

  if (!input.preferReadAccelerator) {
    return { host, reader: host, readerReason: `${host.id} hosts and reads` }
  }

  // An accelerator only earns the read path if it is NOT the host — otherwise
  // this is a no-op with extra words.
  const accelerator = available.find((m) => m !== host && !m.capabilities.attach)
  if (!accelerator) {
    return {
      host,
      reader: host,
      readerReason: `${host.id} reads — no read accelerator available`
    }
  }
  return {
    host,
    reader: accelerator,
    readerReason: `${accelerator.id} reads (unwrapped lines, no chrome); ${host.id} hosts`
  }
}
