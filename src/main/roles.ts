// Reusable agent personas (~/.cookrew/roles/<slug>.json). Saving a role
// snapshots a terminal's preset/command with a role prompt; terminal
// creation can then boot a fresh agent from the role, and the team-fork
// picker offers "fork from role" for agents that have one.

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AgentRole, TerminalNodeData } from '../shared/model'

/** Filesystem-safe file stem for a role name. */
export function roleSlug(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'role'
}

function isRole(value: unknown): value is AgentRole {
  const r = value as AgentRole
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.name === 'string' &&
    typeof r.preset === 'string' &&
    typeof r.command === 'string' &&
    typeof r.rolePrompt === 'string' &&
    typeof r.savedAt === 'number'
  )
}

export class RoleStore {
  constructor(private dir = path.join(homedir(), '.cookrew', 'roles')) {}

  private fileFor(name: string): string {
    return path.join(this.dir, `${roleSlug(name)}.json`)
  }

  /** Snapshot a terminal node as a role. Same name overwrites (update). */
  save(node: TerminalNodeData, name: string, rolePrompt: string): AgentRole {
    const trimmedName = name.trim()
    if (trimmedName.length === 0) throw new Error('Role name must not be empty')
    if (rolePrompt.trim().length === 0) throw new Error('Role prompt must not be empty')
    if (node.command.trim().length === 0) {
      throw new Error('Only agent terminals can be saved as roles (this is a plain shell)')
    }
    const role: AgentRole = {
      name: trimmedName,
      preset: node.preset,
      command: node.command,
      rolePrompt: rolePrompt.trim(),
      savedAt: Date.now()
    }
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.fileFor(trimmedName), JSON.stringify(role, null, 2), 'utf8')
    return role
  }

  list(): AgentRole[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.read(path.join(this.dir, f)))
      .filter((r): r is AgentRole => r !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Case-insensitive lookup by role name. */
  get(name: string): AgentRole | undefined {
    const direct = this.read(this.fileFor(name))
    if (direct) return direct
    return this.list().find((r) => r.name.toLowerCase() === name.trim().toLowerCase())
  }

  delete(name: string): boolean {
    const role = this.get(name)
    if (!role) return false
    try {
      unlinkSync(this.fileFor(role.name))
      return true
    } catch (error) {
      console.error('Failed to delete role:', error)
      return false
    }
  }

  private read(file: string): AgentRole | null {
    try {
      if (!existsSync(file)) return null
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return isRole(parsed) ? parsed : null
    } catch (error) {
      console.error('Failed to read role file:', error)
      return null
    }
  }
}
