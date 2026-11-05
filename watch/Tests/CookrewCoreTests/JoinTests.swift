import CryptoKit
import Foundation
import Testing

@testable import CookrewCore

private let registry = "https://cookrew.dev"
private let macId = "11111111-1111-4111-8111-111111111111"
private let studioId = "22222222-2222-4222-8222-222222222222"

/** The registry and the Macs behind it, as a script. */
private final class FakeRegistry: RegistryAPI, @unchecked Sendable {
  var joinResult: Result<JoinReply, RegistryError> = .success(JoinReply(token: "session", exp: 5_000, deviceId: "dev", username: "drej"))
  var desktopsResult: Result<[WatchDesktop], RegistryError> = .success([WatchDesktop(deviceId: macId, name: "MacBook Pro")])
  var claims: [String: Result<ClaimReply, RegistryError>] = [:]
  var log: [String] = []

  func join(code: String, device: WatchDevice, name: String) async throws -> JoinReply {
    log.append("join \(code)")
    return try joinResult.get()
  }

  func desktops(token: String) async throws -> [WatchDesktop] {
    log.append("desktops \(token)")
    return try desktopsResult.get()
  }

  func claim(relay: URL, code: String, token: String) async throws -> ClaimReply {
    log.append("claim \(relay.absoluteString) \(code)")
    let id = relay.lastPathComponent
    guard let result = claims[id] else { throw RegistryError.claim("no-code") }
    return try result.get()
  }

  func renew(account: WatchAccount, device: WatchDevice) async throws -> Renewed {
    log.append("renew")
    return Renewed(token: "fresh", exp: 9_000)
  }

  func signOut(token: String) async {
    log.append("signout")
  }
}

private final class Kept: @unchecked Sendable {
  var accounts: [WatchAccount] = []
  var steps: [JoinStep] = []
}

private let reply = ClaimReply(token: "mac-token", desktop: "MacBook Pro", bases: [Base(kind: "lan", url: "http://192.168.2.40:8639")])
private let held = WatchAccount(registry: registry, username: "drej", deviceId: "dev", token: "session", exp: 5_000)

private func pair(_ api: FakeRegistry, code: String = "K7QM2XPD", held: WatchAccount? = nil, kept: Kept = Kept(), now: Double = 1_000) async -> JoinOutcome {
  await pairWatch(
    code: code,
    held: held,
    device: WatchDevice(),
    name: "Apple Watch",
    registry: registry,
    api: api,
    now: now,
    keep: { kept.accounts.append($0) },
    step: { kept.steps.append($0) }
  )
}

@Suite struct JoinFlowTests {
  @Test func testOneCodeJoinsTheAccountThenClaimsTheMacThatHoldsIt() async {
    let api = FakeRegistry()
    api.claims[macId] = .success(reply)
    let kept = Kept()
    let outcome = await pair(api, kept: kept)
    guard case .paired(let session, let account) = outcome else { Issue.record("\(outcome)"); return }
    #expect(api.log == ["join K7QM-2XPD", "desktops session", "claim https://cookrew.dev/relay/@drej/desktop/\(macId) K7QM-2XPD"])
    #expect(kept.steps == [.joining, .finding])
    #expect(account.username == "drej")
    #expect(session.token == "mac-token")
    #expect(session.desktop == "MacBook Pro")
  }

  @Test func testTheCodeFindsItsOwnMacAmongSeveral() async {
    let api = FakeRegistry()
    api.desktopsResult = .success([WatchDesktop(deviceId: studioId, name: "Studio"), WatchDesktop(deviceId: macId, name: "MacBook Pro")])
    api.claims[studioId] = .failure(.unreachable)
    api.claims[macId] = .success(reply)
    guard case .paired = await pair(api) else { Issue.record("the second Mac held the code"); return }
  }

  @Test func testTheAccountIsKeptBeforeTheMacIsAskedBecauseTheCodeIsSpentByThen() async {
    let api = FakeRegistry()
    api.claims[macId] = .failure(.unreachable)
    let kept = Kept()
    let outcome = await pair(api, kept: kept)
    #expect(outcome == .failed(.macAway))
    #expect(kept.accounts.map(\.token) == ["session"])
  }

  @Test func testAWatchAlreadyInTheAccountOnlyClaims() async {
    let api = FakeRegistry()
    api.claims[macId] = .success(reply)
    let kept = Kept()
    guard case .paired = await pair(api, held: held, kept: kept) else { Issue.record("claim"); return }
    #expect(!(api.log.contains { $0.hasPrefix("join") }))
    #expect(kept.steps == [.finding])
  }

  @Test func testAnExpiredSessionJoinsAgain() async {
    let api = FakeRegistry()
    api.claims[macId] = .success(reply)
    guard case .paired = await pair(api, held: held, now: 6_000) else { Issue.record("rejoin"); return }
    #expect(api.log.first == "join K7QM-2XPD")
  }

  @Test func testASessionTheRegistryEndedJoinsAgainWithTheSameCode() async {
    let api = FakeRegistry()
    api.desktopsResult = .failure(.signedOut)
    let outcome = await pair(api, held: held)
    #expect(outcome == .failed(.signedOut))
    #expect(api.log.filter { $0.hasPrefix("join") }.count == 1)
  }

  @Test func testTheRegistrysOwnRefusalsAreNamed() async {
    let cases: [(RegistryError, JoinFailure)] = [(.wrongCode, .wrongCode), (.slow, .slow), (.unreachable, .noNetwork), (.locked, .locked), (.badDevice, .newDevice)]
    for (error, failure) in cases {
      let api = FakeRegistry()
      api.joinResult = .failure(error)
      let outcome = await pair(api)
      #expect(outcome == .failed(failure))
    }
  }

  @Test func testWhatTheMacsSayDecidesTheWords() async {
    let cases: [(String, JoinFailure)] = [("wrong", .wrongCode), ("no-code", .ended), ("expired", .ended), ("burned", .ended)]
    for (reason, failure) in cases {
      let api = FakeRegistry()
      api.claims[macId] = .failure(.claim(reason))
      let outcome = await pair(api, held: held)
      #expect(outcome == .failed(failure), "\(reason)")
    }
    let api = FakeRegistry()
    api.claims[macId] = .failure(.slow)
    let outcome = await pair(api, held: held)
    #expect(outcome == .failed(.slow))
  }

  @Test func testNoMacOnTheAccountIsAMacAway() async {
    let api = FakeRegistry()
    api.desktopsResult = .success([])
    let outcome = await pair(api, held: held)
    #expect(outcome == .failed(.macAway))
  }
}

@Suite struct DeviceTests {
  @Test func testADeviceIsTheShapeTheRegistryReads() throws {
    let device = WatchDevice()
    let wire = device.wire(name: "Apple Watch")
    #expect(wire["id"] as? String == device.id)
    #expect(device.id == device.id.lowercased())
    #expect(wire["kind"] as? String == "phone")
    let jwk = try #require(wire["jwk"] as? [String: String])
    #expect(jwk["kty"] == "OKP")
    #expect(jwk["crv"] == "Ed25519")
    #expect(jwk["x"]?.contains("=") == false)
    #expect(base64urlDecoded(try #require(jwk["x"])).count == 32)
  }

  @Test func testASignatureVerifiesAgainstThePublicHalf() throws {
    let device = WatchDevice()
    let sig = try device.sign("cookrew-renew/1 drej dev nonce")
    let jwk = try #require(device.wire(name: "w")["jwk"] as? [String: String])
    let key = try Curve25519.Signing.PublicKey(rawRepresentation: base64urlDecoded(try #require(jwk["x"])))
    #expect(key.isValidSignature(base64urlDecoded(sig), for: Data("cookrew-renew/1 drej dev nonce".utf8)))
  }

  @Test func testTheRenewalMessageIsTheRegistrysByteForByte() {
    #expect(renewMessage(username: "drej", deviceId: "dev", nonce: "n1") == "cookrew-renew/1 drej dev n1")
  }

  @Test func testACodeIsDashedHoweverItWasTyped() {
    #expect(dashedCode("k7qm2xpd") == "K7QM-2XPD")
    #expect(dashedCode("K7QM-2XPD") == "K7QM-2XPD")
  }
}

@Suite struct KeeperTests {
  private let week = 7 * 24 * 3600 * 1000.0

  @Test func testRenewsAWeekOutAndKeepsTheResult() async {
    let api = FakeRegistry()
    let kept = Kept()
    let account = WatchAccount(registry: registry, username: "drej", deviceId: "dev", token: "old", exp: week)
    let keeper = AccountKeeper(account: account, device: WatchDevice(), api: api, now: { 1 }, keep: { kept.accounts.append($0) })
    let token = await keeper.token()
    #expect(token == "fresh")
    #expect(kept.accounts.map(\.token) == ["fresh"])
  }

  @Test func testLeavesAFreshSessionAlone() async {
    let api = FakeRegistry()
    let account = WatchAccount(registry: registry, username: "drej", deviceId: "dev", token: "old", exp: week * 3)
    let keeper = AccountKeeper(account: account, device: WatchDevice(), api: api, now: { 1 }, keep: { _ in })
    let token = await keeper.token()
    #expect(token == "old")
    #expect(api.log.isEmpty)
  }
}

@Suite struct BasesTests {
  @Test func testTheRelayIsTheLastRoadTakenAndCardsStayHomeWhenTheyCan() {
    let relay = URL(string: "https://cookrew.dev/relay/@drej/desktop/\(macId)")!
    let bases = basesAfterJoin(relay: relay, named: [
      Base(kind: "lan", url: "http://192.168.2.40:8639"),
      Base(kind: "name", url: "https://mac.d.cookrew.dev:8643"),
      Base(kind: "lan", url: "http://8.8.8.8:8639")
    ])
    #expect(bases.map(\.url) == ["https://mac.d.cookrew.dev:8643", "http://192.168.2.40:8639", relay.absoluteString])
    #expect(bases.last?.kind == "relay")
  }
}

/** Answers every request from a script, and remembers what it was asked. */
private final class Scripted: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var answers: [(host: String, status: Int, body: String)] = []
  nonisolated(unsafe) static var seen: [URLRequest] = []

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.seen.append(request)
    let host = request.url?.host() ?? ""
    guard let index = Self.answers.firstIndex(where: { $0.host == host }) else {
      client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
      return
    }
    let answer = Self.answers.remove(at: index)
    let response = HTTPURLResponse(url: request.url!, statusCode: answer.status, httpVersion: nil, headerFields: ["content-type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(answer.body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

private final class Pass: RelayPass, @unchecked Sendable {
  let host = "cookrew.dev"
  var renews = true
  var renewed = 0
  func token() async -> String { renewed > 0 ? "fresh" : "stale" }
  func renewNow() async -> Bool {
    renewed += 1
    return renews
  }
}

@Suite(.serialized) struct RelayLineTests {
  private let cardsBody = #"{"cards":[],"activeWorkspaceId":"ws"}"#

  private func line(_ pass: Pass) -> HTTPWatchAPI {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [Scripted.self]
    return HTTPWatchAPI(
      bases: [URL(string: "http://192.168.2.40:8639")!, URL(string: "https://cookrew.dev/relay/@drej/desktop/\(macId)")!],
      token: "mac-token",
      session: URLSession(configuration: config),
      relay: pass
    )
  }

  init() {
    Scripted.answers = []
    Scripted.seen = []
  }

  @Test func testTheAccountCookieGoesToTheRelayAndNowhereElse() async throws {
    Scripted.answers = [("192.168.2.40", 200, cardsBody)]
    _ = try await line(Pass()).cards(tag: nil)
    #expect(Scripted.seen[0].value(forHTTPHeaderField: "cookie") == nil)

    Scripted.seen = []
    Scripted.answers = [("cookrew.dev", 200, cardsBody)]
    let api = line(Pass())
    _ = try await api.cards(tag: nil)
    let relayed = try #require(Scripted.seen.last)
    #expect(relayed.value(forHTTPHeaderField: "cookie") == "__Host-cr_session=stale")
    #expect(relayed.value(forHTTPHeaderField: "authorization") == "Bearer mac-token")
    #expect(api.line == .relay)
  }

  @Test func testAMacOffTheRelayIsUnreachableNotARefusal() async {
    Scripted.answers = [("cookrew.dev", 503, #"{"error":"no_link"}"#)]
    do {
      _ = try await line(Pass()).cards(tag: nil)
      Issue.record("answered")
    } catch {
      #expect(error as? WatchError == .unreachable)
    }
  }

  @Test func testASessionTheRelayRefusesIsRenewedOnceAndAskedAgain() async throws {
    Scripted.answers = [("cookrew.dev", 401, #"{"error":"unauthenticated"}"#), ("cookrew.dev", 200, cardsBody)]
    let pass = Pass()
    _ = try await line(pass).cards(tag: nil)
    #expect(pass.renewed == 1)
    #expect(Scripted.seen.last?.value(forHTTPHeaderField: "cookie") == "__Host-cr_session=fresh")
  }

  @Test func testASessionThatCannotBeRenewedIsSignedOut() async {
    Scripted.answers = [("cookrew.dev", 401, #"{"error":"unauthenticated"}"#)]
    let pass = Pass()
    pass.renews = false
    do {
      _ = try await line(pass).cards(tag: nil)
      Issue.record("answered")
    } catch {
      #expect(error as? WatchError == .signedOut)
    }
  }

  @Test func testTheMacsOwn401StillMeansThisWatchWasForgotten() async {
    Scripted.answers = [("cookrew.dev", 401, #"{"error":"Unauthorized"}"#)]
    do {
      _ = try await line(Pass()).cards(tag: nil)
      Issue.record("answered")
    } catch {
      #expect(error as? WatchError == .unpaired)
    }
  }

  @Test func testAWriteThatTheRelayCouldNotDeliverMovesOn() async throws {
    Scripted.answers = [("cookrew.dev", 503, "{}"), ("192.168.2.40", 200, "{}")]
    let api = HTTPWatchAPI(
      bases: [URL(string: "https://cookrew.dev/relay/@drej/desktop/\(macId)")!, URL(string: "http://192.168.2.40:8639")!],
      token: "mac-token",
      session: { let c = URLSessionConfiguration.ephemeral; c.protocolClasses = [Scripted.self]; return URLSession(configuration: c) }(),
      relay: Pass()
    )
    try await api.stop("agent")
    #expect(Scripted.seen.count == 2)
  }
}
