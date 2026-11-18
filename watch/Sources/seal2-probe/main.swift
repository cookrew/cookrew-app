import CookrewCore
import CryptoKit
import Foundation

// The watch's sealed client against a real Mac terminus: scripts/seal-v2-swift-probe.mjs
// starts the Mac end behind the real registry and runs this with its address.
//   seal2-probe <relay prefix> <session header> <session value> <connect code, base64url>

let args = CommandLine.arguments
// code mode:   seal2-probe code <prefix> <header> <value> <connect code>
// device mode: seal2-probe device <prefix> <header> <value> <mac id> <mac x> <watch id> <watch seed hex>
guard args.count >= 6 else {
  print("usage: seal2-probe code|device <prefix> <header> <value> ...")
  exit(2)
}
let prefix = args[2]
let route = Seal2Route(url: { URL(string: "\(prefix)\($0)")! }, headers: [args[3]: args[4]])
/** The relay session, fixed: a probe's account does not renew. */
struct FixedPass: RelayPass {
  let host: String
  let port: Int?
  let session: String
  func token() async -> String { session }
  func newer(than token: String) async -> String? { nil }
}

// app mode: the watch app's own call path (HTTPWatchAPI with a WatchSealer) to the relay road.
//   seal2-probe app <prefix> <header> <value> <mac id> <mac x> <watch id> <watch seed hex>
if args[1] == "app" {
  let seed = Data(stride(from: 0, to: args[8].count, by: 2).map { UInt8(args[8].dropFirst($0).prefix(2), radix: 16)! })
  let base = URL(string: prefix)!
  let pass = FixedPass(host: base.host() ?? "", port: base.port, session: args[4])
  let peer = SealPeer(deviceId: args[5], x: args[6], words: Seal2.keyWords(args[6], args[6], nonce: Data(count: 16)))
  let sealer = WatchSealer(peer: peer, device: WatchDevice(id: args[7], seed: seed), relay: pass, pinned: false)
  let api = HTTPWatchAPI(bases: [base], token: "watch-token", relay: pass, sealer: sealer)
  var out: [String: Any] = [:]
  do {
    try await api.send("hello from the wrist", to: "t1")
    out["sent"] = true
  } catch {
    out["sent"] = String(describing: error)
  }
  out["pinned"] = await sealer.isPinned
  await sealer.close()
  print(String(decoding: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), as: UTF8.self))
  exit(0)
}

var results: [String: Any] = [:]
do {
  let client: Seal2Client
  if args[1] == "device" {
    let seed = Data(stride(from: 0, to: args[8].count, by: 2).map { UInt8(args[8].dropFirst($0).prefix(2), radix: 16)! })
    let shake = try Seal2.DeviceHandshake(deviceId: args[7], signing: try Curve25519.Signing.PrivateKey(rawRepresentation: seed), to: args[5], macX: args[6])
    results["words"] = Seal2.keyWords(base64urlEncoded(try Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey.rawRepresentation), args[6], nonce: Data(count: 16))
    client = try await Seal2Client.open(route: route, device: shake)
  } else {
    client = try await Seal2Client.open(route: route, code: base64urlDecoded(args[5]))
  }
  let one = try await client.request(method: "GET", path: "/api/swift-one", headers: ["authorization": "Bearer swift-token"])
  results["one"] = "\(one.status) \(String(decoding: one.body, as: UTF8.self))"
  let posted = try await client.request(method: "POST", path: "/api/swift-post", headers: ["content-type": "text/plain"], body: Data(repeating: 0x61, count: 3_000_000))
  results["post"] = "\(posted.status) \(String(decoding: posted.body, as: UTF8.self))"
  let big = try await client.request(method: "GET", path: "/api/picture")
  results["picture"] = big.body.count
  results["pictureIntact"] = big.body.enumerated().allSatisfy { $0.element == UInt8($0.offset % 251) }
  let many = try await withThrowingTaskGroup(of: Int.self) { group in
    for n in 0 ..< 90 { group.addTask { try await client.request(method: "GET", path: "/api/n/\(n)").status } }
    return try await group.reduce(0) { $0 + ($1 == 200 ? 1 : 0) }
  }
  results["many"] = many
  // A header name the Mac could not read is refused here, and the session lives on.
  do {
    _ = try await client.request(method: "GET", path: "/api/x", headers: ["bad name": "v"])
    results["badHeader"] = "sent"
  } catch Seal2ClientError.badRequest {
    results["badHeader"] = "refused"
  }
  results["afterBad"] = try await client.request(method: "GET", path: "/api/after").status
  await client.close()
  results["ok"] = true
} catch {
  results["ok"] = false
  results["error"] = String(describing: error)
}
print(String(decoding: try JSONSerialization.data(withJSONObject: results, options: [.sortedKeys]), as: UTF8.self))
