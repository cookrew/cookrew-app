// Every screen, drawn at watch size, with no watchOS SDK: the same SwiftUI views
// the app shows, rendered on a Mac over the watch's rounded glass and clock.
//   swift run watch-shots <out-dir>
//   swift run watch-shots <out-dir> live <http://mac:8639> <six digits>
// `live` pairs like the watch does, and draws what the real Mac answers.
#if os(macOS)
  import AppKit
  import CookrewCore
  import CookrewWatchUI
  import ImageIO
  import SwiftUI

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

  /** The watch's glass: its corners, and the clock the system draws over any app. */
  private struct Glass<Content: View>: View {
    let size: CGSize
    let palette: InkPalette
    @ViewBuilder let content: () -> Content

    var body: some View {
      ZStack(alignment: .topTrailing) {
        content()
          .padding(.top, size.height > 230 ? 4 : 2)
          .frame(width: size.width, height: size.height, alignment: .top)
          .background(palette.paper)
        Text("12:15")
          .font(.system(size: size.width > 190 ? 15 : 14, weight: .semibold, design: .rounded))
          .foregroundStyle(palette.ink)
          .padding(.top, 5)
          .padding(.trailing, 13)
      }
      .frame(width: size.width, height: size.height)
      .clipShape(RoundedRectangle(cornerRadius: size.width > 190 ? 38 : 34, style: .continuous))
      .environment(\.ink, palette)
      .environment(\.inkStill, true)
    }
  }

  private struct Shot {
    let name: String
    let view: AnyView
  }

  private let items = [
    CardItem(id: "b1", kind: .browser, title: "Browser cards", host: "file://docs", tint: "#7d6a9a", initial: "B"),
    CardItem(id: "b2", kind: .browser, title: "Cookrew logo", host: "127.0.0.1:5311", tint: "#6f8a5c", initial: "C"),
    CardItem(id: "n1", kind: .note, title: "plan", host: "note", tint: "#a8692b", initial: "")
  ]
  private let menu = WaitChoice(
    id: "m1", question: "Allow this edit to src/main/watch-routes.ts?", sub: "Edit · +12 −3",
    options: [
      WaitOption(key: "1", label: "Yes"),
      WaitOption(key: "2", label: "Yes, and allow all edits this session"),
      WaitOption(key: "3", label: "No, tell Claude what to do differently")
    ],
    cursor: 0, escIndex: 2
  )
  private let typing = WaitChoice(
    id: "m2", question: "Which card should the watch open on?", sub: nil,
    options: [
      WaitOption(key: "1", label: "The one that needs me", detail: "needs-you first"),
      WaitOption(key: "2", label: "The last one I read"),
      WaitOption(key: "3", label: "Type something", role: .type)
    ],
    cursor: 0
  )
  private let ws = CardWorkspace(id: "w", name: "Cookrew Dev", active: true)
  private let goat = CardWorkspace(id: "g", name: "GOAT Team", active: false)
  private let reply = "Text selection on the phone works now: hold, then drag. It's merged into dev and the app is restarted.\n\n**Why it didn't work before:** the phone sends touch to the card's Chrome, and headless Chrome never turns a touch into a text selection."
  private let cards = [
    Card(id: "a1", name: "Atlas", preset: "Claude Code", orch: true, workspace: ws, status: .waiting, word: "needs you", words: CardWords(text: "Allow this edit?", tone: .waiting), choice: menu, items: items, browsers: 2, notes: 1),
    Card(id: "a2", name: "交互优化", preset: "Claude Code", workspace: ws, status: .done, word: "done", words: CardWords(text: "Text selection on the phone works now.", tone: .done, full: reply), items: items, browsers: 2, notes: 1),
    Card(id: "a3", name: "Fresco", preset: "Codex", workspace: ws, status: .working, word: "working", words: CardWords(text: "Reading files", tone: .working), about: "Make the watch card match the phone's type scale", browsers: 1),
    Card(id: "a4", name: "Gauge", preset: "Claude Code", workspace: ws, status: .idle, word: "resting", words: CardWords(text: "All 109 checks pass at 412, 375 and 1440.", tone: .done)),
    Card(id: "a5", name: "Velvet", preset: "Pi", workspace: goat, status: .offline, word: "offline", words: CardWords(text: "The motion brief is in the note.", tone: .done), notes: 1),
    Card(id: "a6", name: "Tinker", preset: "OpenCode", workspace: goat, status: .waiting, word: "needs you", words: CardWords(text: "Should I push the release branch, or wait for the signing keys?", tone: .waiting)),
    Card(id: "a7", name: "Which", preset: "Claude Code", workspace: goat, status: .waiting, word: "needs you", choice: typing)
  ]

  @MainActor private func store(page: String?, draft: [String: String] = [:], sent: [String: String] = [:], notice: String? = nil) -> WatchStore {
    // One moment: a drawing takes longer than a row's fill.
    let moment = Date()
    let store = WatchStore(api: NoAPI(), now: { moment })
    store.stage(cards: cards, page: page, draft: draft, sent: sent, notice: notice)
    return store
  }

  @MainActor private func card(_ id: String, _ make: (WatchStore) -> Void = { _ in }, draft: [String: String] = [:], sent: [String: String] = [:], notice: String? = nil) -> AnyView {
    let s = store(page: id, draft: draft, sent: sent, notice: notice)
    make(s)
    let target = cards.first { $0.id == id }!
    return AnyView(CardPage(store: s, card: target, onFace: {}, onItem: { _ in }))
  }

  /** A stand-in page: a real picture of a page, from a file when one is given. */
  @MainActor private func pagePicture() -> CGImage? {
    let size = CGSize(width: 720, height: 560)
    let renderer = ImageRenderer(content:
      ZStack(alignment: .topLeading) {
        Color.white
        VStack(alignment: .leading, spacing: 18) {
          Text("Browser cards: drawn directly").font(.system(size: 44, weight: .bold))
          RoundedRectangle(cornerRadius: 10).fill(Color(hex: 0xEDE7DA)).frame(height: 120)
          Text("Hold on a word, then drag to select it. Tap ⧉ to copy.").font(.system(size: 26))
          RoundedRectangle(cornerRadius: 8).stroke(Color.gray, lineWidth: 2).frame(height: 56).overlay(alignment: .leading) { Text("Search…").font(.system(size: 24)).foregroundStyle(.gray).padding(.leading, 16) }
        }
        .padding(36)
      }
      .frame(width: size.width, height: size.height)
    )
    return renderer.cgImage
  }

  private let devices = [
    DeviceRow(id: "m1", name: "MacBook Pro", online: true, workspaces: 3, paired: true),
    DeviceRow(id: "m2", name: "Studio", online: false, workspaces: 1, paired: false)
  ]
  private let names = [MachineWorkspace(id: "w", name: "Cookrew Dev"), MachineWorkspace(id: "g", name: "GOAT Team"), MachineWorkspace(id: "p", name: "Playground")]

  /** The system's bar over a stop: its back chevron and title, which a drawing has no stack to make. */
  @MainActor private func titled(_ title: String, back: Bool, _ view: some View) -> AnyView {
    AnyView(VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 4) {
        if back { Text("‹").font(.system(size: 20, weight: .semibold)) }
        Text(title).font(.system(size: 15, weight: .semibold, design: .rounded)).lineLimit(1)
      }
      .foregroundStyle(Color(hex: 0xA8692B))
      .padding(.leading, 12)
      .padding(.trailing, 50)
      .frame(height: 24)
      view
    })
  }

  @MainActor private func shots() -> [Shot] {
    let blank = store(page: nil)
    let inside = store(page: nil)
    inside.stage(cards: cards, page: nil, scope: "w")
    let page = pagePicture()
    return [
      Shot(name: "01 needs you · menu", view: card("a1")),
      Shot(name: "02 row tapped", view: card("a1", { $0.stageAnswer(cards[0], row: 0) })),
      Shot(name: "03 menu with a row to type", view: card("a7")),
      Shot(name: "04 free question", view: card("a6")),
      Shot(name: "05 done · reply", view: card("a2")),
      Shot(name: "06 draft ready", view: card("a2", draft: ["a2": "Yes, merge it and tell me when it's live"])),
      Shot(name: "07 sent", view: card("a2", sent: ["a2": "Yes, merge it and tell me when it's live"])),
      Shot(name: "08 working", view: card("a3")),
      Shot(name: "09 stop armed", view: card("a3", { $0.stageStopArmed("a3") })),
      Shot(name: "10 resting", view: card("a4")),
      Shot(name: "11 asleep", view: card("a5")),
      Shot(name: "12 refused", view: card("a4", notice: "A dispatch is in flight")),
      Shot(name: "13 new agent", view: AnyView(NewAgentPage(store: blank))),
      Shot(name: "14 agents · one workspace", view: titled("Cookrew Dev", back: true, CrewGrid(store: inside, onNewAgent: {}, onPick: { _ in }))),
      Shot(name: "15 browser", view: AnyView(BrowserPage(store: blank, item: items[0], first: page))),
      Shot(name: "16 note", view: AnyView(NotePage(store: blank, item: items[2], first: NoteBody(name: "plan", content: "**Watch baseline**\n\nCards first, then the box.\nCrown walks the cards.")))),
      Shot(name: "17 pairing", view: AnyView(PairView(address: .constant("192.168.2.40"), digits: "4821", busy: false, failure: nil, onDigit: { _ in }, onDelete: {}))),
      Shot(name: "18 devices", view: titled("Devices", back: false, DevicesPage(rows: devices, onOpen: {}, onThisWatch: {}))),
      Shot(name: "19 workspaces", view: titled("MacBook Pro", back: true, WorkspacesPage(tiles: mergedTiles(blank.workspaces, names: names), onOpen: { _ in })))
    ]
  }

  @MainActor private func write(_ view: some View, scale: CGFloat, to url: URL) {
    let renderer = ImageRenderer(content: view)
    renderer.scale = scale
    guard let image = renderer.cgImage,
      let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
    else { return print("could not draw \(url.lastPathComponent)") }
    try? data.write(to: url)
  }

  /** Every screen on one sheet, at one size and palette. */
  @MainActor private func sheet(_ list: [Shot], size: CGSize, palette: InkPalette, title: String, to url: URL) {
    let columns = 6
    let sheet = VStack(alignment: .leading, spacing: 18) {
      Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
      LazyVGrid(columns: Array(repeating: GridItem(.fixed(size.width), spacing: 22), count: columns), alignment: .leading, spacing: 22) {
        ForEach(list.indices, id: \.self) { index in
          VStack(alignment: .leading, spacing: 6) {
            Glass(size: size, palette: palette) { list[index].view }
            Text(list[index].name).font(.system(size: 11)).foregroundStyle(.gray)
          }
        }
      }
    }
    .padding(24)
    .background(Color(hex: 0x1A1A1C))
    write(sheet, scale: 2, to: url)
  }

  /** The real Mac, through the real client: pair, read, answer nothing, draw. */
  @MainActor private func live(out: URL, base: URL, code: String) async {
    do {
      let claim = try await claimWatch(base: base, code: code)
      print("paired with \(claim.desktop); it says it can be reached at \(claim.bases.map(\.kind))")
      let api = HTTPWatchAPI(bases: [base], token: claim.token)
      let store = WatchStore(api: api)
      await store.refresh()
      print("link \(store.link), \(store.cards.count) cards: \(store.cards.prefix(8).map { "\($0.name)[\($0.status.rawValue)]" })")
      guard case .new(_, let tag) = try await api.cards(tag: nil), case .same = try await api.cards(tag: tag) else { return print("no 304 on an unchanged crew") }
      print("an unchanged crew answers 304")
      var list = store.cards.prefix(11).map { card in
        Shot(name: card.name, view: AnyView(CardPage(store: store, card: card, onFace: {}, onItem: { _ in })))
      }
      list.append(Shot(name: "workspaces", view: AnyView(WorkspacesPage(tiles: store.workspaces, onOpen: { _ in }))))
      if let item = store.cards.flatMap(\.items).first(where: { $0.kind == .browser }) {
        // Asking is what makes a picture exist: the app polls, so this does too.
        for _ in 0..<12 {
          if case .new(let data, _)? = try? await api.frame(item.id, width: 396, tag: nil) {
            print("frame of \(item.host): \(data.count) bytes")
            list.append(Shot(name: item.host, view: AnyView(BrowserPage(store: store, item: item, first: picture(of: data)))))
            break
          }
          try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
      }
      sheet(Array(list), size: CGSize(width: 198, height: 242), palette: .day, title: "45 mm · live, from the real Mac", to: out.appending(path: "live-45.png"))
      print("drew \(list.count) live screens")
    } catch {
      print("live failed: \(error)")
    }
  }

  /** Every pairing screen, one file each, for looking at one by one. */
  @MainActor private func pairingScreens(out: URL) {
    let pad = { (typed: String, error: String?) in AnyView(CodePad(typed: typed, error: error, onKey: { _ in }, onDelete: {})) }
    let note = { (title: String, words: String, action: String) in AnyView(NoticeView(title: title, words: words, action: action, onAction: {}, onStartOver: {})) }
    let screens: [(String, AnyView)] = [
      ("welcome", AnyView(WelcomeView(onCode: {}, onDigits: {}))),
      ("pad-empty", pad("", nil)),
      ("pad-typing", pad("K7QM2X", nil)),
      ("pad-wrong", pad("K7QM2XPD", "Wrong or expired code")),
      ("joining", AnyView(JoinSteps(done: [], now: "Joining your account…"))),
      ("finding", AnyView(JoinSteps(done: ["Joined your account"], now: "Finding your Mac…"))),
      ("paired", AnyView(JoinSteps(done: ["Joined your account", "Paired with MacBook Pro"], now: nil))),
      ("mac-away", note("Can't reach your Mac", "You're in your account. Wake the Mac, then try again.", "Try again")),
      ("this-watch", AnyView(ThisWatchPage(desktop: "MacBook Pro", account: "drej", line: .relay, onForget: {}))),
      ("this-watch-no-account", AnyView(ThisWatchPage(desktop: "MacBook Pro", account: nil, line: .direct, onForget: {}))),
      ("new-agent", AnyView(NewAgentPage(store: WatchStore(api: NoAPI()))))
    ]
    for (name, view) in screens {
      write(Glass(size: CGSize(width: 198, height: 242), palette: .day) { view }, scale: 2, to: out.appending(path: "pair-\(name).png"))
      write(Glass(size: CGSize(width: 176, height: 215), palette: .day) { view }, scale: 2, to: out.appending(path: "pair-\(name)-41.png"))
    }
    print("drew \(screens.count) pairing screens")
  }

  /** Holds what the Keychain would, for a run with none. */
  private final class Held: @unchecked Sendable {
    var account: WatchAccount?
  }

  /**
   * The real act against a real registry and relay, for the integration test:
   * join, claim, read the cards down the relay, renew, read again, forget.
   * One line per fact; tests/watch-join.integration.test.ts reads them.
   */
  @MainActor private func join(registry origin: String, code: String) async {
    guard let url = URL(string: origin) else { return print("bad registry") }
    let api = HTTPRegistryAPI(origin: url)
    let device = WatchDevice()
    let held = Held()
    let outcome = await pairWatch(
      code: code, held: nil, device: device, name: "Apple Watch", registry: origin, api: api, now: nowMs(),
      keep: { held.account = $0 }, step: { print("step \($0)") }
    )
    guard case .paired(let session, let account) = outcome else { return print("failed \(outcome)") }
    print("paired \(session.desktop) as \(account.username)")
    print("bases \(session.bases.map(\.kind).joined(separator: ","))")
    guard let road = session.bases.last, let relay = URL(string: road.url) else { return print("no relay") }
    let keeper = AccountKeeper(account: account, device: device, api: api, keep: { held.account = $0 })
    let line = HTTPWatchAPI(bases: [relay], token: session.token, relay: keeper)
    do {
      if case .new(let reply, _) = try await line.cards(tag: nil) { print("cards \(reply.cards.count) line \(line.line)") }
      let home = HTTPWatchAPI(bases: session.urls, token: session.token, relay: keeper)
      if case .new(let reply, _) = try await home.cards(tag: nil) { print("cards-home \(reply.cards.count) line \(home.line)") }
      print("renewed \(await keeper.renew()) \(held.account?.token != account.token)")
      if case .new(let reply, _) = try await line.cards(tag: nil) { print("cards-after-renew \(reply.cards.count)") }
      try await line.unpair()
      print("unpaired")
      _ = try await line.cards(tag: nil)
      print("still-open")
    } catch {
      print("stopped \(error)")
    }
    let again = await pairWatch(
      code: code, held: held.account, device: device, name: "Apple Watch", registry: origin, api: api, now: nowMs(),
      keep: { held.account = $0 }, step: { _ in }
    )
    print("second-claim \(again)")
    if let token = held.account?.token {
      await api.signOut(token: token)
      do {
        _ = try await api.desktops(token: token)
        print("session-still-open")
      } catch {
        print("session-ended \(error)")
      }
    }
  }

  private func picture(of data: Data) -> CGImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
  }

  @main
  struct Shots {
    @MainActor static func main() async {
      let out = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "/tmp/watch-shots")
      try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
      if CommandLine.arguments.count >= 5, CommandLine.arguments[2] == "join" {
        await join(registry: CommandLine.arguments[3], code: CommandLine.arguments[4])
        return
      }
      if CommandLine.arguments.count >= 3, CommandLine.arguments[2] == "pairing" {
        pairingScreens(out: out)
        return
      }
      if CommandLine.arguments.count >= 5, CommandLine.arguments[2] == "live", let base = URL(string: CommandLine.arguments[3]) {
        await live(out: out, base: base, code: CommandLine.arguments[4])
        return
      }
      // The app's icon: an ensō on paper, filling the glass.
      write(
        ZStack {
          InkPalette.day.paper
          InkFace(id: "cookrew", preset: "Claude Code", orch: true, status: .idle, size: 760, weight: .large)
        }
        .frame(width: 1024, height: 1024)
        .environment(\.ink, .day)
        .environment(\.inkStill, true),
        scale: 1,
        to: out.appending(path: "icon-1024.png")
      )
      let list = shots()
      sheet(list, size: CGSize(width: 198, height: 242), palette: .day, title: "45 mm · day", to: out.appending(path: "day-45.png"))
      sheet(list, size: CGSize(width: 198, height: 242), palette: .night, title: "45 mm · night (always-on)", to: out.appending(path: "night-45.png"))
      sheet(list, size: CGSize(width: 176, height: 215), palette: .day, title: "41 mm · day", to: out.appending(path: "day-41.png"))
      print("drew \(list.count) screens into \(out.path)")
    }
  }
#else
  @main struct Shots { static func main() {} }
#endif
