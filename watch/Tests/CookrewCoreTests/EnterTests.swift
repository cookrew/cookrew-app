import CryptoKit
import Foundation
import Testing
@testable import CookrewCore

/** A machine's door as the test sets it: each answer in turn, each request kept. */
private final class Door: @unchecked Sendable {
  var answers: [(Int, [String: Any])]
  var asked: [(path: String, body: [String: Any])] = []
  init(_ answers: [(Int, [String: Any])]) { self.answers = answers }
  func send(_ path: String, _ body: [String: Any]) async throws -> (Int, Data) {
    asked.append((path, body))
    let (status, json) = answers.removeFirst()
    return (status, try JSONSerialization.data(withJSONObject: json))
  }
}

@Suite("a watch entering a machine with its pass")
struct EnterTests {
  @Test("signs the same bytes the machine checks (src/shared/account-pair.ts · pairTranscript)")
  func transcript() {
    #expect(pairTranscript(desktopId: "d-1", challengeId: "c-2", nonce: "n-3", deviceId: "w-4") == "cookrew-pair/2 d-1 c-2 n-3 w-4")
  }

  @Test("asks for a challenge with its pass, signs it with its own key, and is handed the machine's watch token")
  func enters() async throws {
    let device = WatchDevice()
    let door = Door([
      (200, ["challengeId": "c1", "nonce": "n1", "desktopId": "d1", "expiresAt": 1]),
      (200, ["ok": true, "outcome": "admitted", "token": "watch-token-xyz", "scope": "watch", "deviceId": device.id, "desktopId": "d1", "until": 0])
    ])
    let token = try await enterMachine(device: device, machine: "d1", grant: "G", send: door.send)
    #expect(token == "watch-token-xyz")
    #expect(door.asked.map(\.path) == ["api/pair/begin", "api/pair"])
    #expect(door.asked[0].body["grant"] as? String == "G")
    let finish = door.asked[1].body
    #expect(finish["challengeId"] as? String == "c1")
    let sig = base64urlDecoded(finish["sig"] as? String ?? "")
    let key = try Curve25519.Signing.PrivateKey(rawRepresentation: device.seed).publicKey
    #expect(key.isValidSignature(sig, for: Data(pairTranscript(desktopId: "d1", challengeId: "c1", nonce: "n1", deviceId: device.id).utf8)))
  }

  @Test("a machine with no door for it asks for a code instead; a refusal says the machine's words")
  func refusals() async {
    let device = WatchDevice()
    await #expect(throws: EnterError.noDoor) { try await enterMachine(device: device, machine: "d1", grant: "G", send: Door([(404, ["error": "no"])]).send) }
    await #expect(throws: EnterError.refused("That pass from cookrew.dev is no longer good.")) {
      try await enterMachine(device: device, machine: "d1", grant: "G", send: Door([(401, ["ok": false, "outcome": "regrant", "error": "That pass from cookrew.dev is no longer good."])]).send)
    }
    // An admission that is not a watch's token is not taken: the watch never holds a device's.
    await #expect(throws: EnterError.noDoor) {
      try await enterMachine(device: device, machine: "d1", grant: "G", send: Door([
        (200, ["challengeId": "c1", "nonce": "n1", "desktopId": "d1", "expiresAt": 1]),
        (200, ["ok": true, "outcome": "admitted", "token": "full-device-token", "deviceId": device.id, "desktopId": "d1", "until": 9])
      ]).send)
    }
  }

  @Test("signs for the machine it meant to enter and no other: a machine passing on another's challenge gets nothing")
  func boundToTheMachine() async {
    let device = WatchDevice()
    let relayed = Door([(200, ["challengeId": "c1", "nonce": "n1", "desktopId": "OTHER-MAC", "expiresAt": 1])])
    await #expect(throws: EnterError.wrongMachine) { try await enterMachine(device: device, machine: "d1", grant: "G", send: relayed.send) }
    #expect(relayed.asked.count == 1)
    let swapped = Door([
      (200, ["challengeId": "c1", "nonce": "n1", "desktopId": "D1", "expiresAt": 1]),
      (200, ["ok": true, "outcome": "admitted", "token": "t", "scope": "watch", "deviceId": device.id, "desktopId": "other", "until": 0])
    ])
    await #expect(throws: EnterError.wrongMachine) { try await enterMachine(device: device, machine: "d1", grant: "G", send: swapped.send) }
  }

  @Test("a watch joins the account as a watch")
  func kind() {
    #expect(WatchDevice().wire(name: "Apple Watch")["kind"] as? String == "watch")
  }
}
