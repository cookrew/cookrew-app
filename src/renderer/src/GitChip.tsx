import { useEffect, useState } from 'react'
import type { GitInfo } from '../../shared/model'
import { cookrew } from './api'
import { CrIcon } from './icons'

/**
 * Git visuals (Forge gitInfo shape): branch chip · dirty dot · ahead/behind
 * badge for a directory. One presentational unit, styled by .cr-git in
 * styles.css; reused on dark agent cards and (with onCream) cream
 * workspace-dir rows.
 *
 * Data: pass a pre-fetched `git` prop, OR a `dir` to self-source via
 * cookrew().gitInfo(dir). The call is optional-chained so this component is
 * inert until Forge lands the api method + demo stub — nothing breaks in the
 * meantime; it simply renders null.
 */

type GitApi = { gitInfo?: (dir: string) => Promise<GitInfo | null> }

export function GitChip({
  dir,
  git: gitProp,
  onCream
}: {
  dir?: string
  git?: GitInfo | null
  onCream?: boolean
}): React.JSX.Element | null {
  const [fetched, setFetched] = useState<GitInfo | null>(null)

  useEffect(() => {
    if (gitProp !== undefined || !dir) return
    const gitInfo = (cookrew() as unknown as GitApi).gitInfo
    if (!gitInfo) return
    let alive = true
    void gitInfo(dir)
      .then((info) => {
        if (alive) setFetched(info)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [dir, gitProp])

  const git = gitProp ?? fetched
  if (!git || !git.isRepo || git.error) return null

  const showTrack = git.ahead > 0 || git.behind > 0
  return (
    <span className={onCream ? 'cr-git on-cream' : 'cr-git'}>
      {git.branch && (
        <span className="cr-git-branch" title={`${git.branch}${git.dirty ? ' · uncommitted changes' : ''}`}>
          <CrIcon name="fork" />
          {git.branch}
        </span>
      )}
      {git.dirty && <span className="cr-git-dirty" title="Uncommitted changes" />}
      {showTrack && (
        <span
          className="cr-git-track"
          title={`${git.ahead} ahead · ${git.behind} behind`}
        >
          {git.ahead > 0 && <span className="cr-git-ahead">{git.ahead}</span>}
          {git.behind > 0 && <span className="cr-git-behind">{git.behind}</span>}
        </span>
      )}
    </span>
  )
}
