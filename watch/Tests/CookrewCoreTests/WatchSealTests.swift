import Foundation
import Testing
@testable import CookrewCore

@Suite("the watch's sealed road: what the claim brings and what is kept")
struct WatchSealTests {
  @Test("a claim answer with a seal is read; one without, or one the watch cannot read, is the old claim")
  func claimSeal() throws {
    let with = #"{"ok":true,"token":"t","desktop":"Mac","bases":[],"seal":{"deviceId":"ABC","jwk":{"kty":"OKP","crv":"Ed25519","x":"xx"},"words":["a","b","c","d","e","f"]}}"#
    let read = try JSONDecoder().decode(ClaimReply.self, from: Data(with.utf8))
    #expect(read.seal == SealPeer(deviceId: "abc", x: "xx", words: ["a", "b", "c", "d", "e", "f"]))
    let without = try JSONDecoder().decode(ClaimReply.self, from: Data(#"{"token":"t","desktop":"Mac","bases":[]}"#.utf8))
    #expect(without.seal == nil)
    let odd = try JSONDecoder().decode(ClaimReply.self, from: Data(#"{"token":"t","desktop":"Mac","bases":[],"seal":{"deviceId":1}}"#.utf8))
    #expect(odd.seal == nil)
  }

  @Test("a watch's claim carries its account id and public key")
  func claimFields() throws {
    let device = WatchDevice()
    let fields = device.sealFields
    #expect(fields["deviceId"] as? String == device.id)
    let jwk = fields["jwk"] as? [String: String]
    #expect(jwk?["crv"] == "Ed25519")
    #expect(base64urlDecoded(jwk?["x"] ?? "").count == 32)
  }

  @Test("pinned stays pinned for the same Mac key; a new key starts over")
  func pinOnShelf() {
    let peer = SealPeer(deviceId: "mac", x: "k1", words: ["a", "b", "c", "d", "e", "f"])
    var shelf = SessionShelf()
    let key = shelf.put(WatchSession(desktop: "Mac", bases: [Base(kind: "relay", url: "https://x/api/m/mac")], token: "t", seal: peer))
    #expect(shelf.entry(key)?.sealPinned == false)
    shelf.markSealed(key)
    #expect(shelf.entry(key)?.sealPinned == true)
    shelf.put(WatchSession(desktop: "Mac", bases: [Base(kind: "relay", url: "https://x/api/m/mac")], token: "t2", seal: peer))
    #expect(shelf.entry(key)?.sealPinned == true)
    let other = SealPeer(deviceId: "mac", x: "k2", words: ["a", "b", "c", "d", "e", "f"])
    shelf.put(WatchSession(desktop: "Mac", bases: [Base(kind: "relay", url: "https://x/api/m/mac")], token: "t3", seal: other))
    #expect(shelf.entry(key)?.sealPinned == false)
  }

  @Test("a shelf a watch kept before sealing reads as no seal")
  func oldShelf() throws {
    let old = #"{"entries":[{"key":"k","desktop":"Mac","bases":[]}],"active":"k"}"#
    let shelf = try JSONDecoder().decode(SessionShelf.self, from: Data(old.utf8))
    #expect(shelf.entry("k")?.seal == nil)
    #expect(shelf.entry("k")?.sealPinned == nil)
  }
}
