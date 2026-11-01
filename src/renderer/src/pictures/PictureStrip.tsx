import { useState } from 'react'
import { imagePathsIn, imageRefKey, type ImageRef, type TraceImage } from '../../../shared/prompt-images'
import { usePicture } from './use-picture'
import './pictures.css'

/**
 * A PROMPT'S PICTURES, DRAWN (owner, 2026-11-01): the screenshots of a turn's
 * prompt in the CHAT and LOG views, and of a draft in the prompt box, as
 * small pictures read once they come into view. LIVE is the agent's own
 * terminal and keeps its "[Image #N]".
 */

export interface Picture {
  readonly key: string
  readonly ref: ImageRef
  readonly label: string
  /** The path the draft names it by, when it is a path (the prompt box takes it out by this). */
  readonly path?: string
  /** Claude Code's own paste: captioned with its "Image #N", as the words call it. */
  readonly pasted?: boolean
}

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

const ofPaths = (text: string): Picture[] =>
  imagePathsIn(text).map((path) => ({ key: imageRefKey({ path }), ref: { path }, label: baseName(path), path }))

/** A turn's pictures: Claude Code's own pastes, then the screenshots its words name by path. */
export function picturesOfTurn(
  block: { prompt: string; images?: readonly TraceImage[]; file?: string },
  terminalId: string | null
): Picture[] {
  const pasted: Picture[] =
    terminalId && block.file
      ? (block.images ?? []).map((image) => {
          const ref = { terminalId, file: block.file as string, uuid: image.uuid, i: image.i }
          return { key: imageRefKey(ref), ref, label: image.n !== undefined ? `Image #${image.n}` : 'Image', pasted: true }
        })
      : []
  return [...pasted, ...ofPaths(block.prompt)]
}

/** A draft's pictures: the screenshots it names by path. */
export const picturesOfDraft = ofPaths

export function PictureStrip({
  pictures,
  className = '',
  expandable = false,
  onRemove
}: {
  pictures: readonly Picture[]
  className?: string
  /** A tap shows the picture large (the transcript); the prompt box's stay small. */
  expandable?: boolean
  onRemove?: (picture: Picture) => void
}): React.JSX.Element | null {
  if (pictures.length === 0) return null
  return (
    <div className={`cr-pics ${className}`}>
      {pictures.map((picture) => (
        <PictureThumb key={picture.key} picture={picture} expandable={expandable} onRemove={onRemove} />
      ))}
    </div>
  )
}

function PictureThumb({
  picture,
  expandable,
  onRemove
}: {
  picture: Picture
  expandable: boolean
  onRemove?: (picture: Picture) => void
}): React.JSX.Element {
  const { bind, url, state } = usePicture(picture.ref)
  const [open, setOpen] = useState(false)
  return (
    <figure ref={bind} className={`cr-pic ${state}${open ? ' open' : ''}`} title={picture.label}>
      {url ? (
        <img
          src={url}
          alt={picture.label}
          decoding="async"
          draggable={false}
          onClick={expandable ? () => setOpen((o) => !o) : undefined}
        />
      ) : (
        <span className="cr-pic-name">{state === 'missing' ? picture.label : ''}</span>
      )}
      {picture.pasted && <figcaption>{picture.label}</figcaption>}
      {onRemove && (
        <button
          type="button"
          className="cr-pic-x"
          aria-label={`Take ${picture.label} out of the prompt`}
          title="Take it out of the prompt"
          // Keep the box's focus and caret.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onRemove(picture)}
        >
          ×
        </button>
      )}
    </figure>
  )
}
