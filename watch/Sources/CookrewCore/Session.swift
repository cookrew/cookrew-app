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

/** The address the owner typed first, then every other way the Mac named, without repeats. */
public func basesAfterClaim(typed: Base, named: [Base]) -> [Base] {
  var seen = Set<String>()
  return ([typed] + named).filter { seen.insert($0.url).inserted }
}

/** What is typed into the address row, as a base URL; a bare IP is the companion's plain port. */
public func baseURL(typed: String) -> URL? {
  let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !text.isEmpty else { return nil }
  if text.contains("://") { return URL(string: text) }
  return URL(string: text.contains(":") ? "http://\(text)" : "http://\(text):8639")
}

/** The token in the Keychain; the addresses, which are no secret, beside it. */
public struct SessionVault: Sendable {
  private let service = "dev.cookrew.watch"
  private let account = "token"
  private let meta = "dev.cookrew.watch.session"

  public init() {}

  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  public func load() -> WatchSession? {
    var found: CFTypeRef?
    var ask = query
    ask[kSecReturnData as String] = true
    guard SecItemCopyMatching(ask as CFDictionary, &found) == errSecSuccess,
      let data = found as? Data,
      let token = String(data: data, encoding: .utf8),
      let stored = UserDefaults.standard.data(forKey: meta),
      let saved = try? JSONDecoder().decode(Saved.self, from: stored)
    else { return nil }
    return WatchSession(desktop: saved.desktop, bases: saved.bases, token: token)
  }

  public func save(_ session: WatchSession) {
    clear()
    var add = query
    add[kSecValueData as String] = Data(session.token.utf8)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(add as CFDictionary, nil)
    UserDefaults.standard.set(try? JSONEncoder().encode(Saved(desktop: session.desktop, bases: session.bases)), forKey: meta)
  }

  public func clear() {
    SecItemDelete(query as CFDictionary)
    UserDefaults.standard.removeObject(forKey: meta)
  }

  private struct Saved: Codable {
    let desktop: String
    let bases: [Base]
  }
}
