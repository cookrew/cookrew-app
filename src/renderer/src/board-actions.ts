/**
 * WHAT THE SEARCH BOX CAN DO, besides find agents. "new workspace" used to
 * return nothing, and a new user looks there first. An action shows only for
 * words that plainly ask for it, so an agent's name is never pushed down.
 */
export type BoardActionId = 'new-workspace' | 'rename-workspace'

export interface BoardAction {
  id: BoardActionId
  label: string
  hint: string
}

const ACTIONS: readonly (BoardAction & { words: readonly string[] })[] = [
  {
    id: 'new-workspace',
    label: 'New workspace',
    hint: 'Give agents a folder of their own',
    words: ['new', 'workspace', 'create', 'add', 'make']
  },
  {
    id: 'rename-workspace',
    label: 'Rename this workspace',
    hint: 'Change its name or icon',
    words: ['rename', 'name', 'icon', 'this', 'workspace']
  }
]

/** Every word typed starts a word of the action. */
const asks = (query: string, words: readonly string[]): boolean =>
  query.split(/\s+/).every((typed) => words.some((word) => word.startsWith(typed)))

export function boardActions(raw: string): BoardAction[] {
  const query = raw.trim().toLowerCase()
  if (query.length === 0) return []
  return ACTIONS.filter((action) => asks(query, action.words)).map(({ id, label, hint }) => ({ id, label, hint }))
}

/** An action row above the list is a match: "Nothing matches" under it reads as a lie. */
export const saysNothingMatches = ({ hits, actions }: { hits: number; actions: number }): boolean => hits === 0 && actions === 0
