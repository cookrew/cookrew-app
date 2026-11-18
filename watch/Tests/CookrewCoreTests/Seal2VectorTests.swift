import CryptoKit
import Foundation
import Testing
@testable import CookrewCore

// cookrew-seal/2 in Swift against the same vectors node:crypto wrote
// (scripts/seal-v2-vectors.mjs) and the TypeScript is checked against: read
// from the repo's own fixture, so there is no copy to drift.

private struct Vectors {
  let raw: [String: Any]
  var code: [String: Any] { raw["code"] as! [String: Any] }
  var device: [String: Any] { raw["device"] as! [String: Any] }
  var frames: [[String: Any]] { raw["frames"] as! [[String: Any]] }

  static func load() throws -> Vectors {
    let watch = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let data = try Data(contentsOf: watch.appending(path: "../tests/fixtures/seal-v2-vectors.json"))
    return Vectors(raw: try JSONSerialization.jsonObject(with: data) as! [String: Any])
  }
}

private func hex(_ text: String) -> Data {
  var out = Data()
  var index = text.startIndex
  while index < text.endIndex {
    let next = text.index(index, offsetBy: 2)
    out.append(UInt8(text[index ..< next], radix: 16)!)
    index = next
  }
  return out
}

private func hex(_ data: Data) -> String {
  data.map { String(format: "%02x", $0) }.joined()
}

private func record(_ wire: Data) -> (seq: UInt64, box: Data) {
  let parsed = Seal2.records(wire)!
  return parsed.records[0]
}

@Suite("cookrew-seal/2 in Swift, against node:crypto")
struct Seal2VectorTests {
  @Test("code mode: the same hello, and the same finish from the vectors' accept")
  func codeHandshake() throws {
    let v = try Vectors.load().code
    let shake = try Seal2.CodeHandshake(code: hex(v["code"] as! String), ephemeral: hex(v["initiatorPrivate"] as! String))
    let hello = v["hello"] as! [String: Any]
    #expect(shake.hello.id == hello["id"] as! String)
    #expect(shake.hello.e == hello["e"] as! String)
    #expect(shake.hello.vs == hello["vs"] as! [Int])
    #expect(shake.hello.v == 1)
    let accept = v["accept"] as! [String: Any]
    let done = try shake.finish(acceptV: accept["v"] as! Int, e: accept["e"] as! String, proof: accept["proof"] as! String)
    #expect(done.finish == (v["finish"] as! [String: String]))
    #expect(done.session.id == v["sessionId"] as! String)
  }

  @Test("an answer that does not prove the code is refused")
  func unproven() throws {
    let v = try Vectors.load().code
    let shake = try Seal2.CodeHandshake(code: hex(v["code"] as! String), ephemeral: hex(v["initiatorPrivate"] as! String))
    let accept = v["accept"] as! [String: Any]
    let wrong = String((accept["proof"] as! String).reversed())
    #expect(throws: Seal2.Failure.unproven) { try shake.finish(acceptV: 2, e: accept["e"] as! String, proof: wrong) }
    #expect(throws: Seal2.Failure.badAnswer) { try shake.finish(acceptV: 1, e: accept["e"] as! String, proof: accept["proof"] as! String) }
  }

  @Test("epoch keys walk the same way")
  func epochs() throws {
    let v = try Vectors.load().code
    var secret = hex(v["secretToResponder"] as! String)
    for epoch in v["epochs"] as! [[String: Any]] {
      #expect(hex(secret) == epoch["secret"] as! String)
      let (key, iv) = Seal2.epochKey(secret)
      #expect(hex(key.withUnsafeBytes { Data($0) }) == epoch["key"] as! String)
      #expect(hex(iv) == epoch["iv"] as! String)
      secret = Seal2.epochSecret(secret, epoch: 1)
    }
  }

  @Test("records open both ways across epochs, and seal to the same bytes")
  func records() throws {
    let v = try Vectors.load().code
    let sessionId = v["sessionId"] as! String
    let toResponder = hex(v["secretToResponder"] as! String)
    let toInitiator = hex(v["secretToInitiator"] as! String)
    let phone = Seal2.Session(id: sessionId, send: toResponder, open: toInitiator, sends: .toResponder)
    let mac = Seal2.Session(id: sessionId, send: toInitiator, open: toResponder, sends: .toInitiator)
    for item in v["records"] as! [[String: Any]] {
      let a = record(hex(item["toResponder"] as! String))
      let b = record(hex(item["toInitiator"] as! String))
      #expect(a.seq == UInt64(item["seq"] as! Int))
      #expect(mac.open(seq: a.seq, box: a.box).map(hex) == item["plain"] as? String)
      #expect(phone.open(seq: b.seq, box: b.box).map(hex) == item["plain"] as? String)
    }
    let fresh = Seal2.Session(id: sessionId, send: toResponder, open: toInitiator, sends: .toResponder)
    let first = (v["records"] as! [[String: Any]])[0]
    let sealed = try fresh.seal(hex(first["plain"] as! String))
    #expect(hex(Seal2.wire(seq: sealed.seq, box: sealed.box)) == first["toResponder"] as! String)
  }

  @Test("tamper, the wrong direction and a moved number never open")
  func failClosed() throws {
    let v = try Vectors.load().code
    let sessionId = v["sessionId"] as! String
    let mac = Seal2.Session(id: sessionId, send: hex(v["secretToInitiator"] as! String), open: hex(v["secretToResponder"] as! String), sends: .toInitiator)
    let phone = Seal2.Session(id: sessionId, send: hex(v["secretToResponder"] as! String), open: hex(v["secretToInitiator"] as! String), sends: .toResponder)
    let good = record(hex((v["records"] as! [[String: Any]])[1]["toResponder"] as! String))
    var flipped = good.box
    flipped[flipped.startIndex] ^= 1
    #expect(mac.open(seq: good.seq, box: flipped) == nil)
    #expect(mac.open(seq: good.seq + 1, box: good.box) == nil)
    #expect(phone.open(seq: good.seq, box: good.box) == nil)
    #expect(mac.open(seq: good.seq, box: good.box) != nil)
  }

  @Test("frames encode and decode to the vectors")
  func frames() throws {
    for frame in try Vectors.load().frames {
      let wire = hex(frame["bytes"] as! String)
      let decoded = try #require(Seal2.decode(wire), "\(frame["name"] as! String)")
      let order = [":method", ":path", "content-type"]
      #expect(hex(Seal2.encode(decoded, fieldOrder: order)) == frame["bytes"] as! String, "\(frame["name"] as! String)")
    }
    #expect(Seal2.decode(Data([6, 0, 0, 0, 1] + [UInt8](repeating: 0, count: 8))) == nil)
    #expect(Seal2.decode(Data([3, 0, 0, 0, 0])) == nil)
    #expect(Seal2.decode(Data([42, 0, 0, 0, 1])) == nil)
  }

  @Test("device mode: the Ed25519 signatures in the vectors verify with CryptoKit")
  func deviceSignatures() throws {
    let v = try Vectors.load().device
    let transcript = hex(v["transcript"] as! String)
    let signed = { (who: String) in Data("\(Seal2.label) \(who)\n\(base64urlEncoded(transcript))".utf8) }
    let responderKey = try Curve25519.Signing.PublicKey(rawRepresentation: base64urlDecoded((v["responderJwk"] as! [String: String])["x"]!))
    let initiatorKey = try Curve25519.Signing.PublicKey(rawRepresentation: base64urlDecoded((v["initiatorJwk"] as! [String: String])["x"]!))
    let accept = v["accept"] as! [String: Any]
    let finish = v["finish"] as! [String: String]
    #expect(responderKey.isValidSignature(base64urlDecoded(accept["sig"] as! String), for: signed("responder")))
    #expect(initiatorKey.isValidSignature(base64urlDecoded(finish["sig"]!), for: signed("initiator")))
    #expect(!initiatorKey.isValidSignature(base64urlDecoded(finish["sig"]!), for: signed("responder")))
  }

  @Test("a number far past the window is not opened, and costs no long key walk")
  func farAhead() throws {
    let v = try Vectors.load().code
    let mac = Seal2.Session(id: v["sessionId"] as! String, send: hex(v["secretToInitiator"] as! String), open: hex(v["secretToResponder"] as! String), sends: .toInitiator)
    let started = Date()
    #expect(mac.open(seq: (1 << 48) - 1, box: Data(repeating: 0, count: 32)) == nil)
    #expect(mac.open(seq: 5 * Seal2.epochRecords, box: Data(repeating: 0, count: 32)) == nil)
    #expect(Date().timeIntervalSince(started) < 1)
  }

  @Test("an empty DATA frame is not a frame")
  func emptyData() {
    #expect(Seal2.decode(Data([3, 0, 0, 0, 1])) == nil)
  }

  @Test("device mode as the initiator: the same hello, and a finish the vectors' Mac accepts")
  func deviceInitiator() throws {
    let v = try Vectors.load().device
    let signing = try Curve25519.Signing.PrivateKey(rawRepresentation: hex(v["initiatorDevicePrivate"] as! String))
    let macX = (v["responderJwk"] as! [String: String])["x"]!
    let shake = try Seal2.DeviceHandshake(deviceId: v["from"] as! String, signing: signing, to: v["to"] as! String, macX: macX, ephemeral: hex(v["initiatorPrivate"] as! String))
    let hello = v["hello"] as! [String: Any]
    #expect(shake.hello["e"] as? String == hello["e"] as? String)
    #expect(shake.hello["from"] as? String == hello["from"] as? String)
    #expect((shake.hello["jwk"] as? [String: String]) == (hello["jwk"] as? [String: String]))
    let done = try shake.finish(accept: v["accept"] as! [String: Any])
    let finish = v["finish"] as! [String: String]
    #expect(done.finish["proof"] == finish["proof"])
    #expect(done.session.id == v["sessionId"] as! String)
    let transcript = hex(v["transcript"] as! String)
    let initiatorKey = try Curve25519.Signing.PublicKey(rawRepresentation: base64urlDecoded((v["initiatorJwk"] as! [String: String])["x"]!))
    #expect(initiatorKey.isValidSignature(base64urlDecoded(done.finish["sig"]!), for: Data("\(Seal2.label) initiator\n\(base64urlEncoded(transcript))".utf8)))
  }

  @Test("device mode refuses an answer from any key but the Mac's pinned at the claim")
  func deviceWrongMac() throws {
    let v = try Vectors.load().device
    let signing = try Curve25519.Signing.PrivateKey(rawRepresentation: hex(v["initiatorDevicePrivate"] as! String))
    let shake = try Seal2.DeviceHandshake(deviceId: v["from"] as! String, signing: signing, to: v["to"] as! String, macX: base64urlEncoded(Data(repeating: 7, count: 32)), ephemeral: hex(v["initiatorPrivate"] as! String))
    #expect(throws: Seal2.Failure.unproven) { try shake.finish(accept: v["accept"] as! [String: Any]) }
  }

  @Test("ids and words: a key's device id, and the six words both screens show")
  func idsAndWords() throws {
    let v = try Vectors.load().device
    let a = (v["initiatorJwk"] as! [String: String])["x"]!
    let b = (v["responderJwk"] as! [String: String])["x"]!
    #expect(Seal2.deviceId(x: a) == v["from"] as! String)
    #expect(Seal2.deviceId(x: b) == v["to"] as! String)
    #expect(Seal2.keyWords(a, b) == ["pole", "oyster", "try", "split", "air", "prize"])
    #expect(Seal2.keyWords(b, a) == Seal2.keyWords(a, b))
    #expect(FingerprintWords.all.count == 2048)
    let list = Data((FingerprintWords.all.joined(separator: "\n") + "\n").utf8)
    #expect(Data(SHA256.hash(data: list)).map { String(format: "%02x", $0) }.joined() == "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda")
  }
}
