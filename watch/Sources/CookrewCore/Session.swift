import Foundation
import Security

/** A Mac this watch is paired with: where it is, and the token it gave. */
public struct WatchSession: Equatable, Sendable {
  public let desktop: String
  public let bases: [Base]
  public let token: String

  public init(desktop: String, bases: [Base], token: String) {
    self.desktop = desktop
    self.bases = bases
    self.token = token
  }

  public var urls: [URL] { bases.compactMap { URL(string: $0.url) } }
}

/** An address that stays on the owner's own network or tailnet: the only place plain HTTP may go. */
func isPrivateHost(_ host: String) -> Bool {
  if host.hasSuffix(".local") || host == "localhost" || host.hasPrefix("127.") { return true }
  let parts = host.split(separator: ".").compactMap { Int($0) }
  guard parts.count == 4 else { return false }
  switch (parts[0], parts[1]) {
  case (10, _), (192, 168): return true
  case (172, 16...31): return true
  case (100, 64...127): return true // Tailscale's range, which is encrypted under the HTTP.
  default: return false
  }
}

/** The token never goes in the clear to an address on the open internet. */
func mayCarryToken(_ url: URL) -> Bool {
  url.scheme == "https" || (url.scheme == "http" && isPrivateHost(url.host() ?? ""))
}

/**
 * Every way to the Mac, most private first: a name with a real certificate, then
 * what was typed, then the rest; nothing twice, nothing that would carry the
 * token in the clear past the owner's own network.
 */
public func basesAfterClaim(typed: Base, named: [Base]) -> [Base] {
  var seen = Set<String>()
  let secure = named.filter { $0.url.hasPrefix("https://") }
  let others = named.filter { !$0.url.hasPrefix("https://") }
  return (secure + [typed] + others).filter { base in
    guard let url = URL(string: base.url), mayCarryToken(url) else { return false }
    return seen.insert(base.url).inserted
  }
}

/**
 * Every way to a Mac found through the account. The relay goes last: away from
 * home it is the only road that answers, and at home the cards need not cross
 * cookrew.dev at all.
 */
public func basesAfterJoin(relay: URL, named: [Base]) -> [Base] {
  let usable = named.filter { base in URL(string: base.url).map(mayCarryToken) ?? false }
  let secure = usable.filter { $0.url.hasPrefix("https://") }
  let others = usable.filter { !$0.url.hasPrefix("https://") }
  return secure + others + [Base(kind: "relay", url: relay.absoluteString)]
}

/** What is typed into the address row, as a base URL; a bare IP is the companion's plain port. */
public func baseURL(typed: String) -> URL? {
  let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !text.isEmpty else { return nil }
  let spelled = text.contains("://") ? text : text.contains(":") ? "http://\(text)" : "http://\(text):8639"
  return URL(string: spelled).flatMap { mayCarryToken($0) ? $0 : nil }
}

/** The token in the Keychain; the addresses, which are no secret, beside it. */
public struct SessionVault: Sendable {
  private let service = "dev.cookrew.watch"
  private let meta = "dev.cookrew.watch.session"

  public init() {}

  private func query(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  private func read(_ account: String) -> Data? {
    var found: CFTypeRef?
    var ask = query(account)
    ask[kSecReturnData as String] = true
    guard SecItemCopyMatching(ask as CFDictionary, &found) == errSecSuccess else { return nil }
    return found as? Data
  }

  private func write(_ data: Data, to account: String) {
    // Update first: a failed write must not cost the secret already kept.
    let value = [kSecValueData as String: data]
    if SecItemUpdate(query(account) as CFDictionary, value as CFDictionary) == errSecItemNotFound {
      var add = query(account)
      add[kSecValueData as String] = data
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      SecItemAdd(add as CFDictionary, nil)
    }
  }

  /** This watch's account session, when it has joined one. */
  public func loadAccount() -> WatchAccount? {
    read("account").flatMap { try? JSONDecoder().decode(WatchAccount.self, from: $0) }
  }

  public func saveAccount(_ account: WatchAccount) {
    if let data = try? JSONEncoder().encode(account) { write(data, to: "account") }
  }

  public func clearAccount() {
    SecItemDelete(query("account") as CFDictionary)
  }

  /** Who this watch is, made once and kept through a Forget. */
  public func device() -> WatchDevice {
    if let kept = read("device").flatMap({ try? JSONDecoder().decode(WatchDevice.self, from: $0) }) { return kept }
    return newDevice()
  }

  /** A new identity, for when the account has refused the old one. */
  @discardableResult public func newDevice() -> WatchDevice {
    let made = WatchDevice()
    if let data = try? JSONEncoder().encode(made) { write(data, to: "device") }
    return made
  }

  public func load() -> WatchSession? {
    guard let data = read("token"),
      let token = String(data: data, encoding: .utf8),
      let stored = UserDefaults.standard.data(forKey: meta),
      let saved = try? JSONDecoder().decode(Saved.self, from: stored)
    else { return nil }
    return WatchSession(desktop: saved.desktop, bases: saved.bases, token: token)
  }

  public func save(_ session: WatchSession) {
    write(Data(session.token.utf8), to: "token")
    UserDefaults.standard.set(try? JSONEncoder().encode(Saved(desktop: session.desktop, bases: session.bases)), forKey: meta)
  }

  public func clear() {
    SecItemDelete(query("token") as CFDictionary)
    UserDefaults.standard.removeObject(forKey: meta)
  }

  private struct Saved: Codable {
    let desktop: String
    let bases: [Base]
  }
}
