import CryptoKit
import Foundation

// THIS WATCH IN THE ACCOUNT. A watch away from home reaches its Mac through the
// relay, and the relay lets in only a signed-in device, so the watch is one: a
// key of its own (the registry's Ed25519 device key), and a thirty-day session
// that key can renew. The session opens the relay; the Mac still wants its own
// token, so a stolen session alone reads nothing.

public func base64urlEncoded(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

public func base64urlDecoded(_ text: String) -> Data {
  var plain = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  plain += String(repeating: "=", count: (4 - plain.count % 4) % 4)
  return Data(base64Encoded: plain) ?? Data()
}

/**
 * Who this watch is. Outlives a Forget: joining again under the same id is the
 * same row on the account, not one more.
 */
public struct WatchDevice: Codable, Equatable, Sendable {
  public let id: String
  let seed: Data

  public init() {
    id = UUID().uuidString.lowercased()
    seed = Curve25519.Signing.PrivateKey().rawRepresentation
  }

  private func key() throws -> Curve25519.Signing.PrivateKey {
    try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
  }

  /** A watch, as the account knows it: the one kind that enters every machine on its pairing alone. */
  public func wire(name: String) -> [String: Any] {
    let publicKey = (try? key().publicKey.rawRepresentation) ?? Data()
    return ["id": id, "kind": "watch", "name": name, "jwk": ["kty": "OKP", "crv": "Ed25519", "x": base64urlEncoded(publicKey)]]
  }

  public func sign(_ message: String) throws -> String {
    base64urlEncoded(try key().signature(for: Data(message.utf8)))
  }
}

/** A session on the account. `exp` is the registry's: milliseconds. */
public struct WatchAccount: Codable, Equatable, Sendable {
  public let registry: String
  public let username: String
  public let deviceId: String
  public let token: String
  public let exp: Double

  public init(registry: String, username: String, deviceId: String, token: String, exp: Double) {
    self.registry = registry
    self.username = username
    self.deviceId = deviceId
    self.token = token
    self.exp = exp
  }

  func renewed(_ next: Renewed) -> WatchAccount {
    WatchAccount(registry: registry, username: username, deviceId: deviceId, token: next.token, exp: next.exp)
  }
}

public struct WatchDesktop: Decodable, Equatable, Sendable {
  public let deviceId: String
  public let name: String

  public init(deviceId: String, name: String) {
    self.deviceId = deviceId
    self.name = name
  }
}

/** The registry's own message, byte for byte (src/shared/session-renew.ts). */
public func renewMessage(username: String, deviceId: String, nonce: String) -> String {
  "cookrew-renew/1 \(username) \(deviceId) \(nonce)"
}

/** Renew a week out, as a Mac does (src/shared/session-renew.ts). */
let renewAheadMs: Double = 7 * 24 * 60 * 60 * 1000

func renewDue(exp: Double, now: Double) -> Bool {
  exp > now && exp - now <= renewAheadMs
}

/** "K7QM-2XPD" from whatever was typed. */
public func dashedCode(_ typed: String) -> String {
  let plain = typed.uppercased().filter { $0.isLetter || $0.isNumber }
  return "\(plain.prefix(4))-\(plain.dropFirst(4))"
}

/**
 Where a Mac answers on the relay: the one path every client uses. The account
 is named by the session sent with each call (`relaySessionHeader`), never by
 the address.
 */
public func relayBase(registry: String, desktop: String) -> URL? {
  URL(string: "\(registry)/api/m/\(desktop.lowercased())")
}

/** Milliseconds, as the registry counts. */
public func nowMs() -> Double {
  Date().timeIntervalSince1970 * 1000
}
