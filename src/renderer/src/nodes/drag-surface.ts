/**
 * WHERE A CARD CAN BE PICKED UP.
 *
 * ReactFlow walks up from the pointer target to the node root and starts a
 * drag only if something on that path `matches()` the node's dragHandle. So a
 * card is movable exactly where that selector says it is and nowhere else,
 * which makes the selector and the markup a matched pair — and a silent trap
 * when only one of them moves.
 *
 * It moved once already. Notes and browsers used to render a `.node-header`
 * bar even at overview zoom; the mini tile replaced that bar with its own
 * container, and with it went the only surface those cards could be dragged
 * by. They were pinned to the board at exactly the zoom where you rearrange
 * things, and nothing failed loudly to say so. Terminals hid it: their tile
 * root is `vi-mini node-header`, so it kept matching.
 *
 * These constants exist so that pair cannot drift again. The components render
 * the class FROM here and the selector is built FROM here, so renaming the
 * surface moves both at once. (The stylesheet still spells the class
 * literally — CSS cannot import — but that drift costs appearance, not the
 * ability to move the card.)
 */

/** The header bar of a full-size card. */
export const CARD_DRAG_SURFACE = 'node-header'

/** The body of a mini tile — at overview zoom the tile IS the card. */
export const TILE_DRAG_SURFACE = 'node-mini'

/**
 * Passed to every ReactFlow node as `dragHandle`. `matches()` takes a selector
 * list, so naming the tile as a drag surface is enough — the tile does not
 * need a header it has no room for.
 */
export const DRAG_HANDLE_SELECTOR = `.${CARD_DRAG_SURFACE}, .${TILE_DRAG_SURFACE}`
