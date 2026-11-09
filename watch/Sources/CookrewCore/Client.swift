import Foundation

public enum WatchError: Error, Equatable, Sendable {
  /** The Mac does not know this watch any more. */
  case unpaired
  /** The Mac said no, in words. */
  case refused(String)
  /** No way to the Mac just now. */
  case unreachable
  /** The relay will not have this session any more, and it could not be renewed. */
  case signedOut
}

/** Which road the cards last came down. */
public enum WatchLine: Equatable, Sendable {
  case direct
  case relay
}

public enum Fresh<Value: Sendable>: Sendable {
  case same
  case new(Value, tag: String?)
}

/** Everything the app asks of a Mac. */
public protocol WatchAPI: Sendable {
  func cards(tag: String?) async throws -> Fresh<CardsReply>
  func cards(tag: String?, workspace: String?) async throws -> Fresh<CardsReply>
  func send(_ text: String, to id: String) async throws
  func answer(_ act: MenuAct, menu: String, to id: String) async throws
  func stop(_ id: String) async throws
  func seen(_ id: String) async throws
  func newAgent(_ text: String) async throws
  /** A new agent in this workspace, as a phone seated in it makes one; nil is the Mac's own. */
  func newAgent(_ text: String, in workspace: String?) async throws
  func frame(_ id: String, width: Int, tag: String?) async throws -> Fresh<Data>
  /** A thumbnail's picture: what the Mac already has, starting no browser. */
  func peek(_ id: String, width: Int, tag: String?) async throws -> Fresh<Data>
  func input(_ input: BrowserInput, to id: String) async throws
  func note(_ id: String) async throws -> NoteBody
  /** Tell the Mac to end this watch's token. */
  func unpair() async throws
  var line: WatchLine { get }
}

public extension WatchAPI {
  var line: WatchLine { .direct }

  func newAgent(_ text: String, in workspace: String?) async throws {
    try await newAgent(text)
  }

  func peek(_ id: String, width: Int, tag: String?) async throws -> Fresh<Data> { .same }

  /** One workspace's cards. A Mac that cannot scope sends every card, and the store keeps the ones asked for. */
  func cards(tag: String?, workspace: String?) async throws -> Fresh<CardsReply> {
    try await cards(tag: tag)
  }
}

/** The request cannot have reached the Mac: nothing was connected. */
func neverLeft(_ error: Error) -> Bool {
  guard let code = (error as? URLError)?.code else { return false }
  return [.cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .notConnectedToInternet, .appTransportSecurityRequiresSecureConnection, .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot].contains(code)
}

/** The refusal's words, when the Mac sent some. */
private struct Refusal: Decodable {
  let error: String?
  let reason: String?
}

/** The one pairing call: no token yet, one address. */
public func claimWatch(base: URL, code: String, session: URLSession = .shared) async throws -> ClaimReply {
  var request = URLRequest(url: base.appending(path: "api/watch/claim"), timeoutInterval: 12)
  request.httpMethod = "POST"
  request.setValue("application/json", forHTTPHeaderField: "content-type")
  request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code])
  let (data, response): (Data, URLResponse)
  do {
    (data, response) = try await session.data(for: request)
  } catch {
    throw WatchError.unreachable
  }
  guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
    let reason = (try? JSONDecoder().decode(Refusal.self, from: data))?.reason
    throw WatchError.refused(reason ?? "wrong")
  }
  return try JSONDecoder().decode(ClaimReply.self, from: data)
}

/** How long a road that proved itself is believed: a watch changes networks without a word. */
private let helloSeconds: TimeInterval = 15
/** A home network answers at once; away from home this is what the first read waits. */
private let helloPatience: TimeInterval = 3
/** A proof is a few dozen bytes. */
private let helloMaxBytes = 512

/** The token goes to the road it was proved on or nowhere, so nothing here follows a redirect. */
private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

private let noRedirects = NoRedirects()

/** The work's answer, or nil at the deadline. A request's own timeout is only an idle timer. */
func within<Value: Sendable>(_ seconds: TimeInterval, _ work: @escaping @Sendable () async -> Value?) async -> Value? {
  await withTaskGroup(of: Value?.self) { group in
    group.addTask { await work() }
    group.addTask {
      try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
      return nil
    }
    let first = await group.next() ?? nil
    group.cancelAll()
    return first
  }
}

/** The Mac over HTTP: the base that last answered, then the others in order. */
public final class HTTPWatchAPI: WatchAPI, @unchecked Sendable {
  private let bases: [URL]
  private let token: String
  private let session: URLSession
  private let relay: RelayPass?
  /** A watch that roams: its plain roads may be anyone's, so they prove themselves first. */
  private let guarded: Bool
  private let lock = NSLock()
  private var sticky = 0
  private var proven: [URL: Date] = [:]

  public init(bases: [URL], token: String, session: URLSession = .shared, relay: RelayPass? = nil, guarded: Bool? = nil) {
    self.guarded = guarded ?? (relay != nil)
    self.bases = bases
    self.token = token
    self.session = session
    self.relay = relay
  }

  private func onRelay(_ url: URL) -> Bool {
    relay != nil && url.host() == relay?.host && url.port == relay?.port
  }

  public var line: WatchLine {
    lock.lock()
    defer { lock.unlock() }
    return bases.indices.contains(sticky) && onRelay(bases[sticky]) ? .relay : .direct
  }

  private func order() -> [Int] {
    lock.lock()
    defer { lock.unlock() }
    return [sticky] + bases.indices.filter { $0 != sticky }
  }

  private func stick(_ index: Int) {
    lock.lock()
    sticky = index
    lock.unlock()
  }

  /** One road, one try. The relay wants the session as well as the Mac's token. */
  private func request(_ url: URL, _ method: String, payload: Data?, tag: String?, cookie: String?) -> URLRequest {
    let read = method == "GET"
    // A write can wake an agent, and that takes a while. A read on the home
    // network is quick or it is not there: away from home it must not hold up the relay.
    let patience: TimeInterval = read ? (isPrivateHost(url.host() ?? "") ? 4 : 10) : 30
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: patience)
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    if let tag { request.setValue(tag, forHTTPHeaderField: "if-none-match") }
    if let payload {
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.httpBody = payload
    }
    if let cookie {
      request.httpShouldHandleCookies = false
      request.setValue("\(sessionCookie)=\(cookie)", forHTTPHeaderField: "cookie")
    }
    return request
  }

  private func exchange(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)? {
    let (data, response) = try await session.data(for: request, delegate: noRedirects)
    return (response as? HTTPURLResponse).map { (data, $0) }
  }

  /** The body of a hello, inside its deadline: a slow or endless answer is no answer. */
  private func hello(_ ask: URLRequest) async -> Data? {
    let session = self.session
    return await within(helloPatience) {
      guard let (bytes, response) = try? await session.bytes(for: ask, delegate: noRedirects),
        (response as? HTTPURLResponse)?.statusCode == 200
      else { return nil }
      var body = Data()
      do {
        for try await byte in bytes {
          body.append(byte)
          if body.count > helloMaxBytes { return nil }
        }
      } catch {
        return nil
      }
      return body
    }
  }

  /** The relay's own refusal of the session, not the Mac's of this watch. */
  private func sessionRefused(_ answer: (Data, HTTPURLResponse)) -> Bool {
    answer.1.statusCode == 401 && (try? JSONDecoder().decode(Refusal.self, from: answer.0))?.error == "unauthenticated"
  }

  private func provenAt(_ base: URL) -> Date? {
    lock.lock()
    defer { lock.unlock() }
    return proven[base]
  }

  private func setProven(_ base: URL, _ at: Date?) {
    lock.lock()
    proven[base] = at
    lock.unlock()
  }

  /**
   * May the token go to this road? A watch that roams keeps a plain-HTTP address
   * from home, and on the next network that address may be anyone. So it asks for
   * proof first, sending nothing, and only the Mac holding this token can give it.
   * That also means anything such a road says afterwards is the Mac's own word, a
   * 401 included. A watch paired by six digits has only ever been on this network
   * and has no other road, so it stays as it was. One that has lost its account has
   * still roamed, and goes on asking.
   */
  private func mayUse(_ base: URL) async -> Bool {
    guard guarded, base.scheme == "http", !onRelay(base) else { return true }
    if let at = provenAt(base), Date().timeIntervalSince(at) < helloSeconds { return true }
    let nonce = base64urlEncoded(Data((0..<24).map { _ in UInt8.random(in: 0...255) }))
    var url = base.appending(path: "api/watch/hello")
    url.append(queryItems: [URLQueryItem(name: "n", value: nonce)])
    let ask = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: helloPatience)
    struct Hello: Decodable {
      let proof: String
    }
    guard let body = await hello(ask),
      let answer = try? JSONDecoder().decode(Hello.self, from: body),
      answer.proof == helloProof(token: token, nonce: nonce)
    else {
      setProven(base, nil)
      return false
    }
    setProven(base, Date())
    return true
  }

  /**
   * A read tries every way there. A write moves on only when it never left: a
   * timed-out POST may still be at work on the Mac, and sent again down the next
   * road it would say the words twice, stop twice, or make two agents. A 503
   * from the relay never reached the Mac, so even a write moves on from it; a
   * 502 or 504 may have, so a write stops there.
   */
  private func call(_ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: Any]? = nil, tag: String? = nil) async throws -> (Data, HTTPURLResponse) {
    guard !bases.isEmpty else { throw WatchError.unreachable }
    let payload = try body.map { try JSONSerialization.data(withJSONObject: $0) }
    let read = method == "GET"
    var signedOut = false
    // Whichever road this takes: a watch that stays home must not outlive its session.
    if let relay { Task { _ = await relay.token() } }
    for index in order() {
      guard await mayUse(bases[index]) else { continue }
      var url = bases[index].appending(path: path)
      if !query.isEmpty { url.append(queryItems: query) }
      let relayed = onRelay(url)
      do {
        let cookie = relayed ? await relay?.token() : nil
        guard var answer = try await exchange(request(url, method, payload: payload, tag: tag, cookie: cookie)) else { continue }
        if let cookie, sessionRefused(answer) {
          // Nothing reached the Mac, so even a write may go again, on a token
          // that has replaced this one. With none, the session is over.
          guard let next = await relay?.newer(than: cookie),
            let again = try await exchange(request(url, method, payload: payload, tag: tag, cookie: next)),
            !sessionRefused(again)
          else {
            signedOut = true
            continue
          }
          answer = again
        }
        // A Mac that forgot this watch cannot prove itself on this road, and could
        // not say so here. So a 401 is the road gone, whoever is on it now; if the
        // watch really was forgotten the relay says that in the Mac's own words.
        if guarded, !relayed, url.scheme == "http", answer.1.statusCode == 401 {
          setProven(bases[index], nil)
          continue
        }
        if relayed {
          if answer.1.statusCode == 503 { continue }
          if answer.1.statusCode == 502 || answer.1.statusCode == 504 {
            if read { continue }
            throw WatchError.unreachable
          }
        }
        stick(index)
        return answer
      } catch let error as WatchError {
        throw error
      } catch {
        setProven(bases[index], nil)
        if read || neverLeft(error) { continue }
        throw WatchError.unreachable
      }
    }
    throw signedOut ? WatchError.signedOut : WatchError.unreachable
  }

  private func checked(_ data: Data, _ http: HTTPURLResponse) throws {
    if http.statusCode == 401 { throw WatchError.unpaired }
    guard (200..<300).contains(http.statusCode) else {
      let words = (try? JSONDecoder().decode(Refusal.self, from: data))
      throw WatchError.refused(words?.error ?? words?.reason ?? "The computer said no.")
    }
  }

  private func post(_ path: String, _ body: [String: Any] = [:]) async throws {
    let (data, http) = try await call("POST", path, body: body)
    try checked(data, http)
  }

  public func cards(tag: String?) async throws -> Fresh<CardsReply> {
    try await cards(tag: tag, workspace: nil)
  }

  public func cards(tag: String?, workspace: String?) async throws -> Fresh<CardsReply> {
    let query = workspace.map { [URLQueryItem(name: "workspace", value: $0)] } ?? []
    let (data, http) = try await call("GET", "api/watch/cards", query: query, tag: tag)
    if http.statusCode == 304 { return .same }
    try checked(data, http)
    return .new(try JSONDecoder().decode(CardsReply.self, from: data), tag: http.value(forHTTPHeaderField: "etag"))
  }

  public func send(_ text: String, to id: String) async throws {
    try await post("api/terminal/\(id)/input", ["text": text])
  }

  public func answer(_ act: MenuAct, menu: String, to id: String) async throws {
    let (data, http) = try await call("POST", "api/terminal/\(id)/menu", body: ["menu": menu, "act": act.json])
    try checked(data, http)
    // The Mac checks the answer against the screen: 200 can still be a no.
    struct Result: Decodable {
      let ok: Bool
      let reason: String?
    }
    if let result = try? JSONDecoder().decode(Result.self, from: data), !result.ok {
      throw WatchError.refused(result.reason ?? "refused")
    }
  }

  public func stop(_ id: String) async throws {
    try await post("api/watch/card/\(id)/stop")
  }

  public func seen(_ id: String) async throws {
    try await post("api/terminal/\(id)/seen")
  }

  public func newAgent(_ text: String) async throws {
    try await newAgent(text, in: nil)
  }

  public func newAgent(_ text: String, in workspace: String?) async throws {
    // The seat is the phone's own word for it (mobile-api.ts · deviceSeat): this request's focus, nothing moved on the Mac.
    let seat = workspace.map { [URLQueryItem(name: "seat", value: $0)] } ?? []
    let (data, http) = try await call("POST", "api/watch/new", query: seat, body: ["text": text])
    try checked(data, http)
  }

  public func frame(_ id: String, width: Int, tag: String?) async throws -> Fresh<Data> {
    try await picture(id, width: width, tag: tag, peek: false)
  }

  public func peek(_ id: String, width: Int, tag: String?) async throws -> Fresh<Data> {
    try await picture(id, width: width, tag: tag, peek: true)
  }

  private func picture(_ id: String, width: Int, tag: String?, peek: Bool) async throws -> Fresh<Data> {
    var query = [URLQueryItem(name: "w", value: String(width))]
    if peek { query.append(URLQueryItem(name: "peek", value: "1")) }
    let (data, http) = try await call("GET", "api/watch/item/\(id)/frame", query: query, tag: tag)
    if http.statusCode == 304 { return .same }
    try checked(data, http)
    return .new(data, tag: http.value(forHTTPHeaderField: "etag"))
  }

  public func input(_ input: BrowserInput, to id: String) async throws {
    try await post("api/watch/item/\(id)/input", input.json)
  }

  public func unpair() async throws {
    try await post("api/watch/unpair")
  }

  public func note(_ id: String) async throws -> NoteBody {
    let (data, http) = try await call("GET", "api/watch/item/\(id)")
    try checked(data, http)
    return try JSONDecoder().decode(NoteBody.self, from: data)
  }
}
