import Foundation

// THE BAR AT THE FOOT OF A WRIST (owner 2026-11-12, docs/watch-hitl-bar-2026-11-12.html,
// as the phone draws it). Every page has one:
//
//   the devices, workspaces and crew stops   [ARTIFACTS | AGENTS] · ＋
//   an agent's card                          (face) Reply… ➜
//
// The groups are the human-in-the-loop inbox (src/renderer/src/zoom/bar-inbox.ts):
// the agents that need you, and the artifacts they hold, each one tap away. ＋ is
// the box folded, and opens in place for a new agent. The way out is not the
// bar's: it is the top left, as it always was.

/** Which bar a page wears: nil card is a stop with no card on show. */
public enum BarShape: Equatable, Sendable {
  case hitl
  case reply
  /** A menu with no row to type in: the box stands where it always is, dimmed, pointing up at the rows. */
  case shut
}

public func barShape(on card: Card?) -> BarShape {
  guard let card else { return .hitl }
  return boxTarget(for: card) == .rowsOnly ? .shut : .reply
}

/** The shut box's words. */
public let rowsOnlyWords = "Pick a row above"

/** What the bar's two groups hold, in the order they are drawn. */
public struct BarInbox: Equatable, Sendable {
  /** Agents that need the owner: waiting on an answer first, then a reply not yet read. */
  public let agents: [Card]
  /** Their notes and browsers, then the rest of the workspace's, each once. */
  public let items: [CardItem]

  public init(agents: [Card], items: [CardItem]) {
    self.agents = agents
    self.items = items
  }
}

/** How many faces, or pictures, a group stacks on a wrist before "+N". */
public let barStackRoom = 2

private func needsYou(_ card: Card) -> Int? {
  switch card.status {
  case .waiting: return 0
  case .done: return 1
  default: return nil
  }
}

/**
 * The inbox seen from one page: the card on show is already in front of the
 * owner, so neither it nor its artifacts are in the groups (its strip draws them).
 */
public func barInbox(_ cards: [Card], here page: String?) -> BarInbox {
  let others = cards.filter { $0.id != page }
  // Stable: the crew's own order within each rank, as the Mac's stack keeps it.
  let agents = others.enumerated()
    .compactMap { pair in needsYou(pair.element).map { (rank: $0, at: pair.offset, card: pair.element) } }
    .sorted { $0.rank != $1.rank ? $0.rank < $1.rank : $0.at < $1.at }
    .map(\.card)
  let first = Set(agents.map(\.id))
  let ordered = agents + others.filter { !first.contains($0.id) }
  var seen = Set(cards.first { $0.id == page }?.items.map(\.id) ?? [])
  var items: [CardItem] = []
  for card in ordered {
    for item in card.items where !seen.contains(item.id) {
      seen.insert(item.id)
      items.append(item)
    }
  }
  return BarInbox(agents: agents, items: items)
}

/** A group's stack as drawn: the first few, and how many more. */
public func barStack<T>(_ list: [T], room: Int = barStackRoom) -> (shown: [T], more: Int) {
  let shown = Array(list.prefix(max(0, room)))
  return (shown, list.count - shown.count)
}

/**
 * The box is open while it holds words (the draft is the box's, kept when it
 * folds) or since its face was tapped; folded otherwise. A menu with no row to
 * type in takes no words, so its box never opens: the rows are the answer.
 */
public func boxOpen(draft: String, opened: Bool, target: BoxTarget) -> Bool {
  if target == .rowsOnly { return false }
  return opened || !draft.isEmpty
}
