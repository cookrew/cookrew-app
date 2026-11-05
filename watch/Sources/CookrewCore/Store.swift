import Foundation
import Observation

// THE WRIST'S ONE STATE. It reads the cards, keeps the page the crown is on,
// and holds what the phone's box and menu hold (prompt/wait-answer.ts, the
// card's reply): the draft, the words just sent, the row just answered.

/** A moment the wrist should feel. */
public enum WatchEvent: Equatable, Sendable {
  /** An agent started waiting on the owner. */
  case needsYou(String)
  case done(String)
  case sent
  case refused
}

public enum WatchLink: Equatable, Sendable {
  case connecting
  case live
  /** It was live, and the Mac is not answering. */
  case lost
}

/** What a turn of the card's menu shows (wait-answer.ts · answerView). */
public struct WaitView: Equatable, Sendable {
  public let choice: WaitChoice
  /** The row just sent, filling; nil while the menu waits on a pick. */
  public let sent: Int?

  public init(choice: WaitChoice, sent: Int?) {
    self.choice = choice
    self.sent = sent
  }
}

struct Answer: Equatable {
  let signature: String
  let index: Int
  let choice: WaitChoice
  let at: Date
}

public let answerFillSeconds = 0.6
public let answerRetrySeconds = 5.0
/** How long words just sent stand in the card. */
public let sentSeconds = 4.0
/** A card looked at this long is read: its reply stops being unread. */
public let readSeconds = 1.2
/** How long Stop stays armed for its second tap. */
public let stopArmSeconds = 2.5

func answerView(live: WaitChoice?, answer: Answer?, now: Date) -> WaitView? {
  if let answer, now.timeIntervalSince(answer.at) < answerFillSeconds {
    return WaitView(choice: answer.choice, sent: answer.index)
  }
  if let live, let answer, live.signature == answer.signature, now.timeIntervalSince(answer.at) < answerRetrySeconds {
    return nil
  }
  return live.map { WaitView(choice: $0, sent: nil) }
}

/** What changed that the wrist should feel. A first read says nothing: it is news to nobody. */
public func eventsBetween(_ old: [Card], _ new: [Card]) -> [WatchEvent] {
  let before = Dictionary(old.map { ($0.id, $0.status) }, uniquingKeysWith: { first, _ in first })
  return new.compactMap { card in
    guard let was = before[card.id], was != card.status else { return nil }
    if card.status == .waiting { return .needsYou(card.name) }
    if card.status == .done { return .done(card.name) }
    return nil
  }
}

public let newAgentPage = "__new_agent__"

@MainActor
@Observable
public final class WatchStore {
  public private(set) var cards: [Card] = []
  public private(set) var link: WatchLink = .connecting
  /** The page the crown is on: a card's id, or newAgentPage. Kept by id, so a reorder never moves it. */
  public var page: String?
  /** A word on the card: why the last thing did not go. */
  public private(set) var notice: String?
  public private(set) var unpaired = false
  /** The relay refused the session and no road answered: a new code is what brings it back. */
  public private(set) var signedOut = false

  @ObservationIgnored private let api: WatchAPI
  @ObservationIgnored private let now: () -> Date
  @ObservationIgnored private let feel: (WatchEvent) -> Void
  @ObservationIgnored private var tag: String?
  @ObservationIgnored private let sleep: @Sendable (Double) async -> Void
  /**
   * What is on screen depends on the time as well as the data: a row's fill
   * ending, a menu coming back, Stop disarming. Nothing else would redraw it (an
   * unchanged crew is a 304), so each of those wakes this at its moment.
   */
  private var beat = 0
  private var drafts: [String: String] = [:]
  private var sentWords: [String: (text: String, at: Date)] = [:]
  private var answers: [String: Answer] = [:]
  private var stopArmedAt: [String: Date] = [:]
  private var readIds: Set<String> = []

  public init(
    api: WatchAPI,
    now: @escaping () -> Date = Date.init,
    feel: @escaping (WatchEvent) -> Void = { _ in },
    sleep: @escaping @Sendable (Double) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }
  ) {
    self.api = api
    self.now = now
    self.feel = feel
    self.sleep = sleep
  }

  private func wake(after seconds: Double) {
    Task { [sleep] in
      await sleep(seconds)
      beat &+= 1
    }
  }

  public var client: WatchAPI { api }

  public var currentCard: Card? { cards.first { $0.id == page } }

  /** Once, or on every poll: a 304 changes nothing. */
  public func refresh() async {
    do {
      switch try await api.cards(tag: tag) {
      case .same:
        link = .live
      case .new(let reply, let nextTag):
        tag = nextTag
        adopt(reply.cards)
      }
      signedOut = false
    } catch WatchError.unpaired {
      unpaired = true
    } catch WatchError.signedOut {
      signedOut = true
      link = .lost
    } catch {
      link = .lost
    }
  }

  func adopt(_ next: [Card]) {
    let first = link != .live && cards.isEmpty
    let events = first ? [] : eventsBetween(cards, next)
    cards = next
    link = .live
    // A card that left takes its page with it; the first page is the one that needs the owner.
    if page != newAgentPage, page == nil || !next.contains(where: { $0.id == page }) { page = next.first?.id ?? newAgentPage }
    readIds = readIds.filter { id in next.contains { $0.id == id && $0.status == .done } }
    for card in next where card.choice == nil { answers[card.id] = nil }
    for event in events { feel(event) }
  }

  /** Poll while the app is on the wrist: quicker when the Mac answers, slower when it does not. */
  public func run() async {
    while !Task.isCancelled {
      await refresh()
      if unpaired { return }
      let seconds: Double = link == .live ? 3 : 8
      try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }
  }

  // MARK: The box

  public func draft(_ page: String) -> String { drafts[page] ?? "" }

  public func setDraft(_ text: String, for page: String) {
    drafts[page] = text
  }

  /** The words just sent to this card, while they stand. */
  public func sent(_ id: String) -> String? {
    _ = beat
    guard let sent = sentWords[id], now().timeIntervalSince(sent.at) < sentSeconds else { return nil }
    return sent.text
  }

  private func refused(_ error: Error) {
    feel(.refused)
    if case WatchError.refused(let words) = error { notice = words } else if case WatchError.unpaired = error { unpaired = true } else { notice = "The Mac is not answering" }
  }

  /** The box's words, where boxTarget says they go. The draft comes back if the Mac will not take them. */
  public func send(page: String) async {
    let words = draft(page).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !words.isEmpty else { return }
    let card = cards.first { $0.id == page }
    let target = boxTarget(for: card)
    if target == .rowsOnly { return }
    drafts[page] = ""
    notice = nil
    do {
      switch target {
      case .reply(let id):
        try await api.send(words, to: id)
      case .menuWords(let id):
        guard let menu = card?.choice?.id else { return }
        try await api.answer(.words(words), menu: menu, to: id)
      case .newAgent:
        try await api.newAgent(words)
      case .rowsOnly:
        return
      }
      sentWords[page] = (words, now())
      wake(after: sentSeconds)
      feel(.sent)
      await refresh()
    } catch {
      if draft(page).isEmpty { drafts[page] = words }
      refused(error)
    }
  }

  // MARK: The menu

  public func waitView(_ card: Card) -> WaitView? {
    _ = beat
    return answerView(live: card.choice, answer: answers[card.id], now: now())
  }

  /** A row tapped: this menu, this row; the Mac checks it against the screen. */
  public func answer(_ card: Card, row index: Int) async {
    guard let view = waitView(card), view.sent == nil, view.choice.options.indices.contains(index) else { return }
    let option = view.choice.options[index]
    if !option.staysOpen {
      answers[card.id] = Answer(signature: view.choice.signature, index: index, choice: view.choice, at: now())
      wake(after: answerFillSeconds)
      wake(after: answerRetrySeconds)
    }
    await deliver(.row(index), menu: view.choice.id, to: card)
  }

  public func step(_ card: Card, by dir: Int) async {
    guard let choice = card.choice else { return }
    answers[card.id] = nil
    await deliver(.step(dir), menu: choice.id, to: card)
  }

  private func deliver(_ act: MenuAct, menu: String, to card: Card) async {
    notice = nil
    do {
      try await api.answer(act, menu: menu, to: card.id)
      feel(.sent)
      await refresh()
    } catch {
      answers[card.id] = nil
      if case WatchError.refused("moved") = error {
        feel(.refused)
        notice = "The menu moved on · nothing sent"
      } else if case WatchError.refused = error {
        feel(.refused)
        notice = "That answer did not go through"
      } else {
        refused(error)
      }
    }
  }

  // MARK: Stop

  public func stopArmed(_ id: String) -> Bool {
    _ = beat
    guard let at = stopArmedAt[id] else { return false }
    return now().timeIntervalSince(at) < stopArmSeconds
  }

  /** Esc, on a second tap: a turn is not stopped by a sleeve. */
  public func stop(_ card: Card) async {
    guard stopArmed(card.id) else {
      stopArmedAt[card.id] = now()
      wake(after: stopArmSeconds)
      return
    }
    stopArmedAt[card.id] = nil
    do {
      try await api.stop(card.id)
      feel(.sent)
      await refresh()
    } catch {
      refused(error)
    }
  }

  // MARK: Reading

  /** The card has been in front of the owner: its reply is read, as opening it on the phone reads it. */
  public func read(_ card: Card) async {
    guard card.status == .done, !readIds.contains(card.id) else { return }
    readIds.insert(card.id)
    try? await api.seen(card.id)
  }
}

#if DEBUG
public extension WatchStore {
  /** For the drawings of each state: a store standing as it would. */
  func stage(cards: [Card], page: String?, draft: [String: String] = [:], sent: [String: String] = [:], notice: String? = nil) {
    self.cards = cards
    self.page = page
    self.link = .live
    self.drafts = draft
    self.sentWords = sent.mapValues { ($0, now()) }
    self.notice = notice
  }

  /** The row just tapped, filling. */
  func stageAnswer(_ card: Card, row: Int) {
    guard let choice = card.choice else { return }
    answers[card.id] = Answer(signature: choice.signature, index: row, choice: choice, at: now())
  }

  func stageStopArmed(_ id: String) {
    stopArmedAt[id] = now()
  }

  func stageLink(_ link: WatchLink) {
    self.link = link
  }
}
#endif
