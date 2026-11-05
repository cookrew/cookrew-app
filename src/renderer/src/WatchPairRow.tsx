import { useEffect, useState } from 'react'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { spacedCode, timeLeft, typedAddress, type WatchCode } from './watch-code'

/**
 * ⋯ → APPLE WATCH: six digits to type on the wrist, and where the watch finds
 * this Mac. The row stands open with them, counting down; the menu is not
 * closed by it, since the digits have to stay readable while they are typed.
 */
export function WatchPairRow(): React.JSX.Element | null {
  const api = cookrew()
  const [code, setCode] = useState<WatchCode | null>(null)
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!code) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [code])

  if (!api.watchCode) return null
  const left = code ? timeLeft(code.expiresAt, now) : null
  const showing = code !== null && left !== null
  const ask = (event: React.MouseEvent): void => {
    event.stopPropagation()
    setFailed(false)
    api.watchCode?.().then(
      (next) => {
        setNow(Date.now())
        setCode(next)
      },
      () => setFailed(true)
    )
  }
  return (
    <button type="button" className={`cr-more-item${showing ? ' tall' : ''}`} title="Pair an Apple Watch with this Mac" onClick={ask}>
      <CrIcon name="watch" />
      {showing ? (
        <span className="cr-more-label">
          <b>{spacedCode(code.code)}</b> · {left}
          <br />
          {typedAddress(code.bases) ?? 'no address'}
        </span>
      ) : (
        <span className="cr-more-label">{failed ? 'Apple Watch · try again' : 'Apple Watch…'}</span>
      )}
    </button>
  )
}
