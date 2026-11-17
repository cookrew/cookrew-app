import { useEffect } from 'react'
import { useThumb } from '../activity-thumb-store'
import { thumbWants } from '../pets/thumb-wants'
import type { ItemView } from './zoom-model'

export function WorkspaceTileShot({ item, owner, children }: { item: ItemView; owner: string; children: React.ReactNode }): React.JSX.Element {
  const shot = useThumb(item.id)
  useEffect(() => {
    if (item.kind !== 'browser') return
    thumbWants.claim(owner, [item.id])
    return () => thumbWants.release(owner)
  }, [item.id, item.kind, owner])
  if (item.kind !== 'browser' || !shot) return <>{children}</>
  return <div className="dm-page browser shot"><div className="dm-bar"><i style={{ background: item.tint }} /><span>{item.host}</span></div><img className="dm-shot" src={shot} alt="" draggable={false} /></div>
}
