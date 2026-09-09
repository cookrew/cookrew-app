/**
 * Base64 to bytes, without the network. `Uint8Array.fromBase64` is the
 * native path where the engine has it; the loop is the fallback. A data:
 * fetch is NOT an option here: the renderer's CSP `connect-src` does not
 * admit data:, and widening it for a decode would be the wrong trade.
 */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> }).fromBase64
  if (typeof native === 'function') return native(text)
  const binary = atob(text)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}
