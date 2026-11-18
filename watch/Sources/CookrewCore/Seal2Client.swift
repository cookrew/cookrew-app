import Foundation

// THE WATCH'S END OF A COOKREW-SEAL/2 SESSION, OVER PLAIN HTTP as the relay
// carries it (src/shared/seal2/http-link.ts is the TypeScript twin, and
// src/main/canvas-seal-terminus.ts the Mac's end): POST /~seal/hello and
// /~seal/finish, one long GET down, POSTs up.
//
// What a watch needs and nothing more: requests and their answers, many at
// once, each answer kept whole. Records are delivered in order and once; every
// frame but an ACK is acked; credit is given back as answers arrive; a ping
// goes every twenty seconds. A failed POST goes again as the same bytes. A
// record that does not open, a refused proof, or a session the Mac no longer
// knows ends the session: nothing here ever sends in the clear.

public enum Seal2ClientError: Error, Equatable {
  case refused(String)
  case ended(String)
  case aborted(UInt16, String)
  case badAnswer
}

public struct Seal2Answer: Sendable {
  public let status: Int
  public let headers: [String: String]
  public let body: Data
}

/** How the session's own requests leave: the relay prefix and its session header, or a machine's own address. */
public struct Seal2Route: Sendable {
  public let url: @Sendable (String) -> URL
  public let headers: [String: String]

  public init(url: @escaping @Sendable (String) -> URL, headers: [String: String] = [:]) {
    self.url = url
    self.headers = headers
  }
}

public actor Seal2Client {
  private let route: Seal2Route
  private let http: URLSession
  private let session: Seal2.Session
  private var nextStream: UInt32 = 1
  private var waiting: [UInt32: Pending] = [:]
  private var expected: UInt64 = 0
  private var held: [UInt64: Data] = [:]
  private var outgoing: [Data] = []
  private var posting = false
  private var ended: String?
  private var ackDue = false
  private var listener: Task<Void, Never>?
  private var pinger: Task<Void, Never>?
  private static let window: UInt64 = 1024
  private static let creditStep = 64 * 1024

  private struct Pending {
    var status: Int?
    var headers: [String: String] = [:]
    var body = Data()
    var uncredited = 0
    /** What the Mac lets this end send on the stream; the rest of the body waits for CREDIT. */
    var credit = 1024 * 1024
    var unsent = Data()
    var ending = false
    let done: CheckedContinuation<Seal2Answer, Error>
  }

  init(route: Seal2Route, http: URLSession, session: Seal2.Session) {
    self.route = route
    self.http = http
    self.session = session
  }

  /** The handshake on the connect code, then the carrier. Throws `refused` for a code the Mac does not hold or cannot prove. */
  public static func open(route: Seal2Route, code: Data, http: URLSession = .shared) async throws -> Seal2Client {
    let shake = try Seal2.CodeHandshake(code: code)
    let (status, said) = try await post(route, http, "/~seal/hello", json: shake.hello.json)
    if status == 403 { throw Seal2ClientError.refused("code") }
    guard status == 200, let session = said["session"] as? String, let accept = said["accept"] as? [String: Any],
          let v = accept["v"] as? Int, let e = accept["e"] as? String, let proof = accept["proof"] as? String else { throw Seal2ClientError.badAnswer }
    let done: (session: Seal2.Session, finish: [String: String])
    do {
      done = try shake.finish(acceptV: v, e: e, proof: proof)
    } catch {
      throw Seal2ClientError.refused("proof")
    }
    let (finished, _) = try await post(route, http, "/~seal/finish", json: ["session": session].merging(done.finish) { $1 })
    guard finished == 200 else { throw Seal2ClientError.refused("proof") }
    let client = Seal2Client(route: route, http: http, session: done.session)
    await client.start()
    return client
  }

  private static func post(_ route: Seal2Route, _ http: URLSession, _ path: String, json: [String: Any]) async throws -> (Int, [String: Any]) {
    var request = URLRequest(url: route.url(path), timeoutInterval: 20)
    request.httpMethod = "POST"
    for (name, value) in route.headers { request.setValue(value, forHTTPHeaderField: name) }
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try JSONSerialization.data(withJSONObject: json)
    let (data, response) = try await http.data(for: request)
    let said = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    return ((response as? HTTPURLResponse)?.statusCode ?? 0, said)
  }

  private func start() {
    listener = Task { await self.listen() }
    pinger = Task {
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(20))
        await self.send(.ping)
      }
    }
  }

  /** One HTTP exchange, sealed. The answer comes whole. */
  public func request(method: String, path: String, headers: [String: String] = [:], body: Data? = nil) async throws -> Seal2Answer {
    if let ended { throw Seal2ClientError.ended(ended) }
    let stream = nextStream
    nextStream += 2
    let fields = headers.reduce(into: [":method": method, ":path": path]) { $0[$1.key.lowercased()] = $1.value }
    return try await withCheckedThrowingContinuation { done in
      waiting[stream] = Pending(unsent: body ?? Data(), ending: true, done: done)
      send(.open(stream: stream, kind: "http", fields: fields), order: [":method", ":path"])
      pump(stream)
    }
  }

  /** As much of the body as the stream's credit allows, then its END once all is gone. */
  private func pump(_ stream: UInt32) {
    guard var pending = waiting[stream] else { return }
    while !pending.unsent.isEmpty, pending.credit > 0 {
      let size = min(pending.unsent.count, pending.credit, 256 * 1024 - 5)
      send(.data(stream: stream, bytes: Data(pending.unsent.prefix(size))))
      pending.unsent = Data(pending.unsent.dropFirst(size))
      pending.credit -= size
    }
    if pending.unsent.isEmpty, pending.ending {
      pending.ending = false
      send(.end(stream: stream))
    }
    waiting[stream] = pending
  }

  public func close() {
    guard ended == nil else { return }
    send(.goaway(code: 0, reason: "closing"))
    finish("closed here")
  }

  private func finish(_ why: String) {
    guard ended == nil else { return }
    ended = why
    listener?.cancel()
    pinger?.cancel()
    for (_, pending) in waiting { pending.done.resume(throwing: Seal2ClientError.ended(why)) }
    waiting = [:]
  }

  // MARK: up

  private func send(_ frame: Seal2.Frame, order: [String] = []) {
    guard ended == nil, let sealed = try? session.seal(Seal2.encode(frame, fieldOrder: order)) else { return }
    outgoing.append(Seal2.wire(seq: sealed.seq, box: sealed.box))
    if !posting { Task { await self.flush() } }
  }

  private func flush() async {
    guard !posting else { return }
    posting = true
    defer { posting = false }
    var tries = 0
    while !outgoing.isEmpty, ended == nil {
      let batch = outgoing.prefix(64)
      var request = URLRequest(url: route.url("/~seal/up?s=\(session.id)"), timeoutInterval: 20)
      request.httpMethod = "POST"
      for (name, value) in route.headers { request.setValue(value, forHTTPHeaderField: name) }
      request.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
      request.httpBody = batch.reduce(Data(), +)
      let status = ((try? await http.data(for: request))?.1 as? HTTPURLResponse)?.statusCode ?? 0
      if (200 ..< 300).contains(status) {
        outgoing.removeFirst(batch.count)
        tries = 0
        continue
      }
      if status == 404 || status == 400 || status == 413 { return finish("the Mac refused a record (\(status))") }
      tries = status == 409 ? 0 : tries + 1
      if tries > 6 { return finish("the line up stopped answering") }
      try? await Task.sleep(for: .milliseconds(500 * min(tries + 1, 5)))
    }
  }

  // MARK: down

  private func listen() async {
    var misses = 0
    while ended == nil, !Task.isCancelled {
      let opened = await readDown()
      misses = opened ? 0 : misses + 1
      if misses >= 8 { return finish("the line down closed") }
      try? await Task.sleep(for: .seconds(1))
    }
  }

  private func readDown() async -> Bool {
    var request = URLRequest(url: route.url("/~seal/down?s=\(session.id)&from=\(expected)"), timeoutInterval: 3600)
    for (name, value) in route.headers { request.setValue(value, forHTTPHeaderField: name) }
    guard let (bytes, response) = try? await http.bytes(for: request), let status = (response as? HTTPURLResponse)?.statusCode else { return false }
    if status == 404 {
      finish("the Mac has no such session")
      return false
    }
    guard status == 200 else { return false }
    var buffer = Data()
    do {
      var chunk = Data()
      for try await byte in bytes {
        chunk.append(byte)
        // Records are read as they complete: a length prefix says when.
        if chunk.count >= 4 {
          let length = Int(Seal2.readUInt(chunk, at: 0, width: 4))
          if chunk.count < 4 + length { continue }
        } else { continue }
        buffer.append(chunk)
        chunk = Data()
        guard let parsed = Seal2.records(buffer) else {
          finish("the line sent something that is not a record")
          return true
        }
        buffer = parsed.rest
        for (seq, box) in parsed.records where !accept(seq: seq, box: box) {
          finish("a record was tampered with")
          return true
        }
        if ackDue {
          ackDue = false
          send(.ack(next: expected))
        }
      }
    } catch {
      return true
    }
    return true
  }

  /** In order, once each. False for a record that does not open. */
  private func accept(seq: UInt64, box: Data) -> Bool {
    if seq < expected || held[seq] != nil {
      ackDue = true
      return true
    }
    guard seq < expected + Self.window else { return true }
    guard let plain = session.open(seq: seq, box: box) else { return false }
    held[seq] = plain
    while let ready = held.removeValue(forKey: expected) {
      expected += 1
      deliver(ready)
    }
    if expected > Self.window { session.forgetBelow(epoch: (expected - Self.window) / Seal2.epochRecords) }
    return true
  }

  private func deliver(_ plain: Data) {
    guard let frame = Seal2.decode(plain) else { return finish("a frame that is not one") }
    if case .ack = frame {} else { ackDue = true }
    switch frame {
    case let .head(stream, status, fields):
      waiting[stream]?.status = Int(status)
      waiting[stream]?.headers = fields
    case let .data(stream, bytes):
      guard var pending = waiting[stream] else { return }
      pending.body.append(bytes)
      pending.uncredited += bytes.count
      if pending.uncredited >= Self.creditStep {
        send(.credit(stream: stream, bytes: UInt32(pending.uncredited)))
        pending.uncredited = 0
      }
      waiting[stream] = pending
    case let .end(stream):
      guard let pending = waiting.removeValue(forKey: stream) else { return }
      guard let status = pending.status else { return pending.done.resume(throwing: Seal2ClientError.badAnswer) }
      pending.done.resume(returning: Seal2Answer(status: status, headers: pending.headers, body: pending.body))
    case let .abort(stream, code, reason):
      waiting.removeValue(forKey: stream)?.done.resume(throwing: Seal2ClientError.aborted(code, reason))
    case .goaway:
      break
    case .open(let stream, _, _):
      // The Mac opens no streams toward a watch.
      send(.abort(stream: stream, code: 9, reason: "no streams here"))
    case let .credit(stream, bytes):
      guard waiting[stream] != nil else { return }
      waiting[stream]?.credit += Int(bytes)
      pump(stream)
    case .ack, .ping:
      break
    }
  }
}
