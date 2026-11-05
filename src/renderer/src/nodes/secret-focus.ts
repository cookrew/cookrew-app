/**
 * A slot's field, focused (the DOM hook: `[data-secret-slot="<name>"]`). It
 * renders a beat after whatever opened it, so look a few times, then give up
 * quietly. The timer is the caller's to clear.
 */
export function focusSlot(name: string, tries: number, timer: { current: number | null }): void {
  const el = document.querySelector<HTMLElement>(`[data-secret-slot="${CSS.escape(name)}"] input, [data-secret-slot="${CSS.escape(name)}"] textarea`)
  timer.current = null
  if (el) {
    el.focus()
    return
  }
  if (tries > 0) timer.current = window.setTimeout(() => focusSlot(name, tries - 1, timer), 300)
}
