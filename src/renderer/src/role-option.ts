import type { AgentRole } from '../../shared/model'

/**
 * The role name to offer a "fork from role" option for, or null. Gated
 * unconditionally on the role actually existing in the loaded RoleStore list:
 * offering it for an unsaved role (or before role:list resolves, when the
 * list is still empty) makes planTerminal throw 'No saved role'. The option
 * simply appears once the roles list contains the node's role.
 */
export function resolveRoleOption(
  nodeRole: string | null | undefined,
  roles: AgentRole[]
): string | null {
  if (!nodeRole) return null
  return roles.some((r) => r.name === nodeRole) ? nodeRole : null
}
