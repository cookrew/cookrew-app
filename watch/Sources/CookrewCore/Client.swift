import Foundation

public enum WatchError: Error, Equatable, Sendable {
  /** The Mac does not know this watch any more. */
  case unpaired
  /** The Mac said no, in words. */
  case refused(String)
  /** No way to the Mac just now. */
  case unreachable
}

public enum Fresh<Value: Sendable>: Sendable {
  case same
  case new(Value, tag: String?)
}

/** Everything the app asks of a Mac. */
public protocol WatchAPI: Sendable {
  func cards(tag: String?) async throws -> Fresh<CardsReply>
  func send(_ text: String, to id: String) async throws
  func answer(_ act: MenuAct, menu: String, to id: String) async throws
  func stop(_ id: String) async throws
  func seen(_ id: String) async throws
  func newAgent(_ text: String) async throws
  func frame(_ id: String, width: Int, tag: String?) async throws -> Fresh<Data>
  func input(_ input: BrowserInput, to id: String) async throws
  func note(_ id: String) async throws -> NoteBody
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

/** The Mac over HTTP: the base that last answered, then the others in order. */
public final class HTTPWatchAPI: WatchAPI, @unchecked Sendable {
  private let bases: [URL]
  private let token: String
  private let session: URLSession
  private let lock = NSLock()
  private var sticky = 0

  public init(bases: [URL], token: String, session: URLSession = .shared) {
    self.bases = bases
    self.token = token
    self.session = session
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

  /**
   * A read tries every way there. A write moves on only when it never left: a
   * timed-out POST may still be at work on the Mac, and sent again down the next
   * road it would say the words twice, stop twice, or make two agents.
   */
  private func call(_ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: Any]? = nil, tag: String? = nil) async throws -> (Data, HTTPURLResponse) {
    guard !bases.isEmpty else { throw WatchError.unreachable }
    let payload = try body.map { try JSONSerialization.data(withJSONObject: $0) }
    let read = method == "GET"
    for index in order() {
      var url = bases[index].appending(path: path)
      if !query.isEmpty { url.append(queryItems: query) }
      // A write can wake an agent, and that takes a while.
      var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: read ? 10 : 30)
      request.httpMethod = method
      request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
      if let tag { request.setValue(tag, forHTTPHeaderField: "if-none-match") }
      if let payload {
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = payload
      }
      do {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { continue }
        stick(index)
        return (data, http)
      } catch {
        if read || neverLeft(error) { continue }
        throw WatchError.unreachable
      }
    }
    throw WatchError.unreachable
  }

  private func checked(_ data: Data, _ http: HTTPURLResponse) throws {
    if http.statusCode == 401 { throw WatchError.unpaired }
    guard (200..<300).contains(http.statusCode) else {
      let words = (try? JSONDecoder().decode(Refusal.self, from: data))
      throw WatchError.refused(words?.error ?? words?.reason ?? "The Mac said no.")
    }
  }

  private func post(_ path: String, _ body: [String: Any] = [:]) async throws {
    let (data, http) = try await call("POST", path, body: body)
    try checked(data, http)
  }

  public func cards(tag: String?) async throws -> Fresh<CardsReply> {
    let (data, http) = try await call("GET", "api/watch/cards", tag: tag)
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
    try await post("api/watch/new", ["text": text])
  }

  public func frame(_ id: String, width: Int, tag: String?) async throws -> Fresh<Data> {
    let (data, http) = try await call("GET", "api/watch/item/\(id)/frame", query: [URLQueryItem(name: "w", value: String(width))], tag: tag)
    if http.statusCode == 304 { return .same }
    try checked(data, http)
    return .new(data, tag: http.value(forHTTPHeaderField: "etag"))
  }

  public func input(_ input: BrowserInput, to id: String) async throws {
    try await post("api/watch/item/\(id)/input", input.json)
  }

  public func note(_ id: String) async throws -> NoteBody {
    let (data, http) = try await call("GET", "api/watch/item/\(id)")
    try checked(data, http)
    return try JSONDecoder().decode(NoteBody.self, from: data)
  }
}
