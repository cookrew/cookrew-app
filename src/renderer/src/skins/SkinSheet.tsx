// THE SKIN PICKER in ⋯: the account's fourteen looks, each shown in its own
// ground, card, ink, theme colour and face. A press wears it at once and keeps
// it for the account (skin-sync.ts); the sheet stays open to try another.
import { SKINS, skinInfo, type SkinId } from '../../../shared/skins'
import { schemeIsDark, useTheme } from '../color-scheme'
import { CrIcon } from '../icons'
import { skinSwatch } from './skin-look'
import { chooseSkin } from './skin-sync'
import '../grant-surface.css'
import './skin-sheet.css'

export interface SkinSheetViewProps {
  current: SkinId
  night: boolean
  onPick: (skin: SkinId) => void
  onClose: () => void
}

export function SkinSheetView({ current, night, onPick, onClose }: SkinSheetViewProps): React.JSX.Element {
  return (
    <div className="gs-scrim cr-sheet" role="dialog" aria-modal="true" aria-label="Skin">
      <div
        className="gs-sheet cr-sheet skin-sheet"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') onClose()
        }}
      >
        <header className="gs-sheet-head">
          <h2>Skin</h2>
          <button type="button" className="gs-x" onClick={onClose} aria-label="Close" autoFocus>
            ✕
          </button>
        </header>
        <p className="gs-sub">
          The whole app’s look, kept with your account: every Mac signed in to it, and every phone paired with them,
          wears the same one.
        </p>
        <div className="skin-grid" role="radiogroup" aria-label="Skins">
          {SKINS.map((skin) => {
            const swatch = skinSwatch(skin.id, night)
            const on = skin.id === current
            return (
              <button
                key={skin.id}
                type="button"
                role="radio"
                aria-checked={on}
                className={`skin-pick${on ? ' on' : ''}`}
                data-skin={skin.id}
                title={skin.note}
                onClick={() => onPick(skin.id)}
              >
                <span className="skin-swatch" style={{ background: swatch.paper }} aria-hidden="true">
                  <span className="skin-swatch-card" style={{ background: swatch.card, color: swatch.ink, fontFamily: swatch.display }}>
                    <b>Aa</b>
                    <i style={{ background: swatch.muted }} />
                    <i style={{ background: swatch.muted }} />
                  </span>
                  <span className="skin-swatch-seal" style={{ background: swatch.accent, color: swatch.onAccent }}>
                    {on && <CrIcon name="check" />}
                  </span>
                </span>
                <span className="skin-name">
                  {skin.name}
                  <span className="skin-zh" lang="zh">
                    {skin.zh}
                  </span>
                </span>
                <span className="skin-note">{skin.note}</span>
                {skin.mode !== 'both' && <span className="skin-mode">{skin.mode === 'dark' ? 'Always dark' : 'Always light'}</span>}
              </button>
            )
          })}
        </div>
        <p className="gs-hint" aria-live="polite">
          Wearing {skinInfo(current).name}.
        </p>
      </div>
    </div>
  )
}

export function SkinSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const current = useTheme()
  return <SkinSheetView current={current} night={schemeIsDark()} onPick={chooseSkin} onClose={onClose} />
}
