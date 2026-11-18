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

/** The Mac this watch seals with, as its claim answered. */
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
      if !pinned {
        pinned = true
        onPinned()
      }
      return opened
    } catch Seal2ClientError.refused where !pinned {
      // Not let in yet (the words not confirmed on the Mac), or a carrier saying so: the old way, as before.
      return nil
    } catch {
      if pinned { throw WatchError.unreachable }
      return nil
    }
  }

  /**
   * One call down the relay, sealed: nil means "the old way" (never once this watch was sealed).
   * `path` is the Mac's own, with its query.
   */
  public func exchange(base: URL, method: String, path: String, headers: [String: String], body: Data?) async throws -> (Data, HTTPURLResponse)? {
    guard let client = try await session(base: base) else { return nil }
    do {
      let answer = try await client.request(method: method, path: path, headers: headers, body: body)
      let url = URL(string: "\(base.absoluteString)\(path)") ?? base
      guard let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: answer.headers) else { throw WatchError.unreachable }
      return (answer.body, response)
    } catch let error as WatchError {
      throw error
    } catch {
      self.client = nil
      throw WatchError.unreachable
    }
  }

  public func close() async {
    await client?.close()
    client = nil
  }
}
