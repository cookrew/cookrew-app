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
