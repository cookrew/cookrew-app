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
  private let registry: HTTPRegistryAPI
  private(set) var store: WatchStore?
  private var keeper: AccountKeeper?
  private(set) var desktop = ""
  private(set) var username: String?
  /** The account's Macs, for the devices stop; empty with no account. */
  private(set) var machines: [WatchMachine] = []
  /** The paired Mac's id, from its relay road; nil when paired by six digits. */
  private(set) var pairedId: String?
  /** Every machine the watch holds a key for (sessionKey), the one it is in among them. */
  private(set) var heldMachines: Set<String> = []
  /** Machines asked in the background this launch. */
  private var knocked: Set<String> = []
    /** The machine the wrist is in, as the vault keys it. */
  private(set) var current: String?
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
    pairedId = pairedMachineId(session.bases)
    current = sessionKey(session)
    heldMachines = Set(vault.shelf().keys)
    machines = []
    // With no account the relay would only refuse, and read as the Mac forgetting this watch.
    let urls = session.bases.filter { held != nil || $0.kind != "relay" }.compactMap { URL(string: $0.url) }
    let roams = session.bases.contains { $0.kind == "relay" }
    store = WatchStore(api: HTTPWatchAPI(bases: urls, token: session.token, relay: pass, guarded: roams), feel: feel)
  }

  /** The paired Mac as the account lists it: by its id, or by its name. */
  var pairedMachine: WatchMachine? {
    let byId = pairedId.flatMap { id in machines.first { $0.id.lowercased() == id } }
    return byId ?? machines.first { $0.name == desktop }
  }

  /** The account's Macs. Best effort: with no answer the devices stop shows the paired one. */
  func readMachines() async {
    guard let keeper else { return }
    let token = await keeper.token()
    if let found = try? await registry.machines(token: token) { machines = found }
    await enterTheRest()
  }

  /** Into another machine the watch holds a key for, at its workspaces. */
  func switchTo(_ id: String) {
    guard let session = vault.activate(id.lowercased()) else { return }
    UserDefaults.standard.set(ZoomLevel.workspaces.stored, forKey: keptZoomKey)
    ThumbPictures.forget()
    open(session)
  }

  /**
   * Into a machine of the account the watch holds no key for yet, with the watch's
   * pass: no code (owner, 2026-11-09). Gone into when asked; kept quietly when
   * the Devices stop finds a machine added since. Nil when it is in.
   */
  func enter(id: String, name: String, goIn: Bool) async -> EnterError? {
    guard let account = vault.loadAccount(), let keeper else { return .noDoor }
    guard let relay = relayBase(registry: account.registry, desktop: id) else { return .noDoor }
    let session = await keeper.token()
    do {
      let grant = try await registry.watchGrant(token: session)
      let token = try await enterMachine(device: vault.device(), machine: id, grant: grant, send: registry.door(relay: relay, token: session))
      let entered = WatchSession(desktop: name, bases: [Base(kind: "relay", url: relay.absoluteString)], token: token)
      vault.save(entered, goIn: goIn)
      heldMachines = Set(vault.shelf().keys)
      if goIn { switchTo(sessionKey(entered)) }
      return nil
    } catch RegistryError.notWatch {
      return .notWatch
    } catch let error as EnterError {
      return error
    } catch {
      return .unreachable
    }
  }

  /** Every machine of the account the watch is not in yet and can reach now: entered, not gone into. */
  private func enterTheRest() async {
    for machine in machines where machine.online && !heldMachines.contains(machine.id.lowercased()) && !knocked.contains(machine.id) {
      // Once a launch: a machine that said no (older than the watch's pass) is not asked on every visit.
      knocked.insert(machine.id)
      _ = await enter(id: machine.id, name: machine.name, goIn: false)
    }
  }

  /** Pair another machine of the account: its code adds it beside the ones held. */
  func addMachine() {
    store = nil
    enterCode()
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

  /**
   * One machine let go of. With another held the wrist goes into it; with none,
   * everything but who this watch is goes: pairing again is the same row on the account.
   */
  private func leave(to next: PairStage) {
    if let current { vault.forget(current) }
    UserDefaults.standard.removeObject(forKey: keptZoomKey)
    ThumbPictures.forget()
    if let other = vault.load() {
      typed = ""
      open(other)
      return
    }
    keeper?.retire()
    let held = vault.loadAccount()
    vault.clear()
    vault.clearAccount()
    // The next Mac has its own workspaces: the zoom starts again at the top of it.
    UserDefaults.standard.removeObject(forKey: keptZoomKey)
    ThumbPictures.forget()
    store = nil
    username = nil
    heldMachines = []
    current = nil
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
  case workspaces
  case agents(String)
  case cards(String)
  case item(CardItem.ID)
  case thisWatch
  case addMachine(String, String?)
}

/** Why a machine could not be gone into with the watch's pass, as the code page says it. */
private func addNote(_ why: EnterError) -> String? {
  switch why {
  case .noDoor: return nil
  case .notWatch: return "This watch joined before it could open every machine. One more code, from any of them, and it opens them all."
  case .refused(let words): return words
  case .unreachable: return "Can't reach it just now. Try again, or use its code."
  case .wrongMachine: return "Another machine answered for it. Nothing was sent; use its code."
  }
}

/** The stack that stands for a zoom level: each stop is one step in from the last. */
private func routes(to level: ZoomLevel) -> [Route] {
  switch level {
  case .devices: return []
  case .workspaces: return [.workspaces]
  case .agents(let id): return [.workspaces, .agents(id)]
  case .cards(let id): return [.workspaces, .agents(id), .cards(id)]
  }
}

/** How far in the stack is; a page on top of a card (an item, this watch) is still that card's level. */
private func level(of path: [Route]) -> ZoomLevel {
  for route in path.reversed() {
    switch route {
    case .cards(let id): return .cards(id)
    case .agents(let id): return .agents(id)
    case .workspaces: return .workspaces
    case .item, .thisWatch, .addMachine: continue
    }
  }
  return .devices
}

/** Where the zoom was left, across launches. */
private let keptZoomKey = "cookrew.watch.zoom"

/**
 * THE ZOOM: devices → workspaces → agents → one card, as the Mac's zoom bar
 * walks it. A row is a step in; the back chevron, or the card's face, a step
 * out. The cards are read for the workspace the wrist is inside.
 */
struct ZoomStack: View {
  @Bindable var store: WatchStore
  let app: WatchApp
  @AppStorage(keptZoomKey) private var kept = ZoomLevel.workspaces.stored
  @State private var path: [Route] = []
  @State private var opened = false
  @State private var items: [CardItem.ID: CardItem] = [:]
  /** The page just stepped out of, for its crew to bring into view; gone once the wrist moves on. */
  @State private var left: String?

  var body: some View {
    NavigationStack(path: $path) {
      // Every stop wears the HITL bar (owner 2026-11-12); above a workspace it holds the day's cards of the paired Mac.
      HitlPage(store: store, onAgent: openCard, onItem: openItem) { _ in
        DevicesPage(
          rows: deviceRows(app.machines, pairedId: app.pairedId, desktop: app.desktop, live: store.link == .live, held: app.heldMachines),
          onOpen: { path = [.workspaces] },
          onSwitch: app.switchTo,
          onAdd: { row in
            Task {
              guard let why = await app.enter(id: row.id, name: row.name, goIn: true) else { return }
              path.append(.addMachine(row.name, addNote(why)))
            }
          },
          onThisWatch: { path.append(.thisWatch) }
        )
      }
      .navigationTitle("Devices")
      .navigationDestination(for: Route.self) { route in destination(route) }
    }
    .onAppear {
      guard !opened else { return }
      opened = true
      path = routes(to: ZoomLevel(stored: kept))
    }
    .onChange(of: path) { _, next in
      let now = level(of: next)
      kept = now.stored
      if case .agents = now {} else { left = nil }
      Task { await store.enter(workspace: now.scope) }
    }
    .task { await app.readMachines() }
  }

  private func name(of workspace: String) -> String {
    store.workspaces.first { $0.id == workspace }?.name ?? "Agents"
  }

  @ViewBuilder private func destination(_ route: Route) -> some View {
    switch route {
    case .workspaces:
      HitlPage(store: store, onAgent: openCard, onItem: openItem) { _ in
        WorkspacesPage(tiles: mergedTiles(store.workspaces, names: app.pairedMachine?.workspaces ?? []), machine: store.machine) { id in
          path.append(.agents(id))
        }
      }
      .navigationTitle(app.desktop)
    case .agents(let id):
      HitlPage(store: store, onAgent: openCard, onItem: openItem) { newOpen in
        // The crew's ＋ seat opens the bar's box in place: no page of its own.
        CrewGrid(store: store, left: left, onNewAgent: { newOpen.wrappedValue = true }) { card in open(card, in: id) }
      }
      .navigationTitle(name(of: id))
    case .cards:
      CardPager(store: store, onOut: stepOut, onItem: openItem)
    case .thisWatch:
      ThisWatchPage(desktop: app.desktop, account: app.username, line: store.client.line, onCode: app.signInAgain, onForget: { Task { await app.forget() } }).wholeGlass()
    case .item(let id):
      if let item = items[id] { itemPage(item) }
    case .addMachine(let name, let note):
      AddMachinePage(name: name, note: note, onCode: app.addMachine)
    }
  }

  /** A face on a bar: that agent's card, from whatever stop, in its own workspace. */
  private func openCard(_ card: Card) {
    left = nil
    store.page = card.id
    path = routes(to: .cards(card.workspace.id))
  }

  /** A picture on a bar or a card: that artifact's page, over the stop it was tapped on. */
  private func openItem(_ item: CardItem) {
    items[item.id] = item
    path.append(.item(item.id))
  }

  /** Into one card: the crown walks its workspace's cards from there. */
  private func open(_ page: String, in workspace: String) {
    left = nil
    store.page = page
    path.append(.cards(workspace))
  }

  /** The card's head, or a swipe right: one step out, to its crew, its face kept in view there. */
  private func stepOut() {
    guard case .cards = path.last else { return }
    left = store.page
    path.removeLast()
  }

  @ViewBuilder private func itemPage(_ item: CardItem) -> some View {
    switch item.kind {
    case .browser: BrowserPage(store: store, item: item).wholeGlass()
    case .note: NotePage(store: store, item: item).wholeGlass()
    }
  }

}

/** The app: pairing, or the cards. */
public struct WatchRoot: View {
  @State private var app: WatchApp
  @Environment(\.isLuminanceReduced) private var dim
  @Environment(\.scenePhase) private var phase

  public init(address: String, registry: String = "https://api.cookrew.dev") {
    _app = State(initialValue: WatchApp(address: address, registry: registry))
  }

  public var body: some View {
    Group {
      if let store = app.store {
        ZoomStack(store: store, app: app)
          .overlay(alignment: .bottom) { LinkChip(store: store, onSignIn: app.signInAgain) }
          .task(id: phase) {
            guard phase == .active else { return }
            await store.run()
            if store.unpaired { app.lost(.unpaired, by: store) }
          }
          .onChange(of: store.cards) { _, cards in
            guard let key = app.current else { return }
            StatusAlerts.note(cards, machine: key, name: app.desktop, inFront: phase == .active)
          }
          // Another machine is another store: its own stack and its own poll, from the top.
          .id(ObjectIdentifier(store))
      } else {
        PairingView(app: app).wholeGlass()
      }
    }
    .environment(\.ink, dim ? .night : .day)
    .environment(\.inkStill, false)
    .task { await StatusAlerts.ask() }
    // Leaving the wrist: the next background read is asked for, so status changes still reach it.
    .onChange(of: phase) { _, next in if next != .active { StatusAlerts.scheduleNext() } }
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
    case .working(.finding): JoinSteps(done: ["Joined your account"], now: "Finding your computer…")
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
      NoticeView(title: "Can't reach your computer", words: "You're in your account. Wake the computer, then try again.", action: "Try again", onAction: { Task { await app.submit() } }, onStartOver: app.home)
    case .noNetwork:
      NoticeView(title: "No connection", words: "The watch can't reach cookrew.dev.", action: "Try again", onAction: { Task { await app.submit() } }, onStartOver: app.home)
    case .locked:
      NoticeView(title: "Account locked", words: "Change your password on your computer, then get a new code.", action: "OK", onAction: app.home)
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
      Text("\(store.machine.uppercased()) OFFLINE")
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
