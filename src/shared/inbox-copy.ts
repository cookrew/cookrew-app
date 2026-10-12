// The inbox's words that are not sentences: the mark each kind of row wears.
import type { InboxKind } from './inbox-rank'

export const INBOX_MARK: Record<InboxKind, string> = {
  waiting: '?',
  secret: '\u{1F511}',
  dispatch: '!',
  sous: '\u21BB',
  signin: '\u{1F310}'
}
