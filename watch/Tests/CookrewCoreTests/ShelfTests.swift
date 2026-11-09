import Foundation
import Testing
@testable import CookrewCore

private func relay(_ id: String) -> Base { Base(kind: "relay", url: "https://cookrew.dev/relay/@anvztor/desktop/\(id)") }

@Suite("a watch paired with more than one machine")
struct ShelfTests {
  private let mbp = WatchSession(desktop: "MacBook Pro", bases: [relay("AAA")], token: "t1")
  private let solis = WatchSession(desktop: "Solis-Core", bases: [relay("bbb")], token: "t2")

  @Test("a machine is known by its relay id, and one paired by six digits by its name")
  func keys() {
    #expect(sessionKey(mbp) == "aaa")
    #expect(sessionKey(WatchSession(desktop: "Studio", bases: [Base(kind: "typed", url: "http://192.168.2.9:8639")], token: "t")) == "here:Studio")
  }

  @Test("pairing a second machine adds it and goes into it; the first stays")
  func adds() {
    var shelf = SessionShelf()
    shelf.put(mbp)
    shelf.put(solis)
    #expect(shelf.keys == ["aaa", "bbb"])
    #expect(shelf.active == "bbb")
    let went = shelf.activate("aaa")
    #expect(went)
    #expect(shelf.active == "aaa")
    let nowhere = shelf.activate("nope")
    #expect(!nowhere)
  }

  @Test("pairing one again replaces only its own key, in its place")
  func again() {
    var shelf = SessionShelf()
    shelf.put(mbp)
    shelf.put(solis)
    shelf.put(WatchSession(desktop: "MacBook Pro", bases: [relay("aaa")], token: "t3"))
    #expect(shelf.keys == ["aaa", "bbb"])
    #expect(shelf.active == "aaa")
  }

  @Test("forgetting the machine in use goes into the next; forgetting the last leaves none")
  func forgets() {
    var shelf = SessionShelf()
    shelf.put(mbp)
    shelf.put(solis)
    shelf.remove("bbb")
    #expect(shelf.keys == ["aaa"])
    #expect(shelf.active == "aaa")
    shelf.remove("aaa")
    #expect(shelf.keys.isEmpty)
    #expect(shelf.active == nil)
  }
}

@Suite("the devices stop with several machines")
struct HeldRowTests {
  @Test("a machine the watch holds a key for says so, and the one it is in comes first")
  func held() {
    let machines = [
      WatchMachine(id: "AAA", name: "MacBook Pro", online: true, workspaces: [], os: "darwin"),
      WatchMachine(id: "bbb", name: "Solis-Core", online: true, workspaces: [], os: "linux"),
      WatchMachine(id: "ccc", name: "Studio", online: false, workspaces: [])
    ]
    let rows = deviceRows(machines, pairedId: "bbb", desktop: "Solis-Core", live: true, held: ["aaa", "bbb"])
    #expect(rows.map(\.name) == ["Solis-Core", "MacBook Pro", "Studio"])
    #expect(rows.map(\.paired) == [true, false, false])
    #expect(rows.map(\.held) == [true, true, false])
    #expect(rows.map(\.os) == ["linux", "darwin", nil])
  }
}
