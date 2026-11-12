import { isSkinId, type SkinId } from '../../../shared/skins'
import { cookrew } from '../api'
import { scopeNeedsMachine } from '../machine-scope'
import { setTheme, themeNow } from '../color-scheme'

/*
 * THE ACCOUNT'S SKIN, ON THIS PAGE (main/skin-store.ts holds it).
 *
 * The page paints the last skin it wore before it hears anything (the boot
 * reads the device's copy, color-scheme.ts), then wears whatever the Mac
 * says: at once, and on every change, whichever window, phone or Mac picked
 * it. A pick here is worn first and sent after, so the click answers at once;
 * a pick the Mac refuses (a read-only token) goes back to the one it holds.
 */

const wear = (value: unknown): void => {
  if (isSkinId(value) && value !== themeNow()) setTheme(value)
}

/** Once at boot; the phone's stream also says it on opening. */
export function followAccountSkin(): () => void {
  // A console with no machine entered yet has nobody to ask.
  if (scopeNeedsMachine()) return () => undefined
  const api = cookrew()
  void api.skin?.().then(wear, () => undefined)
  return api.onSkin?.(wear) ?? (() => undefined)
}

export function chooseSkin(skin: SkinId): void {
  const before = themeNow()
  setTheme(skin)
  const sent = cookrew().setSkin?.(skin)
  void sent?.then(
    (held) => {
      if (held === null) wear(before)
    },
    () => wear(before)
  )
}
