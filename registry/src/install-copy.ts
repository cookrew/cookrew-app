/**
 * THE INSTALL PAGE'S WORDS — `mkt.install.*`, a NEW SURFACE.
 *
 * ⚠️ PROVISIONAL. VELVET OWNS THIS COPY AND HAS NOT WRITTEN IT YET.
 *
 * The deck's surface table (section 1) has no entry for this page: the closest,
 * `mkt.browse.*`, is the market card INSIDE the app, which is a different
 * reader in a different place. So these strings are placeholders that follow
 * her rules as far as a developer can — one sentence per slot, no status codes
 * and no protocol vocabulary (R14), no reassurance offered as fact — and they
 * live alone in this file so replacing them is a one-file diff with no hunt.
 *
 * The slots, and what each has to do:
 *
 *   title          the preset, named. Nothing else competes with it.
 *   byline         who published it and which version this link points at.
 *   lede           what a Cookrew preset IS, for someone who has never heard of
 *                  one — this page's most likely reader.
 *   howto          the one true way to act on this link. It must not imply the
 *                  page can do it.
 *   noapp          where to get Cookrew, said once and without a pitch.
 *   review.note    THE LOAD-BEARING ONE: opening a link is not installing. The
 *                  app checks the signature and shows the contents first, and
 *                  the person decides. If a reader takes one thing from this
 *                  page, it should be that nothing happens without them.
 *   gated.note     this preset needs an account before it can be downloaded.
 *   unknown.title  the link names no preset we hold.
 *   unknown.body   why that might be, without blaming the reader.
 *
 * WHAT THIS PAGE MAY NOT SAY, whoever writes it: that the preset is verified,
 * signed, safe or trusted. Per A5 the client verifies for ITSELF, and a
 * registry page asserting the soundness of its own bytes is exactly the trust
 * the signing design exists not to ask for. `registry-a4.test.ts` fails on
 * those words, so this is a constraint on the copy, not a note about it.
 */
export const MKT_INSTALL = {
  'mkt.install.title': '{presetName}',
  // {author} arrives as @handle and {version} already carries R8's label — both
  // are deck section 7 rules that hold on every surface, so they are applied by
  // shared/marketplace-copy.ts rather than spelled into this template.
  'mkt.install.byline': 'published by {author} · {version}',
  'mkt.install.lede': 'A Cookrew preset — a team of AI agents you can place on your canvas.',
  'mkt.install.howto': 'Open this link in Cookrew to place it.',
  'mkt.install.noapp': 'Cookrew is open source. You can get it here:',
  'mkt.install.review.note':
    'Opening a link installs nothing. Cookrew checks the preset itself and shows you what it contains, and you decide.',
  'mkt.install.gated.note': 'This preset needs an account before it can be downloaded.',
  'mkt.install.unknown.title': 'This link does not point at a preset.',
  'mkt.install.unknown.body': 'It may have been removed, or the link may be incomplete.'
} as const

export type MktInstallId = keyof typeof MKT_INSTALL

/**
 * Where Cookrew comes from. The repository rather than a marketing page,
 * because it is the URL that certainly exists and certainly resolves.
 */
export const COOKREW_HOME = 'https://github.com/cookrew/cookrew-app'

/** Fill `{placeholders}`. Throws rather than render a brace at a reader. */
export function fillInstallCopy(
  template: string,
  vars: Readonly<Record<string, string | number>>
): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = vars[name]
    if (value === undefined) throw new Error(`install copy: no value for {${name}}`)
    return String(value)
  })
}
