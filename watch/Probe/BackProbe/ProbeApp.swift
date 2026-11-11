import CookrewCore
import CookrewWatchUI
import SwiftUI

// The real CardPager and CrewGrid, routed as ZoomStack routes them (WatchRoot.swift:
// path, stepOut, left), over a fixture store, so a UI test can press the way out
// the way a finger does. ZoomStack's routing is copied here: keep the two alike.

private final class NoAPI: WatchAPI, @unchecked Sendable {
  func cards(tag: String?) async throws -> Fresh<CardsReply> { .same }
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

private let ws = CardWorkspace(id: "w", name: "Cookrew Dev", active: true)
private let paragraph = "Text selection on the phone works now: hold, then drag. It is merged into dev and the app is restarted. The phone sends touch to the card's Chrome, and headless Chrome never turns a touch into a text selection."
private let reply = Array(repeating: paragraph, count: 5).joined(separator: "\n\n")
/** -mine: the long card carries the owner's real reply (Chinese, markdown) instead. */
private let longReply = ProcessInfo.processInfo.arguments.contains("-mine") ? mineReply : reply
private let short = "All 109 checks pass at 412, 375 and 1440."
private func fixture() -> [Card] {
  [
    Card(id: "a1", name: "Longer", preset: "Claude Code", workspace: ws, status: .done, word: "done", words: CardWords(text: "Text selection works now.", tone: .done, full: longReply)),
    Card(id: "a2", name: "Shorty", preset: "Claude Code", workspace: ws, status: .idle, word: "resting", words: CardWords(text: short, tone: .done)),
    Card(id: "a3", name: "Third", preset: "Codex", workspace: ws, status: .idle, word: "resting", words: CardWords(text: short, tone: .done))
  ] + (1...30).map { n in
    Card(id: "f\(n)", name: "Filler \(n)", preset: "Claude Code", workspace: ws, status: .idle, word: "resting", words: CardWords(text: short, tone: .done))
  }
}

private let arguments = ProcessInfo.processInfo.arguments
/** -restore: the wrist reopens on a card far down the crew, as a relaunch does. */
private let restore = arguments.contains("-restore")
/** -new-agent: it reopens on the new-agent page after the last card. */
private let onNewAgent = arguments.contains("-new-agent")
/** -stale: the crew is entered from above while the store still names a card far down. */
private let stale = arguments.contains("-stale")
private let firstPage: String? = onNewAgent ? newAgentPage : (restore || stale) ? "f30" : nil

/** -small: lay the wrist out at a 41 mm Series 8's 176 x 215 points (no simulator for it on watchOS 27). */
private let small = ProcessInfo.processInfo.arguments.contains("-small")

@main
struct ProbeApp: App {
  var body: some Scene {
    WindowGroup {
      if small {
        Probe().frame(width: 176, height: 215).clipped().frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      } else {
        Probe()
      }
    }
  }
}

private enum Route: Hashable { case agents, cards }

struct Probe: View {
  @State private var store: WatchStore = {
    let store = WatchStore(api: NoAPI())
    store.stage(cards: fixture(), page: firstPage, scope: "w")
    return store
  }()
  @State private var path: [Route] = restore || onNewAgent ? [.agents, .cards] : [.agents]
  @State private var left: String?

  var body: some View {
    NavigationStack(path: $path) {
      Text("DEVICES").accessibilityIdentifier("devices")
        .navigationDestination(for: Route.self) { route in
          switch route {
          case .agents:
            CrewGrid(store: store, left: left, onNewAgent: {
              left = nil
              store.page = newAgentPage
              path.append(.cards)
            }) { id in
              left = nil
              store.page = id
              path.append(.cards)
            }
            .navigationTitle("Agents")
          case .cards:
            pages
          }
        }
    }
    .overlay(alignment: .bottom) {
      // What the test reads: how far in the stack is.
      Text("depth \(path.count)").font(.system(size: 8)).accessibilityIdentifier("depth").allowsHitTesting(false)
    }
  }

  private func stepOut() {
    guard path.last == .cards else { return }
    left = store.page
    path.removeLast()
  }

  private var pages: some View {
    CardPager(store: store, onOut: stepOut, onItem: { _ in })
  }
}
