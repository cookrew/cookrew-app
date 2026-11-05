/**
 * WHAT DELETING AN ACCOUNT DOES, IN WORDS. One list, two readers: the
 * confirmation in the app's profile sheet and the privacy page. A person must
 * be told the same thing in both places, and it must match
 * registry/src/v2-delete.ts, which does it.
 */

export const DELETE_ACCOUNT_TAKES: readonly string[] = [
  'Your password, passkeys, authenticator, recovery codes and linked sign-in providers.',
  'Every device and session on the account. Each one is signed out at once.',
  'Your desktops, their addresses and the certificates cookrew.dev holds for them.',
  'Your team listings and doors. Anyone holding a seat at your teams loses it, paid or not, and any refund is between you and them.',
  'Your seats at other teams, your stars, your requests, your payout address and any older key record.'
]

export const DELETE_ACCOUNT_KEEPS: readonly string[] = [
  'Your username stays reserved so nobody can pose as you. It is kept only as a one-way digest, and it can never be claimed again.',
  'Records of bought seats, with the buyer’s username, the payment reference and the time, and preset purchase receipts. Sellers and buyers need them for their accounts.',
  'Presets you published and their log entries, which are permanent.',
  'Certificates already in public certificate logs, and server logs and daily counts, which age out on their own.'
]

/** The last word, on the button a person presses. */
export const DELETE_ACCOUNT_WARNING = 'This cannot be undone. Nothing here can bring the account back.'
