import Foundation

// A WATCH PAIRS ONCE (owner, 2026-11-09). With its account's watch pass
// (registry v2-device-grant.ts · issueWatchGrant) it enters any machine of the
// account at that machine's door (src/main/account-pair.ts): a challenge, its
// own key's signature over it, and the machine's watch token. No code.

/** The label every signature at the door carries (src/shared/account-pair.ts · ACCOUNT_PAIR_CONTEXT). */
public let pairContext = "cookrew-pair/2"

/** Exactly the bytes the machine checks (src/shared/account-pair.ts · pairTranscript). */
public func pairTranscript(desktopId: String, challengeId: String, nonce: String, deviceId: String) -> String {
  "\(pairContext) \(desktopId) \(challengeId) \(nonce) \(deviceId)"
}

public enum EnterError: Error, Equatable, Sendable {
  /** The machine has no door for a watch's pass (older than it, or no account): a code is the way in. */
  case noDoor
  /** The machine said no, in its words. */
  case refused(String)
  /** cookrew.dev knows this watch as another kind of device: one more code makes it a watch. */
  case notWatch
  case unreachable
  /** The machine answered for a different machine than the one asked: nothing is signed or kept. */
  case wrongMachine
}

/** One request to the machine's door: a path under its relay road and a JSON body; its status and body back. */
public typealias DoorSend = @Sendable (_ path: String, _ body: [String: Any]) async throws -> (Int, Data)

private func json(_ data: Data) -> [String: Any] {
  (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
}

private func refusal(_ status: Int, _ data: Data) -> EnterError {
  if status == 404 { return .noDoor }
  let body = json(data)
  return .refused((body["error"] as? String) ?? "That machine said no.")
}

/**
 * Into one machine with the watch's pass: its watch token, or why not. The
 * transcript names the machine, so the watch signs only for the one it meant
 * (`machine`, its account id): a machine passing on another's challenge would
 * otherwise get that one's watch token with this watch's signature.
 */
public func enterMachine(device: WatchDevice, machine: String, grant: String, name: String = "Apple Watch", send: DoorSend) async throws -> String {
  let meant = machine.lowercased()
  let asking: [String: Any] = ["deviceId": device.id, "jwk": device.wire(name: name)["jwk"] ?? [:], "name": name]
  let (status, data) = try await send("api/pair/begin", ["device": asking, "grant": grant])
  guard status == 200 else { throw refusal(status, data) }
  let challenge = json(data)
  guard let challengeId = challenge["challengeId"] as? String, let nonce = challenge["nonce"] as? String, let desktopId = challenge["desktopId"] as? String else {
    throw EnterError.noDoor
  }
  guard desktopId.lowercased() == meant else { throw EnterError.wrongMachine }
  let sig = try device.sign(pairTranscript(desktopId: desktopId, challengeId: challengeId, nonce: nonce, deviceId: device.id))
  let (done, answer) = try await send("api/pair", ["device": asking, "grant": grant, "challengeId": challengeId, "sig": sig])
  guard done == 200 else { throw refusal(done, answer) }
  let admitted = json(answer)
  // Only a watch's token: a machine that answered with a device's is not one this watch should hold.
  guard admitted["ok"] as? Bool == true, admitted["scope"] as? String == "watch", let token = admitted["token"] as? String, !token.isEmpty else {
    throw EnterError.noDoor
  }
  guard (admitted["desktopId"] as? String)?.lowercased() == meant else { throw EnterError.wrongMachine }
  return token
}
