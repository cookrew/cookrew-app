import Foundation
import Testing
@testable import CookrewCore

private let dev = CardWorkspace(id: "dev", name: "Cookrew Dev", active: true)
private let goat = CardWorkspace(id: "goat", name: "GOAT Team", active: false)

private func card(_ id: String, _ status: CardStatus, _ workspace: CardWorkspace) -> Card {
  Card(id: id, name: id.capitalized, workspace: workspace, status: status, word: status.rawValue)
}

private func tile(_ id: String, _ name: String, agents: Int, waiting: Int = 0, active: Bool = false) -> WorkspaceTile {
  WorkspaceTile(id: id, name: name, active: active, agents: agents, waiting: waiting, working: 0, done: 0)
}

/** A Mac that answers one reply after another, and remembers which workspace each read asked for. */
private final class ScopedAPI: WatchAPI, @unchecked Sendable {
  var replies: [CardsReply] = []
  var asked: [String?] = []
  func cards(tag: String?) async throws -> Fresh<CardsReply> { try await cards(tag: tag, workspace: nil) }
  func cards(tag: String?, workspace: String?) async throws -> Fresh<CardsReply> {
    asked.append(workspace)
    let reply = replies.isEmpty ? CardsReply(cards: [], activeWorkspaceId: "dev") : replies.removeFirst()
    return .new(reply, tag: "t\(asked.count)")
  }
  func send(_ text: String, to id: String) async throws {}
  func answer(_ act: MenuAct, menu: String, to id: String) async throws {}
  func stop(_ id: String) async throws {}
  func seen(_ id: String) async throws {}
  func newAgent(_ text: String) async throws {}
  func frame(_ id: String, width: Int, tag: String?) async throws -> Fresh<Data> { .same }
  func input(_ input: BrowserInput, to id: String) async throws {}
  func note(_ id: String) async throws -> NoteBody { NoteBody(name: "", content: "") }
  func unpair() async throws {}
}

@MainActor
private final class Felt {
  var events: [WatchEvent] = []
}

@Suite("the workspaces stop")
struct WorkspaceTileTests {
  @Test("a Mac that sends no tiles still gets them, from its cards, in the order they came")
  func derived() {
    let tiles = tilesFrom([card("a", .waiting, goat), card("b", .working, dev), card("c", .done, goat), card("d", .idle, dev)])
    #expect(tiles == [
      WorkspaceTile(id: "goat", name: "GOAT Team", active: false, agents: 2, waiting: 1, working: 0, done: 1),
      WorkspaceTile(id: "dev", name: "Cookrew Dev", active: true, agents: 2, waiting: 0, working: 1, done: 0)
    ])
  }

  @Test("the account's list sets the order and adds the empty workspaces an old Mac leaves out")
  func merged() {
    let tiles = [tile("goat", "GOAT Team", agents: 3, waiting: 1), tile("dev", "Cookrew Dev", agents: 5)]
    let names = [MachineWorkspace(id: "dev", name: "Cookrew Dev"), MachineWorkspace(id: "play", name: "Playground"), MachineWorkspace(id: "goat", name: "GOAT Team")]
    let all = mergedTiles(tiles, names: names)
    #expect(all.map(\.id) == ["dev", "play", "goat"])
    #expect(all[1].agents == 0)
    #expect(all[2].waiting == 1)
    #expect(mergedTiles(tiles, names: []) == tiles)
    #expect(mergedTiles([tile("gone", "Gone", agents: 1)], names: names).map(\.id) == ["dev", "play", "goat", "gone"])
  }
}

@Suite("the devices stop")
struct MachineTests {
  @Test("reads the registry's desktops: name, online, its workspaces")
  func decode() throws {
    let json = #"[{"id":"135928f2-0000-4000-8000-000000000001","deviceId":"135928f2-0000-4000-8000-000000000001","name":"MacBook Pro","online":true,"workspaces":[{"id":"w1","name":"Cookrew Dev"}],"appVersion":"0.5.3","reach":{}},{"deviceId":"222","name":"Studio","workspaces":[]}]"#
    let machines = try JSONDecoder().decode([WatchMachine].self, from: Data(json.utf8))
    #expect(machines.map(\.name) == ["MacBook Pro", "Studio"])
    #expect(machines[0].online)
    #expect(!machines[1].online)
    #expect(machines[1].id == "222")
    #expect(machines[0].workspaces == [MachineWorkspace(id: "w1", name: "Cookrew Dev")])
  }

  @Test("the Mac this watch is paired with is the one its relay road names")
  func current() {
    let bases = [Base(kind: "lan", url: "http://192.168.2.13:8639"), Base(kind: "relay", url: "https://cookrew.dev/relay/@anvztor/desktop/135928F2-0000-4000-8000-000000000001")]
    #expect(pairedMachineId(bases) == "135928f2-0000-4000-8000-000000000001")
    #expect(pairedMachineId([Base(kind: "typed", url: "http://192.168.2.13:8639")]) == nil)
  }
}

@Suite("zooming the store", .serialized)
@MainActor
struct ScopeTests {
  private func store(_ api: ScopedAPI, felt: Felt) -> WatchStore {
    WatchStore(api: api, feel: { felt.events.append($0) })
  }

  @Test("inside a workspace it asks for that workspace, and shows only it even when an old Mac sends all")
  func scoped() async {
    let api = ScopedAPI()
    let all = [card("a", .waiting, goat), card("b", .working, dev)]
    api.replies = [CardsReply(cards: all, activeWorkspaceId: "dev"), CardsReply(cards: all, activeWorkspaceId: "dev")]
    let felt = Felt()
    let s = store(api, felt: felt)
    await s.refresh()
    #expect(s.visibleCards.map(\.id) == ["a", "b"])
    await s.enter(workspace: "dev")
    #expect(api.asked == [nil, "dev"])
    #expect(s.visibleCards.map(\.id) == ["b"])
    #expect(s.page == "b")
    #expect(s.workspaces.map(\.id) == ["goat", "dev"])
  }

  @Test("tiles come from the Mac when it sends them")
  func tilesFromMac() async {
    let api = ScopedAPI()
    api.replies = [CardsReply(cards: [], activeWorkspaceId: "dev", workspaces: [tile("dev", "Cookrew Dev", agents: 4), tile("play", "Playground", agents: 0)])]
    let s = store(api, felt: Felt())
    await s.refresh()
    #expect(s.workspaces.map(\.id) == ["dev", "play"])
    #expect(s.workspaces[0].agents == 4)
  }

  @Test("going in says nothing; an agent starting to wait in another workspace still taps the wrist")
  func elsewhere() async {
    let api = ScopedAPI()
    let tiles0 = [tile("dev", "Cookrew Dev", agents: 2), tile("goat", "GOAT Team", agents: 2)]
    let tiles1 = [tile("dev", "Cookrew Dev", agents: 2), tile("goat", "GOAT Team", agents: 2, waiting: 1)]
    api.replies = [
      CardsReply(cards: [card("b", .working, dev), card("a", .idle, goat)], activeWorkspaceId: "dev", workspaces: tiles0),
      CardsReply(cards: [card("b", .working, dev)], activeWorkspaceId: "dev", workspaces: tiles0),
      CardsReply(cards: [card("b", .working, dev)], activeWorkspaceId: "dev", workspaces: tiles1)
    ]
    let felt = Felt()
    let s = store(api, felt: felt)
    await s.refresh()
    await s.enter(workspace: "dev")
    #expect(felt.events.isEmpty)
    await s.refresh()
    #expect(felt.events == [.needsYou("GOAT Team")])
  }
}

@Suite("the devices list")
struct DeviceRowTests {
  private let mac = WatchMachine(id: "135928f2", name: "MacBook Pro", online: false, workspaces: [MachineWorkspace(id: "w1", name: "Cookrew Dev")])
  private let studio = WatchMachine(id: "222", name: "Studio", online: true, workspaces: [])

  @Test("the paired Mac is the one its id names, and it is online when the wrist hears it")
  func paired() {
    let rows = deviceRows([studio, mac], pairedId: "135928F2", desktop: "MacBook Pro", live: true)
    #expect(rows.map(\.name) == ["MacBook Pro", "Studio"])
    #expect(rows[0].paired && rows[0].online)
    #expect(rows[0].workspaces == 1)
    #expect(!rows[1].paired && rows[1].online)
  }

  @Test("with no id it is the one by its name; with no account it is the only one")
  func fallbacks() {
    #expect(deviceRows([studio, mac], pairedId: nil, desktop: "MacBook Pro", live: false).first?.paired == true)
    let alone = deviceRows([], pairedId: nil, desktop: "MacBook Pro", live: true)
    #expect(alone == [DeviceRow(id: "paired", name: "MacBook Pro", online: true, workspaces: nil, paired: true)])
    #expect(deviceRows([studio], pairedId: "135928f2", desktop: "MacBook Pro", live: false).map(\.name) == ["MacBook Pro", "Studio"])
  }
}

@Suite("the zoom level kept across launches")
struct ZoomLevelTests {
  @Test("a level is written and read back, and anything unreadable is the workspaces")
  func roundTrip() {
    for level in [ZoomLevel.devices, .workspaces, .agents("w1"), .cards("w-2")] {
      #expect(ZoomLevel(stored: level.stored) == level)
    }
    #expect(ZoomLevel(stored: "") == .workspaces)
    #expect(ZoomLevel(stored: "agents:") == .workspaces)
    #expect(ZoomLevel.cards("w1").scope == "w1")
    #expect(ZoomLevel.workspaces.scope == nil)
    #expect(ZoomLevel.cards("w1").outward == .agents("w1"))
  }
}

/** A Mac whose answers come back when the test lets them. */
@MainActor
private final class HeldAPI: WatchAPI, @unchecked Sendable {
  var held: [(String?, CheckedContinuation<Fresh<CardsReply>, Error>)] = []
  var made: [String?] = []
  nonisolated func cards(tag: String?) async throws -> Fresh<CardsReply> { try await cards(tag: tag, workspace: nil) }
  nonisolated func cards(tag: String?, workspace: String?) async throws -> Fresh<CardsReply> {
    try await withCheckedThrowingContinuation { go in Task { @MainActor in self.held.append((workspace, go)) } }
  }
  func answer(_ index: Int, _ reply: CardsReply) { held[index].1.resume(returning: .new(reply, tag: "t\(index)")) }
  func fail(_ index: Int) { held[index].1.resume(throwing: WatchError.signedOut) }
  nonisolated func send(_ text: String, to id: String) async throws {}
  nonisolated func answer(_ act: MenuAct, menu: String, to id: String) async throws {}
  nonisolated func stop(_ id: String) async throws {}
  nonisolated func seen(_ id: String) async throws {}
  nonisolated func newAgent(_ text: String) async throws {}
  nonisolated func newAgent(_ text: String, in workspace: String?) async throws { await MainActor.run { made.append(workspace) } }
  nonisolated func frame(_ id: String, width: Int, tag: String?) async throws -> Fresh<Data> { .same }
  nonisolated func input(_ input: BrowserInput, to id: String) async throws {}
  nonisolated func note(_ id: String) async throws -> NoteBody { NoteBody(name: "", content: "") }
  nonisolated func unpair() async throws {}
}

@Suite("zooming while a read is out", .serialized)
@MainActor
struct ZoomRaceTests {
  private func settle() async { for _ in 0..<20 { await Task.yield() } }

  @Test("a read sent before going in and back out is not taken, answered or failed")
  func outAndBack() async {
    let api = HeldAPI()
    let felt = Felt()
    let s = WatchStore(api: api, feel: { felt.events.append($0) })
    let calm = [tile("dev", "Cookrew Dev", agents: 1), tile("goat", "GOAT Team", agents: 1)]
    let asking = [tile("dev", "Cookrew Dev", agents: 1), tile("goat", "GOAT Team", agents: 1, waiting: 1)]
    let stale = CardsReply(cards: [card("c", .working, goat), card("b", .working, dev)], activeWorkspaceId: "dev", workspaces: calm)
    let devOnly = CardsReply(cards: [card("b", .working, dev)], activeWorkspaceId: "dev", workspaces: calm)
    let fresh = CardsReply(cards: [card("c", .waiting, goat), card("b", .working, dev)], activeWorkspaceId: "dev", workspaces: asking)
    async let first: Void = s.refresh()
    await settle(); api.answer(0, stale); await first
    async let slow: Void = s.refresh()
    await settle()
    async let inside: Void = s.enter(workspace: "dev")
    await settle(); api.answer(2, devOnly); await inside
    // Out again: c started waiting while the wrist was inside dev, and it is said once.
    async let outside: Void = s.enter(workspace: nil)
    await settle(); api.answer(3, fresh); await outside
    #expect(felt.events == [.needsYou("GOAT Team")])
    // The read from before the zoom comes back last, with the old news: it is not taken.
    api.answer(1, stale); await slow
    #expect(s.cards.first { $0.id == "c" }?.status == .waiting)
    #expect(felt.events.count == 1)
    // One sent before a zoom fails after it: the wrist stays signed in and live.
    async let late: Void = s.refresh()
    await settle()
    async let moved: Void = s.enter(workspace: "goat")
    await settle(); api.answer(5, fresh); await moved
    api.fail(4); await late
    #expect(!s.signedOut)
    #expect(s.link == .live)
  }

  @Test("a new agent from inside a workspace starts there; from above, in the Mac's own")
  func seat() async {
    let api = HeldAPI()
    let s = WatchStore(api: api)
    s.setDraft("Write the release notes", for: newAgentPage)
    async let made: Void = s.send(page: newAgentPage)
    await settle(); api.answer(0, CardsReply(cards: [], activeWorkspaceId: "dev")); await made
    async let inside: Void = s.enter(workspace: "goat")
    await settle(); api.answer(1, CardsReply(cards: [], activeWorkspaceId: "dev")); await inside
    s.setDraft("Draft the brief", for: newAgentPage)
    async let again: Void = s.send(page: newAgentPage)
    await settle(); api.answer(2, CardsReply(cards: [], activeWorkspaceId: "dev")); await again
    #expect(api.made == [nil, "goat"])
  }
}

@Suite("zoom round two", .serialized)
@MainActor
struct ZoomRoundTwoTests {
  @Test("on a Mac too old to scope, zooming out says a wait once, by its agent")
  func oldMacOnce() async {
    let api = ScopedAPI()
    let calm = [card("a", .idle, goat), card("b", .working, dev)]
    let asking = [card("a", .waiting, goat), card("b", .working, dev)]
    api.replies = [CardsReply(cards: calm, activeWorkspaceId: "dev"), CardsReply(cards: calm, activeWorkspaceId: "dev"), CardsReply(cards: asking, activeWorkspaceId: "dev")]
    let felt = Felt()
    let s = WatchStore(api: api, feel: { felt.events.append($0) })
    await s.refresh()
    await s.enter(workspace: "dev")
    await s.enter(workspace: nil)
    #expect(felt.events == [.needsYou("A")])
  }

  @Test("going in before any card has come opens on the first card once it does, not on a new agent")
  func firstCard() async {
    let api = ScopedAPI()
    api.replies = [CardsReply(cards: [card("b", .working, dev)], activeWorkspaceId: "dev")]
    let s = WatchStore(api: api)
    await s.enter(workspace: "dev")
    #expect(s.page == "b")
  }
}
