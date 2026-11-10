import Foundation

public enum RegistryError: Error, Equatable, Sendable {
  /** Wrong and expired are the same 401 from the registry, on purpose. */
  case wrongCode
  case slow
  case unreachable
  /** The account is locked by "not me". */
  case locked
  /** This device id was revoked, or belongs elsewhere. */
  case badDevice
  case signedOut
  /** A Mac said no: its reason word (src/main/watch-pairing.ts). */
  case claim(String)
  /** The account knows this watch as another kind of device. */
  case notWatch
}

public struct JoinReply: Decodable, Equatable, Sendable {
  public let token: String
  public let exp: Double
  public let deviceId: String
  public let username: String

  public init(token: String, exp: Double, deviceId: String, username: String) {
    self.token = token
    self.exp = exp
    self.deviceId = deviceId
    self.username = username
  }
}

public struct Renewed: Decodable, Equatable, Sendable {
  public let token: String
  public let exp: Double

  public init(token: String, exp: Double) {
    self.token = token
    self.exp = exp
  }
}

/** Everything the app asks of cookrew.dev. */
public protocol RegistryAPI: Sendable {
  func join(code: String, device: WatchDevice, name: String) async throws -> JoinReply
  func desktops(token: String) async throws -> [WatchDesktop]
  func claim(relay: URL, code: String, token: String) async throws -> ClaimReply
  func renew(account: WatchAccount, device: WatchDevice) async throws -> Renewed
  func signOut(token: String) async
  /** Every Mac on the account, for the devices stop. */
  func machines(token: String) async throws -> [WatchMachine]
  /** The watch's pass into every machine of the account (POST /v2/me/device-grant/watch). */
  func watchGrant(token: String) async throws -> String
}

public extension RegistryAPI {
  func machines(token: String) async throws -> [WatchMachine] { [] }
  func watchGrant(token: String) async throws -> String { throw RegistryError.unreachable }
}

/** A list where a row that cannot be read is left out, not the whole answer. */
private struct Lossy<Row: Decodable>: Decodable {
  let rows: [Row]

  /** Takes any value at all, so the list moves past it. */
  private struct Skip: Decodable {
    init(from decoder: Decoder) throws {}
  }

  init(from decoder: Decoder) throws {
    var list = try decoder.unkeyedContainer()
    var rows: [Row] = []
    while !list.isAtEnd {
      if let row = try? list.decode(Row.self) { rows.append(row) } else { _ = try list.decode(Skip.self) }
    }
    self.rows = rows
  }
}

/** The header the relay reads the account session from; it reads no other way in, and never forwards it. */
let relaySessionHeader = "x-cookrew-session"

private struct Reason: Decodable {
  let error: String?
  let reason: String?
}

public final class HTTPRegistryAPI: RegistryAPI, @unchecked Sendable {
  private let origin: URL
  private let session: URLSession

  public init(origin: URL, session: URLSession = .shared) {
    self.origin = origin
    self.session = session
  }

  private func fetch(_ request: URLRequest) async throws -> (Data, Int) {
    do {
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse else { throw RegistryError.unreachable }
      return (data, http.statusCode)
    } catch let error as RegistryError {
      throw error
    } catch {
      throw RegistryError.unreachable
    }
  }

  private func post(_ url: URL, _ body: [String: Any]) throws -> URLRequest {
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
    request.httpMethod = "POST"
    request.httpShouldHandleCookies = false
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    return request
  }

  public func join(code: String, device: WatchDevice, name: String) async throws -> JoinReply {
    let (data, status) = try await fetch(try post(origin.appending(path: "v2/join"), ["code": code, "device": device.wire(name: name)]))
    switch status {
    case 201: return try JSONDecoder().decode(JoinReply.self, from: data)
    case 401: throw RegistryError.wrongCode
    case 429: throw RegistryError.slow
    case 403: throw RegistryError.locked
    case 400: throw RegistryError.badDevice
    default: throw RegistryError.unreachable
    }
  }

  public func desktops(token: String) async throws -> [WatchDesktop] {
    struct Me: Decodable {
      let desktops: [WatchDesktop]
    }
    var request = URLRequest(url: origin.appending(path: "v2/me"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
    request.httpShouldHandleCookies = false
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    let (data, status) = try await fetch(request)
    if status == 401 { throw RegistryError.signedOut }
    guard status == 200 else { throw RegistryError.unreachable }
    return try JSONDecoder().decode(Me.self, from: data).desktops
  }

  public func machines(token: String) async throws -> [WatchMachine] {
    var request = URLRequest(url: origin.appending(path: "v2/me/desktops"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
    request.httpShouldHandleCookies = false
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    let (data, status) = try await fetch(request)
    if status == 401 { throw RegistryError.signedOut }
    guard status == 200 else { throw RegistryError.unreachable }
    return try JSONDecoder().decode(Lossy<WatchMachine>.self, from: data).rows
  }

  public func watchGrant(token: String) async throws -> String {
    var request = try post(origin.appending(path: "v2/me/device-grant/watch"), [:])
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    let (data, status) = try await fetch(request)
    struct Pass: Decodable {
      let grant: String
    }
    switch status {
    case 201: return try JSONDecoder().decode(Pass.self, from: data).grant
    case 401: throw RegistryError.signedOut
    case 403 where (try? JSONDecoder().decode(Reason.self, from: data))?.error == "not_watch": throw RegistryError.notWatch
    case 403: throw RegistryError.locked
    default: throw RegistryError.unreachable
    }
  }

  /** One request to a machine's door down the relay, with the session the relay reads. */
  public func door(relay: URL, token: String) -> DoorSend {
    let session = self.session
    return { path, body in
      var request = URLRequest(url: relay.appending(path: path), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
      request.httpMethod = "POST"
      request.httpShouldHandleCookies = false
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.setValue(token, forHTTPHeaderField: relaySessionHeader)
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      do {
        let (data, response) = try await session.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
      } catch {
        throw EnterError.unreachable
      }
    }
  }

  public func claim(relay: URL, code: String, token: String) async throws -> ClaimReply {
    var request = try post(relay.appending(path: "api/watch/claim"), ["code": code])
    request.setValue(token, forHTTPHeaderField: relaySessionHeader)
    let (data, status) = try await fetch(request)
    let reason = try? JSONDecoder().decode(Reason.self, from: data)
    switch status {
    case 200: return try JSONDecoder().decode(ClaimReply.self, from: data)
    // The relay's refusal of the session. A Mac too old to know this route says
    // 401 as well, and that one is only a Mac saying no: the next may say yes.
    case 401 where reason?.error == "unauthenticated": throw RegistryError.signedOut
    case 429: throw RegistryError.slow
    case 502, 503, 504: throw RegistryError.unreachable
    default: throw RegistryError.claim(reason?.reason ?? "no-code")
    }
  }

  public func renew(account: WatchAccount, device: WatchDevice) async throws -> Renewed {
    struct Nonce: Decodable {
      let nonce: String
    }
    var ask = URLRequest(url: origin.appending(path: "v2/sessions/renew-nonce"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
    ask.httpShouldHandleCookies = false
    let (asked, askedStatus) = try await fetch(ask)
    guard askedStatus == 200 else { throw RegistryError.unreachable }
    let nonce = try JSONDecoder().decode(Nonce.self, from: asked).nonce
    let sig = try device.sign(renewMessage(username: account.username, deviceId: account.deviceId, nonce: nonce))
    let (data, status) = try await fetch(try post(origin.appending(path: "v2/sessions/renew"), ["device": account.deviceId, "nonce": nonce, "sig": sig]))
    if status == 401 { throw RegistryError.signedOut }
    guard status == 201 else { throw RegistryError.unreachable }
    return try JSONDecoder().decode(Renewed.self, from: data)
  }

  /** Best effort: the watch forgets its session either way. */
  public func signOut(token: String) async {
    var request = URLRequest(url: origin.appending(path: "v2/sessions/current"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
    request.httpMethod = "DELETE"
    request.httpShouldHandleCookies = false
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    _ = try? await fetch(request)
  }
}
