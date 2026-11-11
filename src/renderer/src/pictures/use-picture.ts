import { registerScopeState } from '../machine-scope'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageRef } from '../../../shared/prompt-images'
import { cookrew } from '../api'
import { createPictureCache, type PictureCache } from './picture-cache'

/** How far ahead of the screen a picture starts loading. */
const AHEAD = '300px'

let cache: PictureCache | null = null
const theCache = (): PictureCache => {
  if (!cache) {
    // An older desktop bridge has no readImage: nothing to draw, not a crash.
    cache = createPictureCache((ref) => {
      const api = cookrew()
      return typeof api.readImage === 'function' ? api.readImage(ref) : Promise.resolve(null)
    })
  }
  return cache
}

// A picture is read from ONE machine, by a path or an id that means nothing on another.
registerScopeState('pictures', () => {
  cache?.clear()
  cache = null
})

export type PictureState = 'waiting' | 'loading' | 'shown' | 'missing'

/**
 * A picture, read once its element comes near the screen and never before
 * (owner, 2026-11-01: lazy). `bind` goes on the element that stands in for it.
 */
export function usePicture(ref: ImageRef): { bind: (el: HTMLElement | null) => void; url: string | null; state: PictureState } {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [near, setNear] = useState(false)
  const [found, setFound] = useState<{ url: string | null } | null>(null)
  const refNow = useRef(ref)
  refNow.current = ref
  const bind = useCallback((node: HTMLElement | null) => setEl(node), [])

  useEffect(() => {
    if (!el || near) return
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const watch = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true)
    }, { rootMargin: AHEAD })
    watch.observe(el)
    return () => watch.disconnect()
  }, [el, near])

  useEffect(() => {
    if (!near) return
    let live = true
    void theCache()
      .load(refNow.current)
      .then((url) => {
        if (live) setFound({ url })
      })
    return () => {
      live = false
    }
  }, [near])

  const state: PictureState = !near ? 'waiting' : found === null ? 'loading' : found.url ? 'shown' : 'missing'
  return { bind, url: found?.url ?? null, state }
}
