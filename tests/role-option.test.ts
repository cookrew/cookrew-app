import { describe, expect, it } from 'vitest'
import { resolveRoleOption } from '../src/renderer/src/role-option'
import type { AgentRole } from '../src/shared/model'

const role = (name: string): AgentRole => ({
  name,
  preset: 'Claude Code',
  command: 'claude',
  rolePrompt: 'do the thing',
  savedAt: 1
})

describe('resolveRoleOption', () => {
  it('offers the role only when it exists in the loaded list', () => {
    expect(resolveRoleOption('Reviewer', [role('Reviewer')])).toBe('Reviewer')
  })

  it('returns null when the roles list is empty / not yet loaded', () => {
    // The regression: raw node.role was returned here, letting the picker
    // offer fork-from-role for a role that would throw 'No saved role'.
    expect(resolveRoleOption('Reviewer', [])).toBe(null)
  })

  it('returns null when the node role has no matching saved role', () => {
    expect(resolveRoleOption('Ghost', [role('Reviewer')])).toBe(null)
  })

  it('returns null for a node with no role', () => {
    expect(resolveRoleOption(null, [role('Reviewer')])).toBe(null)
    expect(resolveRoleOption(undefined, [role('Reviewer')])).toBe(null)
  })
})
