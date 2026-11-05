/** A Storage with nothing behind it, for code that keeps a credential in one. */
export function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const held = new Map<string, string>()
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: (key) => void held.delete(key)
  }
}

/** Enough of `window` for the auth store to open in a test with no DOM. */
export function bareWindow(href = 'https://cookrew.dev/'): Record<string, unknown> {
  const { origin, pathname } = new URL(href)
  return {
    location: { origin, href, pathname, search: '', hash: '' },
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    history: { replaceState: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout,
    clearTimeout
  }
}
