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
  // The same words the desktop and the phone use for an unread reply (main/notifier.ts).
  case .done(let name): return "\(name) replied"
  case .sent, .refused: return nil
  }
}

/**
 * One alert per agent and machine on the wrist, as on the desktop and the
 * phone: a newer moment of the same agent replaces the older alert instead of
 * stacking under it. Keyed by name, which is what the alert carries.
 */
public func alertIdentifier(_ event: WatchEvent, machine: String) -> String {
  switch event {
  case .needsYou(let name), .done(let name): return "cookrew.agent|\(machine)|\(name)"
  case .sent, .refused: return "cookrew.tap|\(machine)"
  }
}
