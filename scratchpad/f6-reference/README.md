# F6 / B3r reference set — captured from the PRODUCT rail

```
node scratchpad/f6-reference/render-f6-reference.mjs    # exit 0 = all measured states < 0.5px
```

Chrome on **9336**, harness on **8646**. Never Magpie's 9245, never 8648 (a live
node bridge), never the pin probe's 8647, never :8639/:8643/:5173.
Needs `scratchpad/qa-cdp-driver.mjs` (Magpie's, untracked) beside it.

## What changed, and why the old set was unusable

The previous set was captured from the **design mock** at 1120×416 while the
live rail renders **30×663**. A diff between those can only report a size
mismatch, whatever the geometry does. This mounts the real `CheckpointTimeline`
and clips every band to the rail's own 30px box.

| state | for |
|---|---|
| `1-rail-at-rest` | pins on the bar, nothing revealed |
| `2-fan-open` | reveal open, thumb clear of every pin — the F6 pair |
| `3-thumb-on-pin` | thumb held on its coincident pin (R25: the thumb owns it) |
| `5-empty-ledger` | no pins in the ledger — none drawn, none guessed |
| `6-colocated` | **the B3r reference.** Diff `6-colocated--band.png` |
| `7-colocated-noncontiguous` | **the regression guard.** B3r on rows 1,2,4,7 |

## The fixture is read, not restated

`harness.tsx` imports `tests/fixtures/version-pins.json`. It used to hold its own
copy under a comment naming the fixture, and `measurements.json` stamped
"contract v2" on the strength of that comment — while the copy had already
drifted (`cutAt` 1,2,3,4 against the fixture's epoch millis, `manifestId`
dropped). The fixture has a tripwire; a hardcoded copy in `scratchpad/` does
not. Every state now records the contract version it actually read, and the run
fails if it is not the expected one.

## Why a non-contiguous state exists

Every other state draws the **contiguous** ledger, where array position and turn
number agree — the fixture's own note says that is "exactly why the v1 bug went
unnoticed". A set captured only in that shape cannot tell R17 render-position
anchoring from the v1 turn-number anchoring `c0e6d5f` removed, so it would pass
a regression to v1 without a pixel moving. Rows 1,2,4,7 pull the two spaces
apart: checkpoint 4 anchors at 2/4 = 0.5 under R17 and near 4/7 under v1. The
boundary's checkpoint is *derived* from `traceFraction`/`pinFraction` rather than
hardcoded, so the state throws instead of quietly ceasing to be co-located.

## A missing measurement is a failure, not a skip

Each state declares the marks it must photograph (`requires`, and `forbids` for
the pin `5-empty-ledger` proves absent). The gate used to read only the two
deltas and skip a null — so if `.cr-ckpt-here` or `.cr-ckpt-row.active` ever
stopped matching, `f6PairDeltaPx` went null, the console printed `f6Pair=n/a`,
and the run **exited 0** announcing "All measured states within 0.5px". F6
disarmed silently by measuring nothing and calling it a pass. Presence is now
asserted before any delta is read.

## Four things that make it diffable at all

1. **Animation is frozen before capture.** `.cr-ckpt-livedot` runs an infinite
   pulse, so every shot caught a different phase and the at-rest reference
   hashed differently every run.
2. **`#root` carries `background: var(--cream)`** from the app's stylesheet and
   painted over the stage — every reference came out on cream while the live
   rail sits on phosphor dark.
3. **Held drags, not released ones.** On mouseup the component re-derives
   `focused` from its props, so a released state photographs the rail at rest
   whatever you scrubbed to. Two states came out byte-identical because of it.
4. **The thumb moves by PROP for state 6.** Dragging it away dims every pin to
   55% (the coincidence rule) and releasing snaps it back onto the pin.

## No `.on-cream` state

Nothing in the renderer mounts that class on the rail — only `GitChip` uses an
on-cream class. A reference for a state the product cannot reach would be a
picture of the harness, and adding the class imperatively does not survive the
next React render anyway.

## Duplicate-hash check

Scoped to the **wide** shots, which must all differ. Bands may legitimately
coincide: the band is a 30px crop centred on the pin, so two states differing
only in where the thumb sits elsewhere produce the same band by construction.
