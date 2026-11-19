import CryptoKit
import Foundation

// COOKREW-SEAL/2 IN SWIFT: the same protocol as src/shared/seal2/ (spec.ts is
// the specification), on CryptoKit alone. Checked against the vectors the
// TypeScript and node:crypto implementations are checked against
// (tests/fixtures/seal-v2-vectors.json, watch/Tests/.../Seal2VectorTests.swift).
//
// What the watch needs to be a sealed client: the code-mode handshake as the
// initiator, records both ways with the epoch rekey, and the binary frames.

public enum Seal2 {
  public static let label = "cookrew-seal/2"
  public static let version: UInt8 = 2
  public static let epochRecords: UInt64 = 1 << 16
  public static let seqLimit: UInt64 = 1 << 48
  static let maxEpochsAhead: UInt64 = 4
  static let v1IdLabel = "cookrew-canvas-seal/1 id"

  // MARK: bytes

  static func hkdf(_ ikm: Data, salt: Data, info: String, count: Int) -> Data {
    let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: Data(info.utf8), outputByteCount: count)
    return key.withUnsafeBytes { Data($0) }
  }

  static func sha256(_ parts: Data...) -> Data {
    var hash = SHA256()
    for part in parts { hash.update(data: part) }
    return Data(hash.finalize())
  }

  static func u64(_ value: UInt64) -> Data {
    withUnsafeBytes(of: value.bigEndian) { Data($0) }
  }

  static func u32(_ value: UInt32) -> Data {
    withUnsafeBytes(of: value.bigEndian) { Data($0) }
  }

  static func u16(_ value: UInt16) -> Data {
    withUnsafeBytes(of: value.bigEndian) { Data($0) }
  }

  static func readUInt(_ data: Data, at: Int, width: Int) -> UInt64 {
    data[data.startIndex + at ..< data.startIndex + at + width].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
  }

  // MARK: handshake (code mode, the initiator: a phone or the watch)

  public enum Failure: Error, Equatable {
    case badCode, badAnswer, unproven, usedUp, tooLarge
  }

  public struct CodeHello: Equatable {
    public let v: Int
    public let vs: [Int]
    public let id: String
    public let e: String
    public var json: [String: Any] { ["v": v, "vs": vs, "id": id, "e": e] }
  }

  /** The keys a handshake ends with, before either end has confirmed. */
  struct Schedule {
    let transcript: Data
    let toResponder: Data
    let toInitiator: Data
    let confirm: SymmetricKey

    var sessionId: String { base64urlEncoded(transcript.prefix(16)) }

    func proof(_ who: String) -> Data {
      Data(HMAC<SHA256>.authenticationCode(for: Data(who.utf8) + transcript, using: confirm))
    }

    func check(_ who: String, _ proof: String) -> Bool {
      HMAC<SHA256>.isValidAuthenticationCode(base64urlDecoded(proof), authenticating: Data(who.utf8) + transcript, using: confirm)
    }
  }

  static func transcript(mode: UInt8, offered: [UInt8], context: Data, initiator: Data, responder: Data) -> Data {
    sha256(Data(label.utf8), Data([0, mode, version, UInt8(offered.count)]), Data(offered), context, initiator, responder)
  }

  static func schedule(ikm: Data, transcript: Data) -> Schedule {
    let keys = hkdf(ikm, salt: transcript, info: "\(label) keys", count: 96)
    return Schedule(transcript: transcript, toResponder: keys.prefix(32), toInitiator: keys.dropFirst(32).prefix(32), confirm: SymmetricKey(data: keys.suffix(32)))
  }

  public struct CodeHandshake {
    let code: Data
    let id: Data
    let mine: Curve25519.KeyAgreement.PrivateKey
    public let hello: CodeHello

    /** `ephemeral` fixed only for the vectors. */
    public init(code: Data, ephemeral: Data? = nil) throws {
      guard code.count == 32 else { throw Failure.badCode }
      self.code = code
      id = Seal2.hkdf(code, salt: Data(), info: Seal2.v1IdLabel, count: 16)
      mine = try ephemeral.map { try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: $0) } ?? Curve25519.KeyAgreement.PrivateKey()
      hello = CodeHello(v: 1, vs: [2], id: base64urlEncoded(id), e: base64urlEncoded(mine.publicKey.rawRepresentation))
    }

    /** The session and the finish to send, once the answer proved the code; v2 only. */
    public func finish(acceptV: Int, e: String, proof: String) throws -> (session: Session, finish: [String: String]) {
      guard acceptV == 2 else { throw Failure.badAnswer }
      let theirs = base64urlDecoded(e)
      guard theirs.count == 32, let key = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: theirs) else { throw Failure.badAnswer }
      let shared = try mine.sharedSecretFromKeyAgreement(with: key).withUnsafeBytes { Data($0) }
      guard shared.contains(where: { $0 != 0 }) else { throw Failure.badAnswer }
      let th = Seal2.transcript(mode: 1, offered: [2], context: id, initiator: mine.publicKey.rawRepresentation, responder: theirs)
      let s = Seal2.schedule(ikm: shared + code, transcript: th)
      guard s.check("responder", proof) else { throw Failure.unproven }
      let session = Session(id: s.sessionId, send: s.toResponder, open: s.toInitiator, sends: .toResponder)
      return (session, ["proof": base64urlEncoded(s.proof("initiator"))])
    }
  }

  // MARK: device mode (the watch dials its Mac with its account key)

  /** RFC 7638 thumbprint of an Ed25519 key, as account-v2.ts and seal2/handshake.ts write it. */
  public static func thumbprint(x: String) -> Data {
    sha256(Data("{\"crv\":\"Ed25519\",\"kty\":\"OKP\",\"x\":\"\(x)\"}".utf8))
  }

  /** The account device id a key makes: a desktop's id is this; a watch's is not. */
  public static func deviceId(x: String) -> String {
    var bytes = [UInt8](sha256(thumbprint(x: x)).prefix(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x80
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    let hex = bytes.map { String(format: "%02x", $0) }.joined()
    let at = { (from: Int, to: Int) in String(hex[hex.index(hex.startIndex, offsetBy: from) ..< hex.index(hex.startIndex, offsetBy: to)]) }
    return [at(0, 8), at(8, 12), at(12, 16), at(16, 20), at(20, 32)].joined(separator: "-")
  }

  static func uuidBytes(_ id: String) -> Data {
    let hex = id.replacingOccurrences(of: "-", with: "")
    return Data(stride(from: 0, to: hex.count, by: 2).compactMap { UInt8(String(hex[hex.index(hex.startIndex, offsetBy: $0) ..< hex.index(hex.startIndex, offsetBy: $0 + 2)]), radix: 16) })
  }

  /** The six words the watch and its Mac both show for their two keys (seal2/handshake.ts · keyWords). */
  public static func keyWords(_ a: String, _ b: String, nonce: Data) -> [String] {
    let thumbs = [thumbprint(x: a), thumbprint(x: b)].sorted { $0.lexicographicallyPrecedes($1) }
    let digest = [UInt8](sha256(Data("\(label) key words".utf8), Data([0]), thumbs[0], thumbs[1], nonce))
    return (0 ..< 6).map { word in
      let index = (0 ..< 11).reduce(0) { value, bit in
        let position = word * 11 + bit
        return (value << 1) | Int((digest[position >> 3] >> (7 - UInt8(position & 7))) & 1)
      }
      return FingerprintWords.all[index]
    }
  }

  public struct DeviceHandshake {
    let mine: Curve25519.KeyAgreement.PrivateKey
    let signing: Curve25519.Signing.PrivateKey
    let from: String
    let to: String
    let macX: String
    public let hello: [String: Any]

    /**
     * `macX`: the Mac's key as its claim answer gave it, the one and only key accepted.
     * `ephemeral` fixed only for the vectors.
     */
    public init(deviceId: String, signing: Curve25519.Signing.PrivateKey, to: String, macX: String, ephemeral: Data? = nil) throws {
      self.signing = signing
      from = deviceId.lowercased()
      self.to = to.lowercased()
      self.macX = macX
      mine = try ephemeral.map { try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: $0) } ?? Curve25519.KeyAgreement.PrivateKey()
      let x = base64urlEncoded(signing.publicKey.rawRepresentation)
      hello = ["v": 2, "vs": [2], "mode": "device", "from": from, "to": self.to, "jwk": ["kty": "OKP", "crv": "Ed25519", "x": x], "e": base64urlEncoded(mine.publicKey.rawRepresentation)]
    }

    /** The session and the finish to send, once the answer is signed by the very Mac pinned at the claim. */
    public func finish(accept: [String: Any]) throws -> (session: Session, finish: [String: String]) {
      guard accept["v"] as? Int == 2, let jwk = accept["jwk"] as? [String: Any], let x = jwk["x"] as? String,
            let e = accept["e"] as? String, let proof = accept["proof"] as? String, let sig = accept["sig"] as? String else { throw Failure.badAnswer }
      guard x == macX, Seal2.deviceId(x: x) == to, let macKey = try? Curve25519.Signing.PublicKey(rawRepresentation: base64urlDecoded(x)) else { throw Failure.unproven }
      let theirs = base64urlDecoded(e)
      guard theirs.count == 32, let key = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: theirs) else { throw Failure.badAnswer }
      let shared = try mine.sharedSecretFromKeyAgreement(with: key).withUnsafeBytes { Data($0) }
      guard shared.contains(where: { $0 != 0 }) else { throw Failure.badAnswer }
      let myX = base64urlEncoded(signing.publicKey.rawRepresentation)
      let context = Seal2.uuidBytes(from) + Seal2.uuidBytes(to) + Seal2.thumbprint(x: myX) + Seal2.thumbprint(x: x)
      let th = Seal2.transcript(mode: 2, offered: [2], context: context, initiator: mine.publicKey.rawRepresentation, responder: theirs)
      let s = Seal2.schedule(ikm: shared, transcript: th)
      guard s.check("responder", proof) else { throw Failure.unproven }
      let signed = { (who: String) in Data("\(Seal2.label) \(who)\n\(base64urlEncoded(th))".utf8) }
      guard macKey.isValidSignature(base64urlDecoded(sig), for: signed("responder")) else { throw Failure.unproven }
      let mySig = base64urlEncoded(try signing.signature(for: signed("initiator")))
      return (Session(id: s.sessionId, send: s.toResponder, open: s.toInitiator, sends: .toResponder), ["proof": base64urlEncoded(s.proof("initiator")), "sig": mySig])
    }
  }

  // MARK: records

  public enum Direction: UInt8 { case toResponder = 1, toInitiator = 2 }

  static func epochSecret(_ first: Data, epoch: UInt64) -> Data {
    var secret = first
    for _ in 0 ..< epoch { secret = hkdf(secret, salt: Data(), info: "\(label) next", count: 32) }
    return secret
  }

  static func epochKey(_ secret: Data) -> (key: SymmetricKey, iv: Data) {
    (SymmetricKey(data: hkdf(secret, salt: Data(), info: "\(label) key", count: 32)), hkdf(secret, salt: Data(), info: "\(label) iv", count: 12))
  }

  static func nonce(iv: Data, seq: UInt64) -> Data {
    let counter = Data(count: 4) + u64(seq)
    return Data(zip(iv, counter).map { $0 ^ $1 })
  }

  static func aad(_ direction: Direction, seq: UInt64) -> Data {
    Data(label.utf8) + Data([direction.rawValue]) + u64(seq)
  }

  /** One session's records. Epoch keys are walked forward and the walked-past secrets dropped. */
  public final class Session {
    public let id: String
    let sends: Direction
    var sendEpoch: UInt64 = 0
    var sendSecret: Data
    var openFloor: UInt64 = 0
    var openSecret: Data
    var next: UInt64 = 0

    init(id: String, send: Data, open: Data, sends: Direction) {
      self.id = id
      self.sends = sends
      sendSecret = send
      openSecret = open
    }

    public func seal(_ plain: Data) throws -> (seq: UInt64, box: Data) {
      guard plain.count <= 256 * 1024 else { throw Failure.tooLarge }
      guard next < Seal2.seqLimit else { throw Failure.usedUp }
      let seq = next
      next += 1
      let epoch = seq / Seal2.epochRecords
      sendSecret = Seal2.epochSecret(sendSecret, epoch: epoch - sendEpoch)
      sendEpoch = epoch
      let (key, iv) = Seal2.epochKey(sendSecret)
      let box = try AES.GCM.seal(plain, using: key, nonce: AES.GCM.Nonce(data: Seal2.nonce(iv: iv, seq: seq)), authenticating: Seal2.aad(sends, seq: seq))
      return (seq, box.ciphertext + box.tag)
    }

    /** Nil for anything that does not open. The caller delivers in order, each number once. */
    public func open(seq: UInt64, box: Data) -> Data? {
      guard seq < Seal2.seqLimit, box.count >= 16 else { return nil }
      let epoch = seq / Seal2.epochRecords
      // A number far ahead would cost a long key walk before it failed: a receiver's window spans
      // at most two epochs past what it has forgotten, so anything further is not opened at all.
      guard epoch >= openFloor, epoch - openFloor <= Seal2.maxEpochsAhead else { return nil }
      let (key, iv) = Seal2.epochKey(Seal2.epochSecret(openSecret, epoch: epoch - openFloor))
      let opens: Direction = sends == .toResponder ? .toInitiator : .toResponder
      guard let nonce = try? AES.GCM.Nonce(data: Seal2.nonce(iv: iv, seq: seq)),
            let sealed = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: box.dropLast(16), tag: box.suffix(16)),
            let plain = try? AES.GCM.open(sealed, using: key, authenticating: Seal2.aad(opens, seq: seq)) else { return nil }
      return plain
    }

    /** The receiver will never open below this epoch again: forget its secrets. */
    public func forgetBelow(epoch: UInt64) {
      guard epoch > openFloor else { return }
      openSecret = Seal2.epochSecret(openSecret, epoch: epoch - openFloor)
      openFloor = epoch
    }
  }

  /** One record on the wire: u32 length | u64 seq | box. */
  public static func wire(seq: UInt64, box: Data) -> Data {
    u32(UInt32(8 + box.count)) + u64(seq) + box
  }

  /** Whole records out of a byte stream; nil once a length no record has is seen. */
  public static func records(_ data: Data) -> (records: [(seq: UInt64, box: Data)], rest: Data)? {
    var out: [(UInt64, Data)] = []
    var at = 0
    while data.count - at >= 4 {
      let length = Int(readUInt(data, at: at, width: 4))
      guard length >= 24, length <= 8 + 256 * 1024 + 16 else { return nil }
      guard data.count - at >= 4 + length else { break }
      let seq = readUInt(data, at: at + 4, width: 8)
      out.append((seq, Data(data[data.startIndex + at + 12 ..< data.startIndex + at + 4 + length])))
      at += 4 + length
    }
    return (out, Data(data.dropFirst(at)))
  }

  // MARK: frames

  public enum Frame: Equatable {
    case open(stream: UInt32, kind: String, fields: [String: String])
    case head(stream: UInt32, status: UInt16, fields: [String: String])
    case data(stream: UInt32, bytes: Data)
    case end(stream: UInt32)
    case abort(stream: UInt32, code: UInt16, reason: String)
    case ack(next: UInt64)
    case ping
    case credit(stream: UInt32, bytes: UInt32)
    case goaway(code: UInt16, reason: String)
  }

  /** Fields in the order given: the encoding is order-preserving, so pass pairs. */
  static func fields(_ pairs: [(String, String)]) -> Data {
    pairs.reduce(u16(UInt16(pairs.count))) { out, pair in
      out + u16(UInt16(pair.0.utf8.count)) + Data(pair.0.utf8) + u32(UInt32(pair.1.utf8.count)) + Data(pair.1.utf8)
    }
  }

  static func readFields(_ data: Data) -> [String: String]? {
    guard data.count >= 2 else { return nil }
    let count = Int(readUInt(data, at: 0, width: 2))
    var at = 2
    var out: [String: String] = [:]
    for _ in 0 ..< count {
      guard data.count >= at + 2 else { return nil }
      let nameLength = Int(readUInt(data, at: at, width: 2))
      at += 2
      guard data.count >= at + nameLength + 4, let name = String(data: data[data.startIndex + at ..< data.startIndex + at + nameLength], encoding: .utf8) else { return nil }
      at += nameLength
      let valueLength = Int(readUInt(data, at: at, width: 4))
      at += 4
      guard data.count >= at + valueLength, let value = String(data: data[data.startIndex + at ..< data.startIndex + at + valueLength], encoding: .utf8), out[name] == nil else { return nil }
      at += valueLength
      out[name] = value
    }
    return at == data.count ? out : nil
  }

  public static func encode(_ frame: Frame, fieldOrder: [String] = []) -> Data {
    let ordered = { (fields: [String: String]) -> [(String, String)] in
      let known = fieldOrder.compactMap { name in fields[name].map { (name, $0) } }
      return known + fields.filter { !fieldOrder.contains($0.key) }.sorted { $0.key < $1.key }
    }
    switch frame {
    case let .open(stream, kind, f): return Data([1]) + u32(stream) + Data([UInt8(kind.utf8.count)]) + Data(kind.utf8) + fields(ordered(f))
    case let .head(stream, status, f): return Data([2]) + u32(stream) + u16(status) + fields(ordered(f))
    case let .data(stream, bytes): return Data([3]) + u32(stream) + bytes
    case let .end(stream): return Data([4]) + u32(stream)
    case let .abort(stream, code, reason): return Data([5]) + u32(stream) + u16(code) + Data(reason.utf8)
    case let .ack(next): return Data([6]) + u32(0) + u64(next)
    case .ping: return Data([7]) + u32(0)
    case let .credit(stream, bytes): return Data([8]) + u32(stream) + u32(bytes)
    case let .goaway(code, reason): return Data([9]) + u32(0) + u16(code) + Data(reason.utf8)
    }
  }

  public static func decode(_ raw: Data) -> Frame? {
    guard raw.count >= 5 else { return nil }
    let type = raw[raw.startIndex]
    let stream = UInt32(readUInt(raw, at: 1, width: 4))
    let body = Data(raw.dropFirst(5))
    let session = type == 6 || type == 7 || type == 9
    guard session == (stream == 0) else { return nil }
    switch type {
    case 1:
      guard let length = body.first, body.count >= 1 + Int(length), let kind = String(data: body.dropFirst().prefix(Int(length)), encoding: .ascii), let f = readFields(Data(body.dropFirst(1 + Int(length)))) else { return nil }
      return .open(stream: stream, kind: kind, fields: f)
    case 2:
      guard body.count >= 2, let f = readFields(Data(body.dropFirst(2))) else { return nil }
      let status = UInt16(readUInt(body, at: 0, width: 2))
      return (100 ... 599).contains(status) ? .head(stream: stream, status: status, fields: f) : nil
    case 3: return body.isEmpty || body.count > 256 * 1024 - 5 ? nil : .data(stream: stream, bytes: body)
    case 4: return body.isEmpty ? .end(stream: stream) : nil
    case 5:
      guard body.count >= 2, let reason = String(data: body.dropFirst(2), encoding: .utf8) else { return nil }
      return .abort(stream: stream, code: UInt16(readUInt(body, at: 0, width: 2)), reason: reason)
    case 6: return body.count == 8 ? .ack(next: readUInt(body, at: 0, width: 8)) : nil
    case 7: return body.isEmpty ? .ping : nil
    case 8:
      guard body.count == 4 else { return nil }
      let bytes = UInt32(readUInt(body, at: 0, width: 4))
      return bytes == 0 ? nil : .credit(stream: stream, bytes: bytes)
    case 9:
      guard body.count >= 2, let reason = String(data: body.dropFirst(2), encoding: .utf8) else { return nil }
      return .goaway(code: UInt16(readUInt(body, at: 0, width: 2)), reason: reason)
    default: return nil
    }
  }
}
