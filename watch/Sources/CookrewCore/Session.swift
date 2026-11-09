import CryptoKit
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

/** Which machine a session is for: its relay id, or, paired by six digits, its name. */
public func sessionKey(_ session: WatchSession) -> String {
  pairedMachineId(session.bases) ?? "here:\(session.desktop)"
}

/**
 * THE MACHINES THIS WATCH HOLDS A KEY FOR, and the one it is in. A code from
 * another machine adds it: the watch used to keep one, so pairing a second one
 * gave up the first. The tokens are not here; the vault keeps each in the
 * Keychain under its key.
 */
public struct SessionShelf: Codable, Equatable, Sendable {
  public struct Entry: Codable, Equatable, Sendable {
    public let key: String
    public let desktop: String
    public let bases: [Base]
  }

  public private(set) var entries: [Entry] = []
  public private(set) var active: String?

  public init() {}

  public var keys: [String] { entries.map(\.key) }

  /** A session paired just now: added, or in its own place if the machine was held, and gone into. */
  @discardableResult public mutating func put(_ session: WatchSession) -> String {
    let key = sessionKey(session)
    let entry = Entry(key: key, desktop: session.desktop, bases: session.bases)
    if let at = entries.firstIndex(where: { $0.key == key }) { entries[at] = entry } else { entries.append(entry) }
    active = key
    return key
  }

  public mutating func activate(_ key: String) -> Bool {
    guard entries.contains(where: { $0.key == key }) else { return false }
    active = key
    return true
  }

  /** Forgotten: if it was the one in use, the next held machine is. */
  public mutating func remove(_ key: String) {
    entries.removeAll { $0.key == key }
    if active == key || !entries.contains(where: { $0.key == active }) { active = entries.first?.key }
  }

  public func entry(_ key: String?) -> Entry? { entries.first { $0.key == key } }
}

/** An address that stays on the owner's own network or tailnet: the only place plain HTTP may go. */
func isPrivateHost(_ host: String) -> Bool {
  if host.hasSuffix(".local") || host == "localhost" { return true }
  // Four numbers and nothing else: 10.1.2.3.evil.com is a public name.
  let labels = host.split(separator: ".", omittingEmptySubsequences: false)
  let parts = labels.compactMap { Int($0) }
  guard labels.count == 4, parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }
  switch (parts[0], parts[1]) {
  case (10, _), (127, _), (192, 168): return true
  case (172, 16...31): return true
  case (100, 64...127): return true // Tailscale's range, which is encrypted under the HTTP.
  default: return false
  }
}

/** What a Mac signs to prove it holds this token (src/main/watch-pairing.ts · watchProof). */
public func helloProof(token: String, nonce: String) -> String {
  let code = HMAC<SHA256>.authenticationCode(for: Data("cookrew-watch-hello/1 \(nonce)".utf8), using: SymmetricKey(data: Data(token.utf8)))
  return base64urlEncoded(Data(code))
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

  private let shelfKey = "dev.cookrew.watch.shelf"

  private func token(_ key: String) -> String? {
    read("token:\(key)").flatMap { String(data: $0, encoding: .utf8) }
  }

  private func store(_ shelf: SessionShelf) {
    UserDefaults.standard.set(try? JSONEncoder().encode(shelf), forKey: shelfKey)
  }

  /** The machines held. A watch from before there could be several has its one carried over. */
  public func shelf() -> SessionShelf {
    if let data = UserDefaults.standard.data(forKey: shelfKey), let shelf = try? JSONDecoder().decode(SessionShelf.self, from: data) { return shelf }
    var shelf = SessionShelf()
    if let data = read("token"), let token = String(data: data, encoding: .utf8),
      let stored = UserDefaults.standard.data(forKey: meta), let saved = try? JSONDecoder().decode(Saved.self, from: stored)
    {
      let session = WatchSession(desktop: saved.desktop, bases: saved.bases, token: token)
      write(Data(token.utf8), to: "token:\(shelf.put(session))")
      store(shelf)
      SecItemDelete(query("token") as CFDictionary)
      UserDefaults.standard.removeObject(forKey: meta)
    }
    return shelf
  }

  public func session(_ key: String?) -> WatchSession? {
    guard let entry = shelf().entry(key), let token = token(entry.key) else { return nil }
    return WatchSession(desktop: entry.desktop, bases: entry.bases, token: token)
  }

  /** The machine the watch is in. */
  public func load() -> WatchSession? {
    session(shelf().active)
  }

  /** A machine paired just now: added beside the others, and gone into. */
  public func save(_ session: WatchSession) {
    var shelf = shelf()
    let key = shelf.put(session)
    write(Data(session.token.utf8), to: "token:\(key)")
    store(shelf)
  }

  /** Into another held machine. */
  public func activate(_ key: String) -> WatchSession? {
    var shelf = shelf()
    guard shelf.activate(key) else { return nil }
    store(shelf)
    return session(key)
  }

  /** One machine let go of; the next held one is in use, if there is one. */
  public func forget(_ key: String) {
    var shelf = shelf()
    shelf.remove(key)
    SecItemDelete(query("token:\(key)") as CFDictionary)
    store(shelf)
  }

  /** Every machine let go of. */
  public func clear() {
    for key in shelf().keys { SecItemDelete(query("token:\(key)") as CFDictionary) }
    UserDefaults.standard.removeObject(forKey: shelfKey)
    SecItemDelete(query("token") as CFDictionary)
    UserDefaults.standard.removeObject(forKey: meta)
  }

  private struct Saved: Codable {
    let desktop: String
    let bases: [Base]
  }
}
