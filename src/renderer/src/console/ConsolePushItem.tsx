import { useEffect, useSyncExternalStore } from 'react'
import { pushRowLine, pushWords, type ConsolePush } from './console-push'

/**
 * "TURN ON NOTIFICATIONS", in the account menu (HITL phase 4). The menu is
 * opened by a press, and the check runs then, so the registry's key is in hand
 * before the person presses again. Push off at the registry draws nothing.
 *
 * Under it, every browser the account tells, each with a Remove (security
 * review M2): the owner sees what is subscribed and can take any of it off.
 */
export function PushMenuItem({ push }: { push: Pick<ConsolePush, 'get' | 'subscribe' | 'check' | 'turnOn' | 'turnOff' | 'remove'> }): React.JSX.Element | null {
  const state = useSyncExternalStore(push.subscribe, push.get, push.get)
  useEffect(() => {
    void push.check()
  }, [push])
  const words = pushWords(state)
  if (words === null) return null
  const press = (): void => void (words.action === 'on' ? push.turnOn() : push.turnOff())
  const rows = state.rows ?? []
  return (
    <>
      {words.action !== null && (
        <button type="button" className="cd-quiet" role="menuitem" onClick={press}>
          {words.button}
        </button>
      )}
      {words.says !== null && (
        <span className="cd-push-says" role="status">
          {words.says}
        </span>
      )}
      {rows.length > 0 && (
        <ul className="cd-push-rows" aria-label="Browsers told about your agents">
          {rows.map((row) => (
            <li key={row.id}>
              <span>{pushRowLine(row)}</span>
              <button type="button" className="cd-quiet" onClick={() => void push.remove(row.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
