import { useCallback, useEffect, useRef, useState } from 'react'
import type { UseSource, UseSourceCard } from '../../../shared/use-sources'
import { cookrew } from '../api'
import { closeSourcePicker, useSourceAsk } from './source-picker-store'
import { firstTab, type SourceLoad, type SourceTab } from './source-sheet'
import { remoteWhere, useRemoteActs } from './remote-acts'
import { RemoteConfirmView } from './RemotePanel'
import { SourceSheet } from './SourceSheet'
import './source-picker.css'

/**
 * THE WINDOW PICKER (desktop and phone): one sheet, asked for through
 * source-picker-store.ts. It reads the list once when it opens and again on
 * ↻, never on a timer: each read is a capture of every window, and on a phone
 * it is every picture over the relay.
 */

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function OpenPicker({ card, remoteDesktop, onOpened }: { card: string | null; remoteDesktop: boolean; onOpened: (card: UseSourceCard) => void }): React.JSX.Element {
  const [load, setLoad] = useState<SourceLoad>({ status: 'loading' })
  const [tab, setTab] = useState<SourceTab>(remoteDesktop ? 'screens' : 'windows')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tabChosen = useRef(remoteDesktop)
  const asked = useRef(0)

  const read = useCallback(async (): Promise<void> => {
    const mine = (asked.current += 1)
    setLoad({ status: 'loading' })
    setError(null)
    try {
      const list = await cookrew().useSources?.()
      if (mine !== asked.current) return
      if (!list) return setLoad({ status: 'failed', error: 'This client cannot list windows' })
      if (!tabChosen.current) setTab(firstTab(list))
      setLoad({ status: 'ready', list })
    } catch (failure) {
      if (mine === asked.current) setLoad({ status: 'failed', error: messageOf(failure) })
    }
  }, [])

  useEffect(() => {
    void read()
    return () => {
      asked.current += 1
    }
  }, [read])

  useEffect(() => {
    // The dialog holds the focus while it is up, and gives it back when it goes.
    const before = document.activeElement
    document.querySelector<HTMLElement>('.sp-sheet')?.focus()
    return () => {
      if (before instanceof HTMLElement) before.focus()
    }
  }, [])

  useEffect(() => {
    // Capture: another handler swallows Escape before a bubbling listener sees it.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      closeSourcePicker()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const pick = async (source: UseSource): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const opened = await cookrew().openUseSource?.({ source: source.id, ...(card ? { card } : {}) })
      if (opened?.ok) {
        closeSourcePicker()
        onOpened(opened.card)
      } else {
        setError(opened?.error ?? 'This client cannot open a window')
      }
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }

  const acts = useRemoteActs({ state: load.status === 'ready' ? load.list.remote : null, onCheck: read })

  return (
    <>
    <SourceSheet
      load={load}
      tab={tab}
      replacing={card !== null}
      busy={busy}
      error={error}
      remoteDesktop={remoteDesktop}
      where={remoteWhere()}
      actNote={acts.note}
      actBusy={acts.busy}
      onTab={(next) => {
        tabChosen.current = true
        setTab(next)
      }}
      onPick={(source) => void pick(source)}
      onRefresh={() => void read()}
      onAct={acts.act}
      onClose={closeSourcePicker}
    />
    {acts.confirm && <div className="sp-confirm"><RemoteConfirmView confirm={acts.confirm} onYes={() => acts.answerConfirm(true)} onNo={() => acts.answerConfirm(false)} /></div>}
    </>
  )
}

export function SourcePicker({ onOpened }: { onOpened: (card: UseSourceCard, made: boolean) => void }): React.JSX.Element | null {
  const ask = useSourceAsk()
  if (!ask) return null
  return <OpenPicker key={ask.card ?? ''} card={ask.card} remoteDesktop={ask.remoteDesktop} onOpened={(card) => onOpened(card, ask.card === null)} />
}
