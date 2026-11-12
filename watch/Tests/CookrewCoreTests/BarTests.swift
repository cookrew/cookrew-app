import Foundation
import Testing
@testable import CookrewCore

// THE BAR AT THE FOOT OF A WRIST (Bar.swift): its groups and its folded box.

private let ws = CardWorkspace(id: "w", name: "Cookrew Dev", active: true)

private func item(_ id: String) -> CardItem {
  CardItem(id: id, kind: id.hasPrefix("n") ? .note : .browser, title: id, host: "h", tint: "#777777", initial: "X")
}

private func card(_ id: String, _ status: CardStatus, items: [CardItem] = [], choice: WaitChoice? = nil) -> Card {
  Card(id: id, name: id.capitalized, workspace: ws, status: status, word: status.rawValue, choice: choice, items: items)
}

@Suite("the bar's groups")
struct BarGroupTests {
  @Test("the agents that need you: waiting first, then an unread reply, each in the crew's order")
  func agentsNeedingYou() {
    let cards = [card("a", .done), card("b", .working), card("c", .waiting), card("d", .idle), card("e", .waiting), card("f", .done)]
    #expect(barInbox(cards, here: nil).agents.map(\.id) == ["c", "e", "a", "f"])
  }

  @Test("the card on show is in front of the owner already: neither it nor its artifacts are in the groups")
  func notTheCardOnShow() {
    let shared = item("b1")
    let cards = [card("a", .waiting, items: [shared, item("n1")]), card("b", .waiting, items: [shared, item("b2")])]
    let inbox = barInbox(cards, here: "a")
    #expect(inbox.agents.map(\.id) == ["b"])
    #expect(inbox.items.map(\.id) == ["b2"])
  }

  @Test("artifacts of the agents that need you lead, then the rest of the workspace's, each once")
  func itemsInOrder() {
    let cards = [card("a", .working, items: [item("b1")]), card("b", .waiting, items: [item("n1"), item("b1")]), card("c", .idle, items: [item("b2")])]
    #expect(barInbox(cards, here: "__new_agent__").items.map(\.id) == ["n1", "b1", "b2"])
  }

  @Test("nobody needing you: the agents group is empty, its word alone")
  func emptyAgents() {
    #expect(barInbox([card("a", .working), card("b", .idle)], here: nil).agents.isEmpty)
  }

  @Test("a stack shows two on a wrist, and says how many more")
  func stack() {
    #expect(barStack([1, 2, 3, 4]).shown == [1, 2])
    #expect(barStack([1, 2, 3, 4]).more == 2)
    #expect(barStack([1]).more == 0)
    #expect(barStack([Int]()).shown.isEmpty)
  }
}

@Suite("the bar's box")
struct BarBoxTests {
  private let rows = WaitChoice(id: "m", question: "Allow?", options: [WaitOption(key: "1", label: "Yes"), WaitOption(key: "2", label: "No")])
  private let typed = WaitChoice(id: "t", question: "Which?", options: [WaitOption(key: "1", label: "This"), WaitOption(key: "2", label: "Type", role: .type)])

  @Test("folded by default, open once its face is tapped, and open while it holds words")
  func folds() {
    let target = boxTarget(for: card("a", .idle))
    #expect(!boxOpen(draft: "", opened: false, target: target))
    #expect(boxOpen(draft: "", opened: true, target: target))
    #expect(boxOpen(draft: "merge it", opened: false, target: target))
    #expect(boxOpen(draft: "", opened: true, target: .newAgent))
  }

  @Test("a menu with a row to type in opens like a reply; one with rows only never does")
  func menus() {
    #expect(boxOpen(draft: "", opened: true, target: boxTarget(for: card("a", .waiting, choice: typed))))
    #expect(!boxOpen(draft: "", opened: true, target: boxTarget(for: card("a", .waiting, choice: rows))))
  }

  // Owner 2026-11-12: every page has a bar; on a card it is the reply box, in place even when it takes no words.
  @Test("a stop wears the HITL bar; a card its reply box; a card with rows only the same box, shut")
  func shapes() {
    #expect(barShape(on: nil) == .hitl)
    #expect(barShape(on: card("a", .idle)) == .reply)
    #expect(barShape(on: card("a", .waiting)) == .reply)
    #expect(barShape(on: card("a", .waiting, choice: typed)) == .reply)
    #expect(barShape(on: card("a", .waiting, choice: rows)) == .shut)
    #expect(rowsOnlyWords == "Pick a row above")
  }

  @Test("above a workspace the HITL bar holds every agent that needs you, from any workspace")
  func everyStop() {
    let other = CardWorkspace(id: "g", name: "GOAT Team", active: false)
    let cards = [card("a", .waiting), Card(id: "b", name: "B", workspace: other, status: .waiting, word: "needs you"), card("c", .idle)]
    #expect(barInbox(cards, here: nil).agents.map(\.id) == ["a", "b"])
  }
}
