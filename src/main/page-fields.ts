// WHERE THE PAGE'S TEXT FIELDS ARE, so a phone can raise its keyboard.
//
// A browser card is a picture on the phone. Tapping an <input> in it focuses
// that input inside the card's headless Chrome — and nothing on the phone,
// because there is nothing focusable there. iOS shows its keyboard only when an
// element is focused INSIDE the tap's own event handler, and the answer "was
// that a text field?" arrives a round trip later. So the page says ahead of
// time where its fields are, and the phone decides on its own, synchronously,
// in the tap: a tap on a field focuses the phone's key field (useRemoteKeyboard)
// and the keyboard comes up.
//
// The page also says when its focus moves (focusin/focusout): a field that
// loses focus closes a keyboard that a tap opened, and one focused by the page
// itself lets Android raise its keyboard (it allows that for a few seconds
// after a gesture; iOS does not).
//
// The script reports only while a viewer watches (`__cookrewFieldsWatch`), and
// only what changed. What it sends is the page's word, so it is sanitized
// here like any other untrusted input: bounded counts, finite numbers, a
// closed set of keyboard modes. The worst a lying page can do is raise a
// keyboard — which a real browser lets a page do by focusing a field.

export const FIELDS_BINDING = '__cookrewFields'
export const FIELDS_WATCH = '__cookrewFieldsWatch'
export const MAX_FIELDS = 64

/** The soft keyboard a field wants (inputmode / type). */
export type FieldMode = 'text' | 'numeric' | 'decimal' | 'tel' | 'email' | 'url' | 'search' | 'password'
const MODES: readonly FieldMode[] = ['text', 'numeric', 'decimal', 'tel', 'email', 'url', 'search', 'password']

/** [x, y, width, height] — CSS px of the visual viewport (page side) or frame px (wire). */
export type FieldRect = [number, number, number, number]

export interface FieldReport {
  focus: { editable: boolean; rect: FieldRect | null; mode: FieldMode }
  fields: Array<{ rect: FieldRect; mode: FieldMode }>
}

/**
 * Injected into every top-level document of a card (and the one already
 * loaded). Idempotent. Says hello on start so main can switch a page on that
 * loaded after the viewer started watching.
 */
export const PAGE_FIELDS_SCRIPT = `(() => {
  if (window.top !== window || window.__cookrewFieldsHooked) return
  Object.defineProperty(window, '__cookrewFieldsHooked', { value: true })
  const TEXT = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'])
  const MODES = new Set(['numeric', 'decimal', 'tel', 'email', 'url', 'search'])
  const call = (payload) => {
    try {
      if (typeof window.${FIELDS_BINDING} === 'function') window.${FIELDS_BINDING}(payload)
    } catch (_) {}
  }
  const editable = (el) => {
    if (!el || el.disabled || el.readOnly) return false
    if (el.isContentEditable) return true
    if (el.tagName === 'TEXTAREA') return true
    if (el.tagName === 'INPUT') return TEXT.has(String(el.getAttribute('type') || '').toLowerCase())
    return false
  }
  const modeOf = (el) => {
    const asked = String((el.getAttribute && el.getAttribute('inputmode')) || '').toLowerCase()
    if (MODES.has(asked)) return asked
    if (el.tagName === 'INPUT') {
      const type = String(el.getAttribute('type') || '').toLowerCase()
      if (type === 'number') return 'decimal'
      if (type === 'tel' || type === 'email' || type === 'url' || type === 'search' || type === 'password') return type
    }
    return 'text'
  }
  const box = (el) => {
    const r = el.getBoundingClientRect()
    const vv = window.visualViewport
    const ox = vv ? vv.offsetLeft : 0
    const oy = vv ? vv.offsetTop : 0
    const vw = vv ? vv.width : innerWidth
    const vh = vv ? vv.height : innerHeight
    const x = Math.max(0, r.left - ox)
    const y = Math.max(0, r.top - oy)
    const right = Math.min(vw, r.right - ox)
    const bottom = Math.min(vh, r.bottom - oy)
    if (right - x < 2 || bottom - y < 2) return null
    return [Math.round(x), Math.round(y), Math.round(right - x), Math.round(bottom - y)]
  }
  let on = false
  let timer = 0
  let poll = 0
  let last = ''
  const report = () => {
    timer = 0
    if (!on) return
    let active = document.activeElement
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement
    const focused = editable(active)
    const focus = { editable: focused, rect: focused ? box(active) : null, mode: focused ? modeOf(active) : 'text' }
    const fields = []
    const nodes = document.querySelectorAll('input, textarea, [contenteditable]:not([contenteditable="false"])')
    for (let i = 0; i < nodes.length && fields.length < ${MAX_FIELDS}; i++) {
      const el = nodes[i]
      if (!editable(el)) continue
      const rect = box(el)
      if (rect) fields.push({ rect, mode: modeOf(el) })
    }
    const json = JSON.stringify({ focus, fields })
    if (json === last) return
    last = json
    call(json)
  }
  const soon = () => {
    if (on && !timer) timer = setTimeout(report, 100)
  }
  for (const type of ['focusin', 'focusout', 'scroll', 'pointerup', 'touchend', 'keyup', 'input']) {
    window.addEventListener(type, soon, { capture: true, passive: true })
  }
  window.addEventListener('resize', soon)
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', soon)
    window.visualViewport.addEventListener('scroll', soon)
  }
  Object.defineProperty(window, '${FIELDS_WATCH}', {
    value: (next) => {
      on = next === true
      last = ''
      clearInterval(poll)
      poll = on ? setInterval(soon, 800) : 0
      if (on) soon()
    }
  })
  call('hello')
})()`

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function rectOf(raw: unknown): FieldRect | null {
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every(finite)) return null
  const [x, y, w, h] = raw as number[]
  if (w <= 0 || h <= 0 || x < -1 || y < -1 || x > 20_000 || y > 20_000 || w > 20_000 || h > 20_000) return null
  return [x, y, w, h]
}

function modeOf(raw: unknown): FieldMode {
  return MODES.includes(raw as FieldMode) ? (raw as FieldMode) : 'text'
}

/** The page's report, or null for anything that is not one (a hello, junk, a lie too big to carry). */
export function sanitizeFieldReport(payload: unknown): FieldReport | null {
  if (typeof payload !== 'string' || payload.length > 32_768) return null
  let raw: unknown
  try {
    raw = JSON.parse(payload)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const focusRaw = (typeof record.focus === 'object' && record.focus !== null ? record.focus : {}) as Record<string, unknown>
  const editable = focusRaw.editable === true
  const fields: FieldReport['fields'] = []
  if (Array.isArray(record.fields)) {
    for (const entry of record.fields.slice(0, MAX_FIELDS)) {
      if (typeof entry !== 'object' || entry === null) continue
      const rect = rectOf((entry as Record<string, unknown>).rect)
      if (rect) fields.push({ rect, mode: modeOf((entry as Record<string, unknown>).mode) })
    }
  }
  return {
    focus: { editable, rect: editable ? rectOf(focusRaw.rect) : null, mode: editable ? modeOf(focusRaw.mode) : 'text' },
    fields
  }
}

/** Visual-viewport CSS px → the frame's px (cast-input.ts · MapContext.displayScale), rounded. */
export function fieldsInFrame(report: FieldReport, displayScale: number): FieldReport {
  const s = Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1
  const scale = (rect: FieldRect): FieldRect => [
    Math.round(rect[0] * s),
    Math.round(rect[1] * s),
    Math.round(rect[2] * s),
    Math.round(rect[3] * s)
  ]
  return {
    focus: { ...report.focus, rect: report.focus.rect ? scale(report.focus.rect) : null },
    fields: report.fields.map((field) => ({ rect: scale(field.rect), mode: field.mode }))
  }
}
