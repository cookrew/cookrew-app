import CryptoKit
import Foundation
import Testing
@testable import CookrewCore

private let nonce = Data((0 ..< 16).map { UInt8($0) })
private func macKey() -> (id: String, x: String) {
  let x = base64urlEncoded(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation)
  return (Seal2.deviceId(x: x), x)
}
private func answer(id: String, x: String, nonce: Data = nonce, words: [String] = ["a", "b", "c", "d", "e", "f"]) -> Data {
  let seal: [String: Any] = ["deviceId": id, "jwk": ["kty": "OKP", "crv": "Ed25519", "x": x], "nonce": base64urlEncoded(nonce), "words": words]
  return try! JSONSerialization.data(withJSONObject: ["ok": true, "token": "t", "desktop": "Mac", "bases": [], "seal": seal])
}

@Suite("the watch's sealed road: what the claim brings and what is kept")
struct WatchSealTests {
  @Test("an offer is read only when the Mac's id is its key's own and the nonce is whole")
  func claimOffer() throws {
    let mac = macKey()
    let read = try JSONDecoder().decode(ClaimReply.self, from: answer(id: mac.id.uppercased(), x: mac.x))
    #expect(read.sealOffer == SealOffer(deviceId: mac.id, x: mac.x, nonce: nonce))
    #expect(try JSONDecoder().decode(ClaimReply.self, from: answer(id: macKey().id, x: mac.x)).sealOffer == nil)
    #expect(try JSONDecoder().decode(ClaimReply.self, from: answer(id: mac.id, x: mac.x, nonce: Data(count: 4))).sealOffer == nil)
    #expect(try JSONDecoder().decode(ClaimReply.self, from: Data(#"{"token":"t","desktop":"Mac","bases":[]}"#.utf8)).sealOffer == nil)
    #expect(try JSONDecoder().decode(ClaimReply.self, from: Data(#"{"token":"t","desktop":"Mac","bases":[],"seal":{"deviceId":1}}"#.utf8)).sealOffer == nil)
  }

  @Test("the words are the watch's own: a relay that swaps the Mac's key and sends the Mac's words gets other words on the watch")
  func ownWords() throws {
    let watch = WatchDevice()
    let mac = macKey()
    let relay = macKey()
    let macWords = Seal2.keyWords(watch.publicX, mac.x, nonce: nonce)
    // The relay's answer: its own key, and the very words the Mac shows.
    let forged = try JSONDecoder().decode(ClaimReply.self, from: answer(id: relay.id, x: relay.x, words: macWords)).sealOffer
    #expect(forged?.words(ownX: watch.publicX) != macWords)
    let real = try JSONDecoder().decode(ClaimReply.self, from: answer(id: mac.id, x: mac.x, words: ["ignored", "b", "c", "d", "e", "f"])).sealOffer
    #expect(real?.words(ownX: watch.publicX) == macWords)
  }

  @Test("a watch's claim carries its account id and public key")
  func claimFields() throws {
    let device = WatchDevice()
    let fields = device.sealFields
    #expect(fields["deviceId"] as? String == device.id)
    let jwk = fields["jwk"] as? [String: String]
    #expect(jwk?["crv"] == "Ed25519")
    #expect(jwk?["x"] == device.publicX)
  }

  @Test("pinned stays pinned through a pairing that matched no seal; a newly matched other key starts over")
  func pinOnShelf() {
    let relay = Base(kind: "relay", url: "https://x/api/m/mac")
    let peer = SealPeer(deviceId: "mac", x: "k1", words: ["a", "b", "c", "d", "e", "f"])
    var shelf = SessionShelf()
    let key = shelf.put(WatchSession(desktop: "Mac", bases: [relay], token: "t", seal: peer))
    shelf.markSealed(key)
    shelf.put(WatchSession(desktop: "Mac", bases: [relay], token: "t2"))
    #expect(shelf.entry(key)?.sealPinned == true)
    #expect(shelf.entry(key)?.seal == peer)
    shelf.put(WatchSession(desktop: "Mac", bases: [relay], token: "t3", seal: peer))
    #expect(shelf.entry(key)?.sealPinned == true)
    shelf.put(WatchSession(desktop: "Mac", bases: [relay], token: "t4", seal: SealPeer(deviceId: "mac", x: "k2", words: ["a", "b", "c", "d", "e", "f"])))
    #expect(shelf.entry(key)?.sealPinned == false)
  }

  @Test("a shelf a watch kept before sealing reads as no seal")
  func oldShelf() throws {
    let old = #"{"entries":[{"key":"k","desktop":"Mac","bases":[]}],"active":"k"}"#
    let shelf = try JSONDecoder().decode(SessionShelf.self, from: Data(old.utf8))
    #expect(shelf.entry("k")?.seal == nil)
    #expect(shelf.entry("k")?.sealPinned == nil)
  }

  @Test("a Mac the owner matched is pinned at once: a refusal of its relay road is a failure, never plain")
  func matchedPins() {
    let peer = SealPeer(deviceId: "mac", x: "k1", words: ["a", "b", "c", "d", "e", "f"])
    let session = WatchSession(desktop: "Mac", bases: [], token: "t").matched(peer)
    #expect(session.sealPinned)
    #expect(!WatchSession(desktop: "Mac", bases: [], token: "t").matched(nil).sealPinned)
    var shelf = SessionShelf()
    let key = shelf.put(session)
    #expect(shelf.entry(key)?.sealPinned == true)
  }

  @Test("a sealer that was closed opens nothing again: its store is gone")
  func closedSealer() async {
    struct Pass: RelayPass {
      var host: String { "127.0.0.1" }
      var port: Int? { 9 }
      func token() async -> String { "s" }
      func newer(than token: String) async -> String? { nil }
    }
    let peer = SealPeer(deviceId: "mac", x: "k1", words: [])
    let sealer = WatchSealer(peer: peer, device: WatchDevice(), relay: Pass(), pinned: false)
    await sealer.close()
    await #expect(throws: SealRoadClosed()) {
      _ = try await sealer.exchange(base: URL(string: "http://127.0.0.1:9/api/m/mac")!, method: "GET", path: "/api/x", headers: [:], body: nil)
    }
  }

  @Test("a pinned watch the Mac refused is not asked again at once: the road stays shut, with no handshake per call")
  func pinnedBackoff() async {
    struct Pass: RelayPass {
      var host: String { "127.0.0.1" }
      var port: Int? { 9 }
      func token() async -> String { "s" }
      func newer(than token: String) async -> String? { nil }
    }
    let peer = SealPeer(deviceId: Seal2.deviceId(x: base64urlEncoded(Data(repeating: 1, count: 32))), x: base64urlEncoded(Data(repeating: 1, count: 32)), words: [])
    let sealer = WatchSealer(peer: peer, device: WatchDevice(), relay: Pass(), pinned: true)
    let base = URL(string: "http://127.0.0.1:9/api/m/mac")!
    // Nothing listens on port 9: the first try fails at the handshake; the next is refused from memory, at once.
    await #expect(throws: SealRoadClosed()) { _ = try await sealer.exchange(base: base, method: "GET", path: "/a", headers: [:], body: nil) }
    let started = Date()
    await #expect(throws: SealRoadClosed()) { _ = try await sealer.exchange(base: base, method: "POST", path: "/b", headers: [:], body: nil) }
    #expect(Date().timeIntervalSince(started) < 0.5)
  }
}
