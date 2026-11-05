import Foundation
import Testing
@testable import CookrewCore

private actor Calls {
  var log: [String] = []
  func add(_ line: String) { log.append(line) }
}

private final class FakeAPI: WatchAPI, @unchecked Sendable {
  let calls = Calls()
  var replies: [[Card]] = []
  var failure: WatchError?
  var reads = 0

  func cards(tag: String?) async throws -> Fresh<CardsReply> {
    if let failure, reads > 0 { throw failure }
    let index = min(reads, replies.count - 1)
    reads += 1
    return .new(CardsReply(cards: replies[index], activeWorkspaceId: "w"), tag: "t\(index)")
  }
  func act(_ line: String) async throws {
    await calls.add(line)
    if let failure { throw failure }
  }
  func send(_ text: String, to id: String) async throws { try await act("send \(id): \(text)") }
  func answer(_ act: MenuAct, menu: String, to id: String) async throws { try await self.act("answer \(id): \(act)") }
  func stop(_ id: String) async throws { try await act("stop \(id)") }
  func seen(_ id: String) async throws { try await act("seen \(id)") }
  func newAgent(_ text: String) async throws { try await act("new: \(text)") }
  func frame(_ id: String, width: Int, tag: String?) async throws -> Fresh<Data> { .same }
  func input(_ input: BrowserInput, to id: String) async throws { try await act("input \(id): \(input)") }
  func note(_ id: String) async throws -> NoteBody { NoteBody(name: "n", content: "c") }
}

private actor Waits {
  var all: [Double] = []
  func add(_ seconds: Double) { all.append(seconds) }
}

private let menu = WaitChoice(id: "m1", question: "Allow?", options: [WaitOption(key: "1", label: "Yes"), WaitOption(key: "2", label: "No")], cursor: 0, escIndex: 1)
private let typing = WaitChoice(id: "m2", question: "Which?", options: [WaitOption(key: "1", label: "A"), WaitOption(key: "2", label: "Type something", role: .type)])

private func card(_ id: String, _ status: CardStatus, choice: WaitChoice? = nil) -> Card {
  Card(id: id, name: id.capitalized, status: status, word: status.rawValue, choice: choice)
}

@MainActor
private final class Clock {
  var date = Date(timeIntervalSince1970: 1000)
  func tick(_ seconds: Double) { date = date.addingTimeInterval(seconds) }
}

@MainActor
private func harness(_ replies: [[Card]]) async -> (WatchStore, FakeAPI, Clock, EventLog) {
  let api = FakeAPI()
  api.replies = replies
  let clock = Clock()
  let events = EventLog()
  let store = WatchStore(api: api, now: { clock.date }, feel: { events.items.append($0) })
  await store.refresh()
  return (store, api, clock, events)
}

@MainActor
private final class EventLog {
  var items: [WatchEvent] = []
}

@Suite("the wrist's state")
@MainActor
struct StoreTests {
  @Test("the first page is the card that needs the owner, and the first read buzzes nothing")
  func firstRead() async {
    let (store, _, _, events) = await harness([[card("a", .waiting, choice: menu), card("b", .idle)]])
    #expect(store.page == "a")
    #expect(store.link == .live)
    #expect(events.items.isEmpty)
  }

  @Test("a reorder never moves the page; a card that left gives way to the first")
  func pageKept() async {
    let (store, _, _, _) = await harness([[card("a", .idle), card("b", .idle)], [card("c", .waiting), card("b", .idle), card("a", .idle)], [card("c", .waiting)]])
    store.page = "b"
    await store.refresh()
    #expect(store.page == "b")
    await store.refresh()
    #expect(store.page == "c")
  }

  @Test("an agent starting to wait taps the wrist; so does a reply, once")
  func feelings() async {
    let (store, _, _, events) = await harness([[card("a", .working), card("b", .working)], [card("a", .waiting, choice: menu), card("b", .done)], [card("a", .waiting, choice: menu), card("b", .done)]])
    await store.refresh()
    await store.refresh()
    #expect(events.items == [.needsYou("A"), .done("B")])
  }

  @Test("the box says who it goes to")
  func words() {
    #expect(placeholder(for: nil) == "Describe a task for a new agent…")
    #expect(placeholder(for: card("atlas", .idle)) == "Reply to Atlas…")
    #expect(placeholder(for: card("atlas", .waiting)) == "Answer Atlas…")
    #expect(placeholder(for: card("atlas", .offline)) == "Atlas is asleep · wakes on send")
    #expect(placeholder(for: card("atlas", .waiting, choice: typing)) == "Or type your own answer…")
    #expect(boxWords(for: card("atlas", .idle)) == "Reply…")
    #expect(boxWords(for: card("atlas", .waiting)) == "Answer…")
    #expect(boxWords(for: card("atlas", .offline)) == "Wakes on send…")
    #expect(quickWords(for: card("atlas", .waiting)) == ["Yes", "No", "Go on"])
    #expect(quickWords(for: card("atlas", .waiting, choice: menu)).isEmpty)
    #expect(quickWords(for: card("atlas", .done)).isEmpty)
    #expect(boxTarget(for: card("a", .waiting, choice: menu)) == .rowsOnly)
    #expect(boxTarget(for: card("a", .waiting, choice: typing)) == .menuWords("a"))
    #expect(boxTarget(for: card("a", .idle)) == .reply("a"))
    #expect(boxTarget(for: nil) == .newAgent)
  }

  @Test("words go to the agent, stand on the card, and leave the box empty")
  func send() async {
    let (store, api, clock, events) = await harness([[card("a", .idle)]])
    store.setDraft("  go on  ", for: "a")
    await store.send(page: "a")
    #expect(await api.calls.log == ["send a: go on"])
    #expect(store.draft("a") == "")
    #expect(store.sent("a") == "go on")
    #expect(events.items == [.sent])
    clock.tick(sentSeconds)
    #expect(store.sent("a") == nil)
  }

  @Test("words the Mac refuses come back to the box, with why")
  func refused() async {
    let (store, api, _, events) = await harness([[card("a", .idle)]])
    api.failure = .refused("A dispatch is in flight")
    store.setDraft("go on", for: "a")
    await store.send(page: "a")
    #expect(store.draft("a") == "go on")
    #expect(store.notice == "A dispatch is in flight")
    #expect(events.items == [.refused])
  }

  @Test("an empty box sends nothing, and a menu with no row to type in takes no words")
  func nothing() async {
    let (store, api, _, _) = await harness([[card("a", .idle), card("b", .waiting, choice: menu)]])
    store.setDraft("   ", for: "a")
    await store.send(page: "a")
    store.setDraft("yes", for: "b")
    await store.send(page: "b")
    #expect(await api.calls.log.isEmpty)
    #expect(store.draft("b") == "yes")
  }

  @Test("words into a menu's row go as words, by its id")
  func menuWords() async {
    let (store, api, _, _) = await harness([[card("a", .waiting, choice: typing)]])
    store.setDraft("the third way", for: "a")
    await store.send(page: "a")
    #expect(await api.calls.log == ["answer a: words(\"the third way\")"])
  }

  @Test("a new agent is made from the last page's words")
  func newAgent() async {
    let (store, api, _, _) = await harness([[card("a", .idle)]])
    store.setDraft("Fix the build", for: newAgentPage)
    await store.send(page: newAgentPage)
    #expect(await api.calls.log == ["new: Fix the build"])
  }

  @Test("a row fills for a beat, the menu stays shut while the agent takes it, and shows again if it did not")
  func rows() async {
    let (store, api, clock, _) = await harness([[card("a", .waiting, choice: menu)]])
    let a = store.cards[0]
    await store.answer(a, row: 0)
    #expect(await api.calls.log == ["answer a: row(0)"])
    #expect(store.waitView(a)?.sent == 0)
    await store.answer(a, row: 1)
    #expect(await api.calls.log.count == 1)
    clock.tick(answerFillSeconds)
    #expect(store.waitView(a) == nil)
    clock.tick(answerRetrySeconds)
    #expect(store.waitView(a)?.sent == nil)
    #expect(store.waitView(a)?.choice == menu)
  }

  @Test("what the time changes is redrawn at its moment: the store wakes itself")
  func wakes() async {
    let api = FakeAPI()
    api.replies = [[card("a", .waiting, choice: menu), card("b", .working)]]
    let waits = Waits()
    let store = WatchStore(api: api, sleep: { await waits.add($0) })
    await store.refresh()
    await store.answer(store.cards[0], row: 0)
    await store.stop(store.cards[1])
    for _ in 0..<20 { await Task.yield() }
    #expect(await waits.all.sorted() == [answerFillSeconds, stopArmSeconds, answerRetrySeconds].sorted())
  }

  @Test("a tick stays open; a menu that moved says so and shows again")
  func ticksAndMoved() async {
    let tick = WaitChoice(id: "m3", question: "Which?", options: [WaitOption(key: "1", label: "A", role: .toggle, checked: false)])
    let (store, api, _, events) = await harness([[card("a", .waiting, choice: tick)]])
    let a = store.cards[0]
    await store.answer(a, row: 0)
    #expect(store.waitView(a)?.sent == nil)
    api.failure = .refused("moved")
    await store.answer(a, row: 0)
    #expect(store.notice == "The menu moved on · nothing sent")
    #expect(events.items.last == .refused)
  }

  @Test("stop takes two taps inside the window")
  func stop() async {
    let (store, api, clock, _) = await harness([[card("a", .working)]])
    let a = store.cards[0]
    await store.stop(a)
    #expect(store.stopArmed("a"))
    #expect(await api.calls.log.isEmpty)
    clock.tick(stopArmSeconds)
    #expect(!store.stopArmed("a"))
    await store.stop(a)
    await store.stop(a)
    #expect(await api.calls.log == ["stop a"])
  }

  @Test("a reply looked at is read, once")
  func read() async {
    let (store, api, _, _) = await harness([[card("a", .done), card("b", .idle)]])
    await store.read(store.cards[0])
    await store.read(store.cards[0])
    await store.read(store.cards[1])
    #expect(await api.calls.log == ["seen a"])
  }

  @Test("losing the Mac keeps the cards on screen and says so; a dead token asks to pair")
  func link() async {
    let (store, api, _, _) = await harness([[card("a", .idle)]])
    api.failure = .unreachable
    await store.refresh()
    #expect(store.link == .lost)
    #expect(store.cards.count == 1)
    api.failure = .unpaired
    await store.refresh()
    #expect(store.unpaired)
  }
}

/** Answers one road with `failure`, and records what reached each. */
private final class Roads: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var failure: URLError.Code = .timedOut
  nonisolated(unsafe) static var hits: [String] = []

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}
  override func startLoading() {
    Self.hits.append(request.url?.host() ?? "")
    if request.url?.host() == "10.0.0.1" {
      client?.urlProtocol(self, didFailWithError: URLError(Self.failure))
      return
    }
    let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(#"{"cards":[],"activeWorkspaceId":"w"}"#.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
}

@Suite("two roads to one Mac", .serialized)
struct FailoverTests {
  private func api() -> HTTPWatchAPI {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [Roads.self]
    return HTTPWatchAPI(bases: [URL(string: "http://10.0.0.1:8639")!, URL(string: "http://10.0.0.2:8639")!], token: "t", session: URLSession(configuration: config))
  }

  @Test("a timed-out write is not sent again down the next road")
  func writeTimedOut() async {
    Roads.hits = []
    Roads.failure = .timedOut
    await #expect(throws: WatchError.unreachable) { try await api().send("go on", to: "a") }
    #expect(Roads.hits == ["10.0.0.1"])
  }

  @Test("a write that never connected takes the next road")
  func writeRefused() async throws {
    Roads.hits = []
    Roads.failure = .cannotConnectToHost
    try await api().send("go on", to: "a")
    #expect(Roads.hits == ["10.0.0.1", "10.0.0.2"])
  }

  @Test("a read takes the next road whatever happened, and the road that answered is tried first after")
  func read() async throws {
    Roads.hits = []
    Roads.failure = .timedOut
    let client = api()
    _ = try await client.cards(tag: nil)
    _ = try await client.cards(tag: nil)
    #expect(Roads.hits == ["10.0.0.1", "10.0.0.2", "10.0.0.2"])
  }
}

@Suite("a page on a wrist")
struct FrameTests {
  private let picture = CGSize(width: 720, height: 560)
  private let box = CGSize(width: 188, height: 160)

  @Test("the picture fits its box, centred")
  func fit() {
    let rect = fitRect(picture: picture, in: box)
    #expect(abs(rect.height - 146.2) < 0.1)
    #expect(rect.width == 188)
    #expect(abs(rect.midY - 80) < 0.001)
    #expect(fitRect(picture: .zero, in: box) == .zero)
  }

  @Test("a tap lands where it was aimed, whole or looked at closer, and off the picture it lands nowhere")
  func tap() throws {
    let fit = fitRect(picture: picture, in: box)
    let centre = CGPoint(x: fit.midX, y: fit.midY)
    let whole = try #require(PictureView().fraction(of: centre, fit: fit))
    #expect(abs(whole.x - 0.5) < 0.001 && abs(whole.y - 0.5) < 0.001)
    #expect(PictureView().fraction(of: CGPoint(x: 94, y: 2), fit: fit) == nil)

    // At 2x, panned a quarter of the picture to the left: the centre shows three quarters across... of the half.
    let close = PictureView(zoom: 2, pan: CGSize(width: -fit.width / 2, height: 0))
    let there = try #require(close.fraction(of: centre, fit: fit))
    #expect(abs(there.x - 0.75) < 0.001)
    #expect(abs(there.y - 0.5) < 0.001)
  }

  @Test("a pan stops at the picture's edge")
  func clamp() {
    let fit = fitRect(picture: picture, in: box)
    let limited = PictureView(zoom: 2, pan: CGSize(width: 9999, height: -9999)).clamped(fit: fit, box: box)
    #expect(limited.pan.width == (fit.width * 2 - box.width) / 2)
    #expect(limited.pan.height == -(fit.height * 2 - box.height) / 2)
    #expect(PictureView(zoom: 1, pan: CGSize(width: 40, height: 40)).clamped(fit: fit, box: box).pan == .zero)
  }

  @Test("crown turns add up and none is lost; the first reading turns nothing")
  func crown() {
    var scroll = CrownScroll()
    scroll.turned(to: 10)
    #expect(scroll.take() == nil)
    scroll.turned(to: 10.5)
    scroll.turned(to: 11)
    #expect(scroll.take() == 60)
    #expect(scroll.take() == nil)
    scroll.turned(to: 10)
    #expect(scroll.take() == -60)
  }
}

@Suite("the way to the Mac")
struct SessionTests {
  @Test("a bare address is the companion's plain port; a full one stands; the open internet takes no plain HTTP")
  func typed() {
    #expect(baseURL(typed: " 192.168.2.40 ")?.absoluteString == "http://192.168.2.40:8639")
    #expect(baseURL(typed: "100.64.1.2:9000")?.absoluteString == "http://100.64.1.2:9000")
    #expect(baseURL(typed: "https://a.d.cookrew.dev:8643")?.absoluteString == "https://a.d.cookrew.dev:8643")
    #expect(baseURL(typed: "  ") == nil)
    #expect(baseURL(typed: "8.8.8.8") == nil)
    #expect(baseURL(typed: "http://example.com") == nil)
    #expect(baseURL(typed: "172.32.0.1") == nil)
    #expect(baseURL(typed: "172.20.0.1") != nil)
  }

  @Test("a name with a real certificate goes first, then what was typed; nothing twice, nothing public in the clear")
  func bases() {
    let typed = Base(kind: "typed", url: "http://192.168.2.40:8639")
    let named = [Base(kind: "lan", url: "http://192.168.2.40:8639"), Base(kind: "tailnet", url: "http://100.64.1.2:8639"), Base(kind: "name", url: "https://x.d.cookrew.dev:8643"), Base(kind: "lan", url: "http://8.8.8.8:8639")]
    #expect(basesAfterClaim(typed: typed, named: named).map(\.url) == ["https://x.d.cookrew.dev:8643", "http://192.168.2.40:8639", "http://100.64.1.2:8639"])
  }

  @Test("an id goes into a path once-encoded")
  func path() {
    let base = URL(string: "http://192.168.2.40:8639")!
    #expect(base.appending(path: "api/terminal/a b/input").absoluteString == "http://192.168.2.40:8639/api/terminal/a%20b/input")
  }

  @Test("only what never connected may go down another road")
  func left() {
    #expect(neverLeft(URLError(.cannotConnectToHost)))
    #expect(neverLeft(URLError(.dnsLookupFailed)))
    #expect(!neverLeft(URLError(.timedOut)))
    #expect(!neverLeft(URLError(.networkConnectionLost)))
  }
}
