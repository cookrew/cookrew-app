import CookrewCore
import Observation
import SwiftUI
#if canImport(WatchKit)
  import WatchKit
#endif

/** The wrist's taps: one for a question, one for done, a click for what was sent. */
func feel(_ event: WatchEvent) {
  #if canImport(WatchKit)
    let device = WKInterfaceDevice.current()
    switch event {
    case .needsYou: device.play(.notification)
    case .done: device.play(.directionUp)
    case .sent: device.play(.success)
    case .refused: device.play(.failure)
    }
  #endif
}

/** Paired or not, and everything that goes with being paired. */
@MainActor
@Observable
final class WatchApp {
  private let vault = SessionVault()
  private(set) var store: WatchStore?
  var address: String
  private(set) var digits = ""
  private(set) var busy = false
  private(set) var failure: PairFailure?

  init(address: String) {
    self.address = address
    if let session = vault.load() { open(session) }
  }

  private func open(_ session: WatchSession) {
    store = WatchStore(api: HTTPWatchAPI(bases: session.urls, token: session.token), feel: feel)
  }

  func press(_ digit: String) {
    failure = nil
    guard digits.count < 6 else { return }
    digits += digit
    if digits.count == 6 { Task { await pair() } }
  }

  func delete() {
    failure = nil
    if !digits.isEmpty { digits.removeLast() }
  }

  private func pair() async {
    guard let base = baseURL(typed: address) else {
      failure = .noAddress
      digits = ""
      return
    }
    busy = true
    defer { busy = false }
    do {
      let reply = try await claimWatch(base: base, code: digits)
      let bases = basesAfterClaim(typed: Base(kind: "typed", url: base.absoluteString), named: reply.bases)
      let session = WatchSession(desktop: reply.desktop, bases: bases, token: reply.token)
      vault.save(session)
      digits = ""
      open(session)
    } catch WatchError.refused(let reason) {
      digits = ""
      failure = .refused(reason)
    } catch {
      digits = ""
      failure = .unreachable
    }
  }

  /** The Mac forgot this watch. */
  func forget() {
    vault.clear()
    store = nil
  }
}

private enum Route: Hashable {
  case item(CardItem.ID)
  case crew
}

private extension View {
  /** A card uses the whole of the glass: its head sits beside the system's clock, not under it. */
  func wholeGlass() -> some View {
    ignoresSafeArea(.container, edges: .top)
  }
}

/** The pages: every card, then the new agent. The crown walks them. */
struct CardPager: View {
  @Bindable var store: WatchStore
  @State private var path: [Route] = []
  @State private var items: [CardItem.ID: CardItem] = [:]

  var body: some View {
    NavigationStack(path: $path) {
      pages
        .navigationDestination(for: Route.self) { route in
          switch route {
          case .crew:
            CrewGrid(store: store) { id in
              store.page = id
              path = []
            }
            .wholeGlass()
          case .item(let id):
            if let item = items[id] { itemPage(item) }
          }
        }
    }
  }

  @ViewBuilder private func itemPage(_ item: CardItem) -> some View {
    switch item.kind {
    case .browser: BrowserPage(store: store, item: item).wholeGlass()
    case .note: NotePage(store: store, item: item).wholeGlass()
    }
  }

  private var pages: some View {
    TabView(selection: $store.page) {
      ForEach(store.cards) { card in
        CardPage(store: store, card: card, onFace: { path = [.crew] }, onItem: { item in
          items[item.id] = item
          path = [.item(item.id)]
        })
        .wholeGlass()
        .tag(Optional(card.id))
      }
      NewAgentPage(store: store).wholeGlass().tag(Optional(newAgentPage))
    }
    #if os(watchOS)
      .tabViewStyle(.verticalPage)
      .toolbar(.hidden, for: .navigationBar)
    #endif
  }
}

/** The app: pairing, or the cards. */
public struct WatchRoot: View {
  @State private var app: WatchApp
  @Environment(\.isLuminanceReduced) private var dim
  @Environment(\.scenePhase) private var phase

  public init(address: String) {
    _app = State(initialValue: WatchApp(address: address))
  }

  public var body: some View {
    Group {
      if let store = app.store {
        CardPager(store: store)
          .overlay(alignment: .bottom) { LinkChip(store: store) }
          .task(id: phase) {
            guard phase == .active else { return }
            await store.run()
            if store.unpaired { app.forget() }
          }
      } else {
        PairView(address: $app.address, digits: app.digits, busy: app.busy, failure: app.failure, onDigit: app.press, onDelete: app.delete)
          .wholeGlass()
      }
    }
    .environment(\.ink, dim ? .night : .day)
    .environment(\.inkStill, false)
  }
}

/** The only thing the wrist says about the line: when it is down. */
struct LinkChip: View {
  let store: WatchStore
  @Environment(\.ink) private var ink

  var body: some View {
    if store.link == .lost {
      Text("MAC OFFLINE")
        .font(InkType.word(9.5))
        .tracking(1)
        .foregroundStyle(ink.onSeal)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(ink.wait))
        .padding(.bottom, 48)
    }
  }
}
