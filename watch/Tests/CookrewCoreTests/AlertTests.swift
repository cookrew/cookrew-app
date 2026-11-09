import Foundation
import Testing
@testable import CookrewCore

private let ws = CardWorkspace(id: "w", name: "Cookrew Dev", active: true)
private func card(_ id: String, _ status: CardStatus) -> Card { Card(id: id, name: id.capitalized, workspace: ws, status: status, word: status.rawValue) }

@Suite("status alerts")
struct AlertTests {
  @Test("an agent that started waiting, or finished, since the wrist last saw it is one alert each; the first look says nothing")
  func since() {
    var memory = StatusMemory()
    #expect(memory.alerts([card("a", .working), card("b", .idle)]).isEmpty)
    let next = memory.alerts([card("a", .done), card("b", .waiting), card("c", .waiting)])
    #expect(next == [.done("A"), .needsYou("B")])
    #expect(memory.alerts([card("a", .done), card("b", .waiting)]).isEmpty)
  }

  @Test("a read of one workspace forgets nobody in the others")
  func merges() {
    var memory = StatusMemory()
    _ = memory.alerts([card("a", .working), card("b", .working)])
    _ = memory.alerts([card("a", .working)])
    #expect(memory.alerts([card("b", .waiting)]) == [.needsYou("B")])
  }

  @Test("what an alert says")
  func words() {
    #expect(alertTitle(.needsYou("Atlas")) == "Atlas needs you")
    #expect(alertTitle(.done("Atlas")) == "Atlas is done")
    #expect(alertTitle(.sent) == nil)
  }

  @Test("each machine is remembered on its own, and survives a relaunch")
  func kept() throws {
    var memory = StatusMemory()
    _ = memory.alerts([card("a", .working)])
    let back = try JSONDecoder().decode(StatusMemory.self, from: JSONEncoder().encode(memory))
    var again = back
    #expect(again.alerts([card("a", .waiting)]) == [.needsYou("A")])
  }
}
