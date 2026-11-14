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

/**
 * An agent starting to wait in a workspace the wrist is not inside: its tile's
 * count rose. Inside one workspace the cards say only that one, so the others
 * speak through their counts.
 */
public func eventsElsewhere(_ old: [WorkspaceTile], _ new: [WorkspaceTile], inside scope: String) -> [WatchEvent] {
  let before = Dictionary(old.map { ($0.id, $0.waiting) }, uniquingKeysWith: { first, _ in first })
  return new.compactMap { tile in
    guard tile.id != scope, let was = before[tile.id], tile.waiting > was else { return nil }
    return .needsYou(tile.name)
  }
}

/** The new agent's box's draft key: the bar's ＋ (HitlBar.swift), on every stop. */
public let newAgentPage = "__new_agent__"

@MainActor
@Observable
public final class WatchStore {
  public private(set) var cards: [Card] = []
  /** Every workspace on the Mac, counted: the workspaces stop. */
  public private(set) var workspaces: [WorkspaceTile] = []
  /** The workspace the wrist has zoomed into; nil above them. */
  public private(set) var scope: String?
  /**
   * The Mac can show a thumbnail without starting its browser (frame ?peek=1).
   * It came with the workspace counts (0.5.6): a Mac that sends those peeks. An
   * older one would start a Chrome for every thumbnail and keep it busy, which a
   * phone scrolling on that Mac feels, so it is not asked for thumbnails at all.
   */
  public private(set) var macPeeks = false
  /** What the paired machine is; nil until it says. */
  public private(set) var platform: String?
  /** The Mac's own active workspace: the dot on its tile. */
  public private(set) var activeWorkspaceId: String?
  public private(set) var link: WatchLink = .connecting
  /** The card the crown is on, by id, so a reorder never moves it. */
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
  /** Moves on every zoom: a read sent before one is answered for a place the wrist has left. */
  @ObservationIgnored private var zooms = 0
  /** The workspace the cards in hand are all from, when they were read for one. */
  @ObservationIgnored private var cardsScope: String?
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

  /** The word for the paired machine: Mac, PC, machine, or computer before it has said. */
  public var machine: String { machineWord(platform) }

  public var currentCard: Card? { cards.first { $0.id == page } }

  private func shown(_ list: [Card]) -> [Card] {
    guard let scope else { return list }
    return list.filter { $0.workspace.id == scope }
  }

  /** The cards of the workspace zoomed into, or all of them above it. */
  public var visibleCards: [Card] { shown(cards) }

  /** Where a new agent from the wrist starts: inside a workspace, there, as a phone seated in it starts one; above them, the Mac's own. */
  public var newAgentWorkspace: String? {
    let id = scope ?? activeWorkspaceId
    return workspaces.first { $0.id == id }?.name ?? cards.first { $0.workspace.id == id }?.workspace.name
  }

  /**
   * Zoom into a workspace, or back out with nil. Its cards are read afresh, and
   * the crown starts on its first card. Going in is not news: nothing buzzes.
   */
  public func enter(workspace: String?) async {
    guard workspace != scope else { return }
    scope = workspace
    zooms &+= 1
    tag = nil
    // A card picked from a bar above (HitlBar.swift) keeps its page, read in the day's cards; else the first card.
    let kept = page.flatMap { id in visibleCards.contains { $0.id == id } ? id : nil }
    page = kept ?? visibleCards.first?.id
    await refresh()
  }

  /** Once, or on every poll: a 304 changes nothing. */
  public func refresh() async {
    let asked = scope
    let zoom = zooms
    // The wrist zoomed while this was out, even out and back: its answer, or its failure, is for a place it has left.
    var current: Bool { zoom == zooms }
    do {
      let answer = try await api.cards(tag: tag, workspace: asked)
      guard current else { return }
      switch answer {
      case .same:
        if link != .live { link = .live }
      case .new(let reply, let nextTag):
        tag = nextTag
        adopt(reply, readFor: asked)
      }
      if signedOut { signedOut = false }
    } catch WatchError.unpaired {
      unpaired = true
    } catch WatchError.signedOut {
      guard current else { return }
      signedOut = true
      link = .lost
    } catch {
      guard current else { return }
      link = .lost
    }
  }

  func adopt(_ reply: CardsReply, readFor asked: String? = nil) {
    let next = reply.cards
    let tiles = tilesWithAvatar(reply.workspaces ?? tilesFrom(next), cards: next)
    let first = link != .live && cards.isEmpty
    var events: [WatchEvent] = []
    if !first {
      // A Mac too old to scope still sends every card; inside a workspace only its own speak.
      events = eventsBetween(shown(cards), shown(next))
      // The cards in hand, or these, were one workspace's: every other one speaks through its count.
      if let inside = asked ?? cardsScope { events += eventsElsewhere(workspaces, tiles, inside: inside) }
    }
    // Every write below is one that changed: an observed property set to the same
    // value still redraws whatever reads it, the whole pager and every face, on
    // every poll, mid-scroll.
    if macPeeks != (reply.workspaces != nil) { macPeeks = reply.workspaces != nil }
    if cards != next { cards = next }
    if let said = reply.platform, platform != said { platform = said }
    // Only cards that really are one workspace's: a Mac too old to scope sends them all, and those speak for themselves.
    cardsScope = asked.flatMap { id in next.allSatisfy { $0.workspace.id == id } ? id : nil }
    if workspaces != tiles { workspaces = tiles }
    if activeWorkspaceId != reply.activeWorkspaceId { activeWorkspaceId = reply.activeWorkspaceId }
    if link != .live { link = .live }
    // A card that left takes its page with it; the first page is the one that needs the owner.
    let visible = shown(next)
    // There is no new agent's page any more (owner 2026-11-12): the bar's ＋ is.
    if page == nil || !visible.contains(where: { $0.id == page }) { page = visible.first?.id }
    let stillRead = readIds.filter { id in next.contains { $0.id == id && $0.status == .done } }
    if stillRead != readIds { readIds = stillRead }
    for card in next where card.choice == nil && answers[card.id] != nil { answers[card.id] = nil }
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
    if case WatchError.refused(let words) = error { notice = words } else if case WatchError.unpaired = error { unpaired = true } else { notice = "The \(machine) is not answering" }
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
        try await api.newAgent(words, in: scope)
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
  func stage(cards: [Card], page: String?, draft: [String: String] = [:], sent: [String: String] = [:], notice: String? = nil, scope: String? = nil, workspaces: [WorkspaceTile]? = nil) {
    self.cards = cards
    self.scope = scope
    self.workspaces = workspaces ?? tilesFrom(cards)
    self.activeWorkspaceId = self.workspaces.first { $0.active }?.id
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
