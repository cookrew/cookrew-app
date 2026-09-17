/**
 * WHAT A `cookrew://` LINK MAY ASK FOR — the shape both processes agree on.
 *
 * Main parses (src/main/deep-link.ts) and the renderer acts; this is the one
 * type between them, so the channel `app:deep-link` can never carry a verb
 * the renderer has no surface for. Nothing here is raw: an address has been
 * checked against the same parser the import sheet uses, and a preset id is
 * a content address, so a link that reaches the renderer is already safe to
 * put in a field.
 */
export type DeepLink =
  | { verb: 'import'; address: string; session?: 'new' }
  | { verb: 'install'; presetId: string }
  | { verb: 'serve'; address: string }
  /**
   * `cookrew://join#<code>` (v3, D8): a join code minted on a device the
   * account already trusts. The code rides the FRAGMENT so that the https
   * page that hands the link over (cookrew.dev/join) never sees it on the
   * wire; it is normalised to the `XXXX-XXXX` form the registry prints.
   */
  | { verb: 'join'; code: string }

/** The main → renderer channel a parsed link travels on. */
export const DEEP_LINK_CHANNEL = 'app:deep-link'
