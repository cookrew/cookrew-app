/**
 * WHO RUNS cookrew.dev, AND WHETHER THE LEGAL PAGES ARE PUBLISHED.
 *
 * The three facts are filled here, once. A value still in brackets is a
 * placeholder, and while any is, /privacy and /terms answer 404 and nothing on
 * the site links to them: a policy naming "[LEGAL ENTITY]" is not a policy.
 * This module imports nothing, so every page module can read it without a cycle.
 */
export const LEGAL_ENTITY = '[LEGAL ENTITY]'
export const CONTACT_EMAIL = '[CONTACT EMAIL]'
export const GOVERNING_LAW = '[GOVERNING LAW]'

export const isPlaceholder = (value: string): boolean => value.startsWith('[')

export const LEGAL_PUBLISHED = ![LEGAL_ENTITY, CONTACT_EMAIL, GOVERNING_LAW].some(isPlaceholder)
