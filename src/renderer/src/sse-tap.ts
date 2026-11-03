/**
 * An EventSource that reports every message's data before its listener runs
 * (the phone beacon's wire counter).
 *
 * Each listener gets ONE wrapper per (instance, type), remembered, so
 * removeEventListener finds it and a second add of the same listener is
 * deduplicated the way a real EventTarget does. A fresh closure per add broke
 * both: no companion stream listener could ever be removed, and StrictMode's
 * mount/unmount/mount left every subscriber attached twice.
 */
export function tapEventSource(RealES: typeof EventSource, onMessage: (data: string) => void): typeof EventSource {
  const Tapped = function (this: EventSource, ...args: ConstructorParameters<typeof EventSource>) {
    const es = new RealES(...args)
    const realAdd = es.addEventListener.bind(es)
    const realRemove = es.removeEventListener.bind(es)
    const wrappers = new Map<string, WeakMap<EventListener, EventListener>>()
    const wrapperOf = (type: string, fn: EventListener): EventListener => {
      const byFn = wrappers.get(type) ?? new WeakMap<EventListener, EventListener>()
      wrappers.set(type, byFn)
      const known = byFn.get(fn)
      if (known) return known
      const wrapped = ((e: MessageEvent) => {
        onMessage(typeof e?.data === 'string' ? e.data : '')
        return fn(e)
      }) as EventListener
      byFn.set(fn, wrapped)
      return wrapped
    }
    es.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions) =>
      typeof fn === 'function' ? realAdd(type, wrapperOf(type, fn), opts) : realAdd(type, fn, opts)) as typeof es.addEventListener
    es.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: EventListenerOptions) => {
      const wrapped = typeof fn === 'function' ? wrappers.get(type)?.get(fn) : undefined
      realRemove(type, wrapped ?? fn, opts)
    }) as typeof es.removeEventListener
    return es
  } as unknown as typeof EventSource
  Tapped.prototype = RealES.prototype
  return Tapped
}
