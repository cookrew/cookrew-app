# Served-crew brief — orch door + real payment (2026-08-26)

Owner ruling that scopes this work:

1. **No bare-shell teams.** A served team must contain **at least one orch node**,
   and that orch is the default interface agent — it orchestrates the others.
   The gate must REFUSE to serve a team with no orch rather than silently
   falling back to "first terminal".
2. **A caller's prompt must reach the orch inside the minted session workspace
   and come back with a real result** — proxied through the orch, not answered
   by a shell echo.
3. **Payment must be real USD** — x402 (USDC) or Stripe — not the `devSettle`
   `tx-`/`bad-`/`iffy-` string prefixes currently in `served-endpoints.ts`.

---

## Where the code is

| Concern | File |
|---|---|
| Gate/HTTP (401 → 402 → /ask) | `src/main/served-endpoints.ts` |
| The door lookup (orch of a session) | `src/main/session-instantiator-mount.ts` → `makeEntryTerminalLookup` |
| Serve registry + validation | `src/main/session-served.ts` |
| Persistence (survives restart) | `src/main/served-persist.ts` |
| Mint / boot / end | `src/main/session-instantiator*.ts` |
| App wiring (`crewFace`, `ask`, `admit`) | `src/main/index.ts` (~line 420 `handleServedSlug`) |
| Save-time share UI | `src/renderer/src/ShareOnSave.tsx`, `SelectionBar.tsx` |
| Import UI | `src/renderer/src/AddCrewSheet.tsx`, `Dock.tsx` (crew chips) |
| Dev settle (TO BE REPLACED) | `devSettle` in `served-endpoints.ts` |

## Reproduce the current state

```
node scratchpad/served-crew-drive.mjs qa-shell-door          # free door
node scratchpad/served-crew-drive.mjs <slug> --pay tx-ok     # paid door
```

Prints: public face → challenge → ed25519 assert → /ask (402 if paid) → reply.

## KNOWN GAPS (the work)

**G1 — orch is not required.** I relaxed `entryTerminalOf` to fall back to the
first terminal, so a 1-shell team served fine and "answered" by echoing into
zsh. Per the ruling that is wrong twice over.
- `session-served.ts`: refuse `serve()` when the snapshot has no orch node
  (`entryAgentOf(snapshot) === null`) → new reason `no-orch`.
- `session-instantiator-mount.ts`: drop the first-terminal fallback; return
  null and let the 503 stand (the serve-time refusal is the real guard).
- `ShareOnSave`/`SelectionBar`: refuse at SAVE time with the reason in plain
  words — "pick an orch first; callers talk to one agent" — never a silent
  save that fails later at the gate.
- Repro: `served-crew-drive.mjs qa-shell-door` currently returns 200 with an
  empty reply and `~/.cookrew/sessions/svc-qa-shell-door/qa-eval-1/.zsh_history`
  containing the prompt. That is the bug in one line.

**G2 — the minted crew has no credentials, so a real agent cannot answer.**
`grantedKeysForService()` in `index.ts` returns `[]` by design (R30: the owner
lends no keys). Claude boots in the sandbox, finds no auth, exits. Owner's
credentials live at `~/.claude/.credentials.json` (0600) and in the login
keychain. Needs a deliberate per-service grant with a budget — NOT a blanket
copy of the owner's file into every sandbox. Design it, then wire it; the
prompt-reaches-orch-and-returns-a-result test (ruling 2) cannot pass until
this does.

**G3 — payment is a dev stub.** `devSettle` accepts any `tx-` string.
Reference implementations on this machine:
- `~/workspace/dotscrafts-shop/goat-x402/` — full GOAT Flow platform
  (facilitator, EIP-3009 `receiveWithAuthorization`, MPP receipts,
  `goatx402-mpp-middleware-ts` for verification). Heavy but real.
- `~/workspace/goat-mainnet/goat-ens/frontend/src/app/renew/hooks/renewalX402*.ts`
  — a compact client-side x402 order + finalization pair worth reading first.
Requirement: keep the 402 quote at **session admission only** (R5 — never
mid-conversation), and keep the settle behind the existing seam so the gate
logic does not learn the payment rail. Stripe is acceptable if x402 is heavier
than the milestone wants; the owner asked for real USD either way.

## Gates (all must pass, on the real product surface)

- **A1** Saving a team with no orch is REFUSED at save, in words, on the bar.
- **A2** A served team's `/crew` names an orch as `door`, and that orch is the
  orch node of the minted session workspace.
- **A3** A caller's prompt reaches that orch and returns a real agent reply
  (not a shell echo, not empty).
- **A4** Second ask on the same session: 200, `created:false`, no re-charge.
- **A5** Paid door: 402 quotes real USD terms; a genuine settled payment (test
  network / Stripe test mode is fine, the RAIL must be real) admits the
  session; a bogus reference is refused and nothing is minted.
- **A6** Serving survives an app restart (already passing — keep it passing).
- **A7** `npm run typecheck` clean; full `npx vitest run` green.

## Notes / traps already paid for

- REAL typecheck is `npm run typecheck` (root tsconfig is solution-style;
  bare `npx tsc --noEmit` checks NOTHING).
- Served terminals are pinned to the DIRECT pty backend (`servedMux` in
  `pty.ts`) so the env scrub + Seatbelt profile land on the agent process.
  Do not route them back through herdr.
- Session dirs must go through `sessionSegment()` — repeating the service
  prefix pushed socket paths past `sun_path` (104B) and claude died at boot.
- A fix is DONE when it is tappable on the real product surface, not when the
  API answers.
