import type { MachineProfile } from './fleet'

/**
 * THE LINE UNDER A MACHINE'S NAME, as the registry's /me page drew it until
 * 0.6.0 removed that page: its model when it reports one, else its system. The drawings that once stood
 * over it are gone (owner 2026-11-10): the Devices view is the drawing.
 */

const SYSTEM: Record<MachineProfile['os'], string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows', other: 'Computer' }

/** The line under a machine's name: its model when it knows it, else its system. */
export function machineCaption(profile: MachineProfile | null): string {
  if (profile === null) return 'Computer'
  if (profile.label) return profile.model && profile.kind === 'cloud' ? `${profile.label} · ${profile.model}` : profile.label
  const system = SYSTEM[profile.os]
  return profile.osVersion ? `${system} · ${profile.osVersion}` : system
}
