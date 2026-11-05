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

/** Where pairing has got to. */
enum PairStage: Equatable {
  case welcome
  case pad
  case digits
  case working(JoinStep)
  case paired(String)
  case notice(PairNotice)
}

/** What stopped the pairing, or ended it. */
enum PairNotice: Equatable {
  case ended
  case slow
  case macAway
  case noNetwork
  case locked
  case unpaired
  case signedOut
}

/** How long the tick stays up before the cards. */
private let pairedSeconds = 1.2

/** Paired or not, and everything that goes with being paired. */
@MainActor
@Observable
final class WatchApp {
  private let vault = SessionVault()
  private let origin: String
  private let registry: RegistryAPI
  private(set) var store: WatchStore?
  private var keeper: AccountKeeper?
  private(set) var desktop = ""
  private(set) var username: String?
  private(set) var stage: PairStage = .welcome
  private(set) var typed = ""
  private(set) var padError: String?
  var address: String
  private(set) var digits = ""
  private(set) var busy = false
  private(set) var failure: PairFailure?
  private var submitting = false
  private var forgetting = false
  /** A code whose join never got its reply: the registry may have spent it. */
  private var unanswered: String?

  init(address: String, registry origin: String) {
    self.address = address
    self.origin = origin
    registry = HTTPRegistryAPI(origin: URL(string: origin) ?? URL(filePath: "/"))
    if let session = vault.load() { open(session) }
  }

  private func open(_ session: WatchSession) {
    let held = vault.loadAccount()
    let vault = self.vault
    let pass = held.map { AccountKeeper(account: $0, device: vault.device(), api: registry, keep: { vault.saveAccount($0) }) }
    keeper?.retire()
    keeper = pass
    desktop = session.desktop
    username = held?.username
    // With no account the relay would only refuse, and read as the Mac forgetting this watch.
    let urls = session.bases.filter { held != nil || $0.kind != "relay" }.compactMap { URL(string: $0.url) }
    let roams = session.bases.contains { $0.kind == "relay" }
    store = WatchStore(api: HTTPWatchAPI(bases: urls, token: session.token, relay: pass, guarded: roams), feel: feel)
  }

  func show(_ next: PairStage) {
    padError = nil
    stage = next
  }

  /** Back where the watch belongs: its cards if it still has a Mac, the start if not. */
  func home() {
    show(.welcome)
    if let session = vault.load() { open(session) }
  }

  // MARK: One code

  func enterCode() {
    typed = ""
    show(.pad)
  }

  /** From the cards: the Mac's token stays until a new code has replaced it. */
  func signInAgain() {
    keeper?.retire()
    store = nil
    enterCode()
  }

  func key(_ letter: String) {
    padError = nil
    guard typed.count < codeLength else { return }
    typed += letter
    if typed.count == codeLength { Task { await submit() } }
  }

  /** An empty pad has nothing to delete, so the key steps back out. */
  func deleteKey() {
    padError = nil
    if typed.isEmpty { home() } else { typed.removeLast() }
  }

  func submit() async {
    guard !submitting else { return }
    submitting = true
    defer { submitting = false }
    stage = .working(.joining)
    let vault = self.vault
    let outcome = await pairWatch(
      code: typed,
      held: vault.loadAccount(),
      device: vault.device(),
      name: "Apple Watch",
      registry: origin,
      api: registry,
      now: nowMs(),
      keep: { vault.saveAccount($0) },
      step: { [weak self] step in
        Task { @MainActor in
          guard let self, case .working = self.stage else { return }
          self.stage = .working(step)
        }
      }
    )
    switch outcome {
    case .paired(let session, _): await finish(session)
    case .failed(let why):
      let lost = unanswered == typed
      unanswered = why == .noNetwork && vault.loadAccount() == nil ? typed : nil
      stopped(afterLostReply(why, unanswered: lost))
    }
  }

  private func finish(_ session: WatchSession) async {
    vault.save(session)
    feel(.sent)
    stage = .paired(session.desktop)
    try? await Task.sleep(nanoseconds: UInt64(pairedSeconds * 1_000_000_000))
    typed = ""
    open(session)
  }

  private func stopped(_ why: JoinFailure) {
    feel(.refused)
    switch why {
    case .wrongCode:
      stage = .pad
      padError = "Wrong or expired code"
    case .ended: stage = .notice(.ended)
    case .newDevice:
      // The code is spent, so this one cannot try again; the next goes in as a new device.
      vault.newDevice()
      vault.clearAccount()
      stage = .notice(.ended)
    case .slow: stage = .notice(.slow)
    case .macAway: stage = .notice(.macAway)
    case .noNetwork: stage = .notice(.noNetwork)
    case .locked: stage = .notice(.locked)
    case .signedOut:
      vault.clearAccount()
      stage = .notice(.signedOut)
    }
  }

  // MARK: Six digits, on the Mac's own network

  func press(_ digit: String) {
    failure = nil
    guard digits.count < 6 else { return }
    digits += digit
    if digits.count == 6 { Task { await pair() } }
  }

  func delete() {
    failure = nil
    if digits.isEmpty { home() } else { digits.removeLast() }
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

  // MARK: Leaving

  /** Everything but who this watch is: pairing again is the same row on the account. */
  private func leave(to next: PairStage) {
    keeper?.retire()
    let held = vault.loadAccount()
    vault.clear()
    vault.clearAccount()
    store = nil
    username = nil
    typed = ""
    show(next)
    guard let held else { return }
    let registry = self.registry
    Task { await registry.signOut(token: held.token) }
  }

  /** The owner's own Forget, from the wrist: the Mac ends the token, the account the session. */
  func forget() async {
    forgetting = true
    defer { forgetting = false }
    try? await store?.client.unpair()
    leave(to: .welcome)
  }

  /** The Mac forgot this watch. Said by the store in use, not one already left. */
  func lost(_ why: PairNotice, by reporter: WatchStore) {
    guard store === reporter, !forgetting else { return }
    leave(to: .notice(why))
  }
}

private enum Route: Hashable {
  case item(CardItem.ID)
  case crew
  case thisWatch
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
  let desktop: String
  let username: String?
  let onSignIn: () -> Void
  let onForget: () -> Void
  @State private var path: [Route] = []
  @State private var items: [CardItem.ID: CardItem] = [:]

  var body: some View {
    NavigationStack(path: $path) {
      pages
        .navigationDestination(for: Route.self) { route in
          switch route {
          case .crew:
            CrewGrid(store: store, onThisWatch: { path = [.crew, .thisWatch] }) { id in
              store.page = id
              path = []
            }
            .wholeGlass()
          case .thisWatch:
            ThisWatchPage(desktop: desktop, account: username, line: store.client.line, onCode: onSignIn, onForget: onForget).wholeGlass()
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
      NewAgentPage(store: store, onThisWatch: { path = [.thisWatch] }).wholeGlass().tag(Optional(newAgentPage))
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

  public init(address: String, registry: String = "https://cookrew.dev") {
    _app = State(initialValue: WatchApp(address: address, registry: registry))
  }

  public var body: some View {
    Group {
      if let store = app.store {
        CardPager(store: store, desktop: app.desktop, username: app.username, onSignIn: app.signInAgain, onForget: { Task { await app.forget() } })
          .overlay(alignment: .bottom) { LinkChip(store: store, onSignIn: app.signInAgain) }
          .task(id: phase) {
            guard phase == .active else { return }
            await store.run()
            if store.unpaired { app.lost(.unpaired, by: store) }
          }
      } else {
        PairingView(app: app).wholeGlass()
      }
    }
    .environment(\.ink, dim ? .night : .day)
    .environment(\.inkStill, false)
  }
}

/** Whichever screen pairing has got to. */
private struct PairingView: View {
  @Bindable var app: WatchApp

  var body: some View {
    switch app.stage {
    case .welcome: WelcomeView(onCode: app.enterCode, onDigits: { app.show(.digits) })
    case .pad: CodePad(typed: app.typed, error: app.padError, onKey: app.key, onDelete: app.deleteKey)
    case .digits:
      PairView(address: $app.address, digits: app.digits, busy: app.busy, failure: app.failure, onDigit: app.press, onDelete: app.delete)
    case .working(.joining): JoinSteps(done: [], now: "Joining your account…")
    case .working(.finding): JoinSteps(done: ["Joined your account"], now: "Finding your Mac…")
    case .paired(let desktop): JoinSteps(done: ["Joined your account", "Paired with \(desktop)"], now: nil)
    case .notice(let notice): noticeView(notice)
    }
  }

  @ViewBuilder private func noticeView(_ notice: PairNotice) -> some View {
    switch notice {
    case .ended:
      NoticeView(title: "That code ended", words: "A code lasts ten minutes. Get a new one from ⋯ → Apple Watch.", action: "Enter a new code", status: .waiting, onAction: app.enterCode)
    case .slow:
      NoticeView(title: "Too many tries", words: "Wait a minute, then try again.", action: "Back", onAction: app.enterCode)
    case .macAway:
      NoticeView(title: "Can't reach your Mac", words: "You're in your account. Wake the Mac, then try again.", action: "Try again", onAction: { Task { await app.submit() } }, onStartOver: app.home)
    case .noNetwork:
      NoticeView(title: "No connection", words: "The watch can't reach cookrew.dev.", action: "Try again", onAction: { Task { await app.submit() } }, onStartOver: app.home)
    case .locked:
      NoticeView(title: "Account locked", words: "Change your password on your Mac, then get a new code.", action: "OK", onAction: app.home)
    case .unpaired:
      NoticeView(title: "Watch unpaired", words: "Pair it again from ⋯ → Apple Watch.", action: "Enter a code", onAction: app.enterCode)
    case .signedOut:
      NoticeView(title: "Sign in again", words: "The watch has been off for a long while. One new code brings it back.", action: "Enter a code", onAction: app.enterCode)
    }
  }
}

/** The only thing the wrist says about the line: when it is down. */
struct LinkChip: View {
  let store: WatchStore
  let onSignIn: () -> Void
  @Environment(\.ink) private var ink

  var body: some View {
    if store.signedOut {
      Button(action: onSignIn) {
        Text("SIGN IN AGAIN")
          .font(InkType.word(9.5))
          .tracking(1)
          .foregroundStyle(ink.onSeal)
          .padding(.horizontal, 10)
          .padding(.vertical, 6)
          .background(Capsule().fill(ink.wait))
      }
      .buttonStyle(.plain)
      .padding(.bottom, 48)
    } else if store.link == .lost {
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
