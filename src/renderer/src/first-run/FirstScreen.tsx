import { useEffect, useState } from 'react'
import { promptBox } from '../prompt/box-focus'
import { draftKey, setDraft } from '../prompt/prompt-draft'
import { dirLabel } from '../workspace-v2'
import { EXAMPLE_TASKS, FIRST_SCREEN_COPY } from '../../../shared/first-run-copy'
import { firstFolder, useFirstFolder } from './first-folder'

/**
 * THE FIRST SCREEN: one question, and the app's own prompt box to answer it
 * in. There is deliberately no field here. The box at the foot of the app is
 * held open (GlobalPrompt.tsx), an example lands in its draft, and Enter
 * starts the agent the way every agent starts, so the person also learns
 * where they will type from now on.
 */

export function FirstScreenView({
  folder,
  problem,
  onChoose,
  onExample
}: {
  folder: string | null
  problem: string | null
  onChoose: () => void
  onExample: (task: string) => void
}): React.JSX.Element {
  return (
    <section className="fr-stage fr-task" aria-label={FIRST_SCREEN_COPY.ASK}>
      <div className="fr-col">
        <h1 className="fr-title">{FIRST_SCREEN_COPY.ASK}</h1>
        <p className="fr-lede">{FIRST_SCREEN_COPY.LEDE}</p>
        <button type="button" className={`fr-folder${folder ? ' chosen' : ''}`} onClick={onChoose}>
          {folder && <span className="fr-folder-word">{FIRST_SCREEN_COPY.FOLDER_NOTE}</span>}
          {folder ? (
            <span className="fr-folder-name" title={folder}>
              <b>{dirLabel(folder)}</b>
              <small>{folder}</small>
            </span>
          ) : (
            <span className="fr-folder-name">
              <b>{FIRST_SCREEN_COPY.FOLDER}</b>
            </span>
          )}
          {folder && <span className="fr-folder-change">{FIRST_SCREEN_COPY.FOLDER_CHANGE}</span>}
        </button>
        {problem && (
          <p className="fr-error" role="alert">
            {problem}
          </p>
        )}
        <p className="fr-try">{FIRST_SCREEN_COPY.TRY}</p>
        <ul className="fr-examples">
          {EXAMPLE_TASKS.map((task) => (
            <li key={task}>
              <button type="button" className="fr-example" onClick={() => onExample(task)}>
                {task}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

export function FirstScreen(): React.JSX.Element {
  const folder = useFirstFolder()
  const [problem, setProblem] = useState<string | null>(null)
  // The caret starts in the box: typing is what this screen asks for.
  useEffect(() => promptBox.focus(), [])
  return (
    <FirstScreenView
      folder={folder}
      problem={problem}
      onChoose={() => {
        setProblem(null)
        void firstFolder.choose().then((outcome) => {
          if (outcome === 'failed') setProblem(FIRST_SCREEN_COPY.FOLDER_FAILED)
          promptBox.focus()
        })
      }}
      onExample={(task) => {
        setDraft(draftKey(null), task)
        promptBox.focus()
      }}
    />
  )
}
