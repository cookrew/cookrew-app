import Foundation

// AGENT STATUS ALERTS: what the wrist says when the app is not in front of the
// owner. The watch remembers each agent's last status it saw, per machine; a read,
// in front or in a background refresh, that finds one newly waiting or finished
// is an alert. The first look at a machine says nothing: it is news to nobody.

public struct StatusMemory: Codable, Equatable, Sendable {
  private var seen: [String: CardStatus] = [:]

  public init() {}

  /** The alerts these cards make, and they become what was seen. Agents not in them are kept. */
  public mutating func alerts(_ cards: [Card]) -> [WatchEvent] {
    let events: [WatchEvent] = cards.compactMap { card in
      guard let was = seen[card.id], was != card.status else { return nil }
      if card.status == .waiting { return .needsYou(card.name) }
      if card.status == .done { return .done(card.name) }
      return nil
    }
    for card in cards { seen[card.id] = card.status }
    return events
  }
}

extension CardStatus: Encodable {}

/** An alert's title; nil for what is only a tap on the wrist. */
public func alertTitle(_ event: WatchEvent) -> String? {
  switch event {
  case .needsYou(let name): return "\(name) needs you"
  case .done(let name): return "\(name) is done"
  case .sent, .refused: return nil
  }
}
