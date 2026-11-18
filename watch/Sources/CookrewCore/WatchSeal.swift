import CryptoKit
import Foundation

// THE WATCH'S RELAY ROAD, SEALED (cookrew-seal/2 device mode, src/shared/seal2/spec.ts).
//
// The Mac's key came with the claim (the claim answer's `seal`), and six words
// over both keys showed on both screens. Once the owner said on the Mac that the
// words are the same, the Mac lets this watch in, and every call that goes by
// the relay goes inside one sealed session instead: the relay sees ciphertext.
//
//   not let in yet, never sealed   the old way: the call goes in the clear, as before
//   sealed once (pinned)           only sealed, ever: a failure is a failure, never plain
//
// The direct roads (the Mac's own address at home) are not this file's.

/** What a claim answer offers: not yet believed (ClaimReply · sealOffer). */
public struct SealOffer: Equatable, Sendable {
  public let deviceId: String
  public let x: String
  public let nonce: Data

  public init(deviceId: String, x: String, nonce: Data) {
    self.deviceId = deviceId
    self.x = x
    self.nonce = nonce
  }

  /** The six words, computed HERE from this watch's own key, the offered key and the nonce: never taken from the answer. */
  public func words(ownX: String) -> [String] {
    Seal2.keyWords(ownX, x, nonce: nonce)
  }

  /** The owner said the words match: the Mac this watch seals with. */
  public func matched(ownX: String) -> SealPeer {
    SealPeer(deviceId: deviceId, x: x, words: words(ownX: ownX))
  }
}

/** The Mac this watch seals with, once the owner said the words match on the watch. */
public struct SealPeer: Codable, Equatable, Sendable {
  public let deviceId: String
  public let x: String
  public let words: [String]

  public init(deviceId: String, x: String, words: [String]) {
    self.deviceId = deviceId
    self.x = x
    self.words = words
  }
}

public actor WatchSealer {
  private let peer: SealPeer
  private let device: WatchDevice
  private let relay: RelayPass
  private let http: URLSession
  private let onPinned: @Sendable () -> Void
  private var pinned: Bool
  private var client: Seal2Client?
  private var opening: Task<Seal2Client?, Error>?
  /** Not let in yet: not asked again before this, so a watch waiting for the owner costs the Mac nothing. */
  private var refusedUntil = Date.distantPast
  private var refusedFor: TimeInterval = 0

  public init(peer: SealPeer, device: WatchDevice, relay: RelayPass, pinned: Bool, http: URLSession = .shared, onPinned: @escaping @Sendable () -> Void = {}) {
    self.peer = peer
    self.device = device
    self.relay = relay
    self.pinned = pinned
    self.http = http
    self.onPinned = onPinned
  }

  public var isPinned: Bool { pinned }

  /** The session, open or opened now; nil when the Mac has not let this watch in and it was never sealed. */
  private func session(base: URL) async throws -> Seal2Client? {
    if let client, await client.isOpen() { return client }
    if let dead = client {
      client = nil
      await dead.close()
    }
    if !pinned, Date() < refusedUntil { return nil }
    if let opening { return try await opening.value }
    let task = Task { try await self.open(base: base) }
    opening = task
    defer { opening = nil }
    return try await task.value
  }

  private func open(base: URL) async throws -> Seal2Client? {
    let token = await relay.token()
    let prefix = base.absoluteString.hasSuffix("/") ? String(base.absoluteString.dropLast()) : base.absoluteString
    let route = Seal2Route(url: { URL(string: "\(prefix)\($0)")! }, headers: [relaySessionHeader: token])
    let shake = try Seal2.DeviceHandshake(deviceId: device.id, signing: try device.signingKey(), to: peer.deviceId, macX: peer.x)
    do {
      let opened = try await Seal2Client.open(route: route, device: shake, http: http)
      client = opened
      refusedFor = 0
      if !pinned {
        pinned = true
        onPinned()
      }
      return opened
    } catch {
      if pinned { throw WatchError.unreachable }
      // Not let in yet (the words not confirmed on the Mac), or a carrier saying so: the old way, as before,
      // and not asked again for a while, longer each time.
      refusedFor = min(max(refusedFor * 2, 30), 600)
      refusedUntil = Date().addingTimeInterval(refusedFor)
      return nil
    }
  }

  /**
   * One call down the relay, sealed: nil means "the old way" (never once this watch was sealed).
   * `path` is the Mac's own, with its query.
   */
  public func exchange(base: URL, method: String, path: String, headers: [String: String], body: Data?, timeout: Double = Seal2Client.requestSeconds) async throws -> (Data, HTTPURLResponse)? {
    guard let client = try await session(base: base) else { return nil }
    do {
      let answer = try await client.request(method: method, path: path, headers: headers, body: body, timeout: timeout)
      let url = URL(string: "\(base.absoluteString)\(path)") ?? base
      guard let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: answer.headers) else { throw WatchError.unreachable }
      return (answer.body, response)
    } catch let error as WatchError {
      throw error
    } catch {
      // One request that failed is not a dead session; one that is gets closed, not left polling.
      if await !client.isOpen() {
        self.client = nil
        await client.close()
      }
      throw WatchError.unreachable
    }
  }

  public func close() async {
    await client?.close()
    client = nil
  }
}
