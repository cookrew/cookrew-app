import CookrewCore
import Foundation

// The watch's sealed client against a real Mac terminus: scripts/seal-v2-swift-probe.mjs
// starts the Mac end behind the real registry and runs this with its address.
//   seal2-probe <relay prefix> <session header> <session value> <connect code, base64url>

let args = CommandLine.arguments
guard args.count == 5 else {
  print("usage: seal2-probe <prefix> <header> <value> <code>")
  exit(2)
}
let prefix = args[1]
let route = Seal2Route(url: { URL(string: "\(prefix)\($0)")! }, headers: [args[2]: args[3]])
var results: [String: Any] = [:]
do {
  let client = try await Seal2Client.open(route: route, code: base64urlDecoded(args[4]))
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
