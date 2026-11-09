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
  var desktopsByToken: [String: [WatchDesktop]] = [:]
  var claims: [String: Result<ClaimReply, RegistryError>] = [:]
  var log: [String] = []

  func join(code: String, device: WatchDevice, name: String) async throws -> JoinReply {
    log.append("join \(code)")
    return try joinResult.get()
  }

  func desktops(token: String) async throws -> [WatchDesktop] {
    log.append("desktops \(token)")
    if let held = desktopsByToken[token] { return held }
    return try desktopsResult.get()
  }

  func claim(relay: URL, code: String, token: String) async throws -> ClaimReply {
    log.append("claim \(relay.absoluteString) \(code)")
    let id = relay.lastPathComponent
    guard let result = claims[id] else { throw RegistryError.claim("no-code") }
    return try result.get()
  }

  var renewFails = false
  var renewRefused = false

  func renew(account: WatchAccount, device: WatchDevice) async throws -> Renewed {
    log.append("renew")
    await Task.yield()
    if renewRefused { throw RegistryError.signedOut }
    if renewFails { throw RegistryError.unreachable }
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

  @Test func testACodeFromAnotherAccountGetsInWhenEveryHeldMacRefuses() async {
    let api = FakeRegistry()
    let otherMac = "33333333-3333-4333-8333-333333333333"
    api.joinResult = .success(JoinReply(token: "other", exp: 5_000, deviceId: "dev", username: "sam"))
    api.desktopsByToken["other"] = [WatchDesktop(deviceId: otherMac, name: "Theirs")]
    api.claims[macId] = .failure(.claim("no-code"))
    api.claims[otherMac] = .success(reply)
    guard case .paired(_, let account) = await pair(api, held: held) else { Issue.record("second try"); return }
    #expect(account.username == "sam")
  }

  @Test func testASpentCodeUnderAHeldSessionKeepsTheMacsWords() async {
    let api = FakeRegistry()
    api.claims[macId] = .failure(.claim("no-code"))
    api.joinResult = .failure(.wrongCode)
    let outcome = await pair(api, held: held)
    #expect(outcome == .failed(.ended))
  }

  @Test func testAHeldDeviceTheNextAccountRefusesIsSaidSoTheNextCodeGoesInAsNew() async {
    let api = FakeRegistry()
    api.claims[macId] = .failure(.claim("no-code"))
    api.joinResult = .failure(.badDevice)
    let outcome = await pair(api, held: held)
    #expect(outcome == .failed(.newDevice))
  }

  @Test func testACodeLostWithItsReplyIsSaidToHaveEndedNotBeenMistyped() {
    #expect(afterLostReply(.wrongCode, unanswered: true) == .ended)
    #expect(afterLostReply(.wrongCode, unanswered: false) == .wrongCode)
    #expect(afterLostReply(.macAway, unanswered: true) == .macAway)
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
    #expect(wire["kind"] as? String == "watch")
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

private final class Ticks: @unchecked Sendable {
  var now: Double = 1
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

  @Test func testTwoPollsInTheLastWeekRenewOnce() async {
    let api = FakeRegistry()
    let account = WatchAccount(registry: registry, username: "drej", deviceId: "dev", token: "old", exp: week)
    let keeper = AccountKeeper(account: account, device: WatchDevice(), api: api, now: { 1 }, keep: { _ in })
    async let first = keeper.token()
    async let second = keeper.token()
    let tokens = await [first, second]
    #expect(tokens == ["fresh", "fresh"])
    #expect(api.log == ["renew"])
  }

  @Test func testAFailedRenewalRestsBeforeTryingAgain() async {
    let api = FakeRegistry()
    api.renewFails = true
    let account = WatchAccount(registry: registry, username: "drej", deviceId: "dev", token: "old", exp: week)
    let keeper = AccountKeeper(account: account, device: WatchDevice(), api: api, now: { 1 }, keep: { _ in })
    _ = await keeper.token()
    let token = await keeper.token()
    #expect(token == "old")
    #expect(api.log == ["renew"])
  }

  @Test func testATokenTheRelayRefusedIsReplacedOnlyByOneAlreadyRenewed() async {
    let api = FakeRegistry()
    let account = WatchAccount(registry: registry, username: "drej", deviceId: "dev", token: "old", exp: week * 3)
    let keeper = AccountKeeper(account: account, device: WatchDevice(), api: api, now: { 1 }, keep: { _ in })
    #expect(await keeper.newer(than: "old") == nil)
    #expect(api.log.isEmpty)
    #expect(await keeper.renew())
    #expect(await keeper.newer(than: "old") == "fresh")
  }

  @Test func testARenewalWhoseReplyWasLostIsTriedOnceMoreWhenTheRelayRefuses() async {
    let api = FakeRegistry()
    api.renewFails = true
    let clock = Ticks()
    let account = WatchAccount(registry: registry, username: "drej", deviceId: "dev", token: "old", exp: week)
    let keeper = AccountKeeper(account: account, device: WatchDevice(), api: api, now: { clock.now }, keep: { _ in })
    #expect(await keeper.renew() == false)
    api.renewFails = false
    clock.now += 61_000
    #expect(await keeper.newer(than: "old") == "fresh")
  }

  @Test func testASessionTheRegistryRefusedIsNotBroughtBackOnTheKey() async {
    let api = FakeRegistry()
    let account = WatchAccount(registry: registry, username: "drej", deviceId: "dev", token: "old", exp: week)
    let keeper = AccountKeeper(account: account, device: WatchDevice(), api: api, now: { 1 }, keep: { _ in })
    #expect(await keeper.newer(than: "old") == nil)
    let token = await keeper.token()
    #expect(token == "old")
    #expect(api.log.isEmpty)
  }

  @Test func testARenewalTheRegistryRefusedIsNotTriedAgain() async {
    let api = FakeRegistry()
    api.renewRefused = true
    let clock = Ticks()
    let account = WatchAccount(registry: registry, username: "drej", deviceId: "dev", token: "old", exp: week)
    let keeper = AccountKeeper(account: account, device: WatchDevice(), api: api, now: { clock.now }, keep: { _ in })
    #expect(await keeper.renew() == false)
    clock.now += 61_000
    #expect(await keeper.newer(than: "old") == nil)
    #expect(api.log == ["renew"])
  }

  @Test func testARenewalTheRegistryRefusedRestsLikeAnyOther() async {
    let api = FakeRegistry()
    api.renewRefused = true
    let account = WatchAccount(registry: registry, username: "drej", deviceId: "dev", token: "old", exp: week)
    let keeper = AccountKeeper(account: account, device: WatchDevice(), api: api, now: { 1 }, keep: { _ in })
    _ = await keeper.token()
    _ = await keeper.token()
    #expect(api.log == ["renew"])
  }

  @Test func testAKeeperTheWatchHasLeftWritesNothingBack() async {
    let api = FakeRegistry()
    let kept = Kept()
    let account = WatchAccount(registry: registry, username: "drej", deviceId: "dev", token: "old", exp: week)
    let keeper = AccountKeeper(account: account, device: WatchDevice(), api: api, now: { 1 }, keep: { kept.accounts.append($0) })
    keeper.retire()
    await keeper.renew()
    #expect(kept.accounts.isEmpty)
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

@Suite struct PrivateHostTests {
  @Test func testOnlyARealPrivateAddressCounts() {
    for host in ["192.168.2.40", "10.1.2.3", "172.16.0.1", "100.64.1.2", "127.0.0.1", "localhost", "mac.local"] {
      #expect(isPrivateHost(host), "\(host)")
    }
    for host in ["127.evil.com", "10.1.2.3.evil.com", "192.168.1.1.nip.io", "10.1.2.999", "8.8.8.8", "172.32.0.1"] {
      #expect(!isPrivateHost(host), "\(host)")
    }
  }
}

@Suite struct HelloTests {
  @Test func testAnAnswerThatNeverEndsIsCutOffAtTheDeadline() async {
    let started = Date()
    let answer: Int? = await within(0.05) {
      try? await Task.sleep(nanoseconds: 5_000_000_000)
      return 1
    }
    #expect(answer == nil)
    #expect(Date().timeIntervalSince(started) < 1)
  }

  @Test func testAQuickAnswerGetsThrough() async {
    let answer: Int? = await within(5) { 1 }
    #expect(answer == 1)
  }

  @Test func testTheProofIsTheMacsByteForByte() {
    #expect(helloProof(token: "mac-token", nonce: "nonce-0123456789abcdef") == "cBtQe4csbmPvxeVVg4OJ0NkU0FBGhTBQIZcCGH5GFX8")
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
  /** Hosts that answer a hello without holding the token. */
  nonisolated(unsafe) static var strangers: Set<String> = []

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.seen.append(request)
    let host = request.url?.host() ?? ""
    if request.url?.path().hasSuffix("api/watch/hello") == true {
      let nonce = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value ?? ""
      let proof = Self.strangers.contains(host) ? "nope" : helloProof(token: "mac-token", nonce: nonce)
      let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(#"{"proof":"\#(proof)"}"#.utf8))
      client?.urlProtocolDidFinishLoading(self)
      return
    }
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
  let port: Int? = nil
  var replacement: String? = "fresh"
  var asked = 0
  func token() async -> String { "stale" }
  func newer(than token: String) async -> String? {
    asked += 1
    return replacement
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
    Scripted.strangers = []
  }

  private func relayed(_ request: (URLRequest) -> Bool = { _ in true }) -> [URLRequest] {
    Scripted.seen.filter { $0.url?.path().hasSuffix("api/watch/hello") != true }.filter(request)
  }

  @Test func testTheAccountCookieGoesToTheRelayAndNowhereElse() async throws {
    Scripted.answers = [("192.168.2.40", 200, cardsBody)]
    _ = try await line(Pass()).cards(tag: nil)
    #expect(relayed()[0].value(forHTTPHeaderField: "cookie") == nil)

    Scripted.seen = []
    Scripted.strangers = ["192.168.2.40"]
    Scripted.answers = [("cookrew.dev", 200, cardsBody)]
    let api = line(Pass())
    _ = try await api.cards(tag: nil)
    let carried = try #require(relayed().last)
    #expect(carried.value(forHTTPHeaderField: "cookie") == "__Host-cr_session=stale")
    #expect(carried.value(forHTTPHeaderField: "authorization") == "Bearer mac-token")
    #expect(api.line == .relay)
  }

  @Test func testAMacOffTheRelayIsUnreachableNotARefusal() async {
    Scripted.strangers = ["192.168.2.40"]
    Scripted.answers = [("cookrew.dev", 503, #"{"error":"no_link"}"#)]
    do {
      _ = try await line(Pass()).cards(tag: nil)
      Issue.record("answered")
    } catch {
      #expect(error as? WatchError == .unreachable)
    }
  }

  @Test func testARefusedTokenIsAskedAgainWithTheOneThatReplacedIt() async throws {
    Scripted.strangers = ["192.168.2.40"]
    Scripted.answers = [("cookrew.dev", 401, #"{"error":"unauthenticated"}"#), ("cookrew.dev", 200, cardsBody)]
    let pass = Pass()
    _ = try await line(pass).cards(tag: nil)
    #expect(pass.asked == 1)
    let last = relayed().last
    #expect(last?.value(forHTTPHeaderField: "cookie") == "__Host-cr_session=fresh")
  }

  @Test func testARefusedTokenWithNothingNewerIsSignedOut() async {
    Scripted.strangers = ["192.168.2.40"]
    Scripted.answers = [("cookrew.dev", 401, #"{"error":"unauthenticated"}"#)]
    let pass = Pass()
    pass.replacement = nil
    do {
      _ = try await line(pass).cards(tag: nil)
      Issue.record("answered")
    } catch {
      #expect(error as? WatchError == .signedOut)
    }
  }

  @Test func testTheRetryBeingRefusedIsNotTheMacForgettingThisWatch() async {
    Scripted.strangers = ["192.168.2.40"]
    Scripted.answers = [("cookrew.dev", 401, #"{"error":"unauthenticated"}"#), ("cookrew.dev", 401, #"{"error":"unauthenticated"}"#)]
    do {
      _ = try await line(Pass()).cards(tag: nil)
      Issue.record("answered")
    } catch {
      #expect(error as? WatchError == .signedOut)
    }
  }

  @Test func testAStrangerAtTheOldAddressNeverSeesTheTokenAndCannotUnpair() async throws {
    Scripted.strangers = ["192.168.2.40"]
    Scripted.answers = [("192.168.2.40", 401, #"{"error":"Unauthorized"}"#), ("cookrew.dev", 200, cardsBody)]
    let api = line(Pass())
    _ = try await api.cards(tag: nil)
    #expect(api.line == .relay)
    let heard = Scripted.seen.filter { $0.url?.host() == "192.168.2.40" }
    #expect(heard.count == 1)
    #expect(heard.allSatisfy { $0.url?.path().hasSuffix("api/watch/hello") == true && $0.value(forHTTPHeaderField: "authorization") == nil })
  }

  @Test func testA401FromAPlainRoadIsThatRoadGoneNotTheWatchForgotten() async throws {
    Scripted.answers = [("192.168.2.40", 200, cardsBody)]
    let api = line(Pass())
    _ = try await api.cards(tag: nil)
    #expect(api.line == .direct)
    // Same address, inside the time its proof is believed, and somebody else now.
    Scripted.answers = [("192.168.2.40", 401, #"{"error":"Unauthorized"}"#), ("cookrew.dev", 200, cardsBody)]
    _ = try await api.cards(tag: nil)
    #expect(api.line == .relay)
  }

  @Test func testAWatchThatLostItsAccountStillMakesAPlainRoadProveItself() async {
    Scripted.strangers = ["192.168.2.40"]
    Scripted.answers = [("192.168.2.40", 401, #"{"error":"Unauthorized"}"#)]
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [Scripted.self]
    let api = HTTPWatchAPI(bases: [URL(string: "http://192.168.2.40:8639")!], token: "mac-token", session: URLSession(configuration: config), guarded: true)
    do {
      _ = try await api.cards(tag: nil)
      Issue.record("answered")
    } catch {
      #expect(error as? WatchError == .unreachable)
    }
    #expect(relayed().isEmpty)
  }

  @Test func testAWatchThatStaysHomeStillRenewsOnTime() async throws {
    Scripted.answers = [("192.168.2.40", 200, cardsBody)]
    let registryAPI = FakeRegistry()
    let inTheLastWeek = nowMs() + 24 * 3600 * 1000
    let keeper = AccountKeeper(
      account: WatchAccount(registry: registry, username: "drej", deviceId: "dev", token: "old", exp: inTheLastWeek),
      device: WatchDevice(),
      api: registryAPI,
      keep: { _ in }
    )
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [Scripted.self]
    let api = HTTPWatchAPI(bases: [URL(string: "http://192.168.2.40:8639")!], token: "mac-token", session: URLSession(configuration: config), relay: keeper)
    _ = try await api.cards(tag: nil)
    for _ in 0..<100 where registryAPI.log.isEmpty {
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    #expect(registryAPI.log == ["renew"])
  }

  @Test func testAWriteARelayGatewayDroppedIsNotSentDownTheNextRoad() async {
    Scripted.answers = [("cookrew.dev", 504, "{}"), ("192.168.2.40", 200, "{}")]
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [Scripted.self]
    let api = HTTPWatchAPI(
      bases: [URL(string: "https://cookrew.dev/relay/@drej/desktop/\(macId)")!, URL(string: "http://192.168.2.40:8639")!],
      token: "mac-token",
      session: URLSession(configuration: config),
      relay: Pass()
    )
    do {
      try await api.stop("agent")
      Issue.record("sent")
    } catch {
      #expect(error as? WatchError == .unreachable)
    }
    #expect(relayed().count == 1)
  }

  @Test func testTheMacsOwn401StillMeansThisWatchWasForgotten() async {
    Scripted.strangers = ["192.168.2.40"]
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
    #expect(relayed().count == 2)
  }
}

// One suite with the tests above: Scripted is shared, and suites run side by side.
extension RelayLineTests {
  private var relay: URL { URL(string: "https://cookrew.dev/relay/@drej/desktop/\(macId)")! }

  private func claim(_ status: Int, _ body: String) async -> RegistryError? {
    Scripted.seen = []
    Scripted.strangers = []
    Scripted.answers = [("cookrew.dev", status, body)]
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [Scripted.self]
    let api = HTTPRegistryAPI(origin: URL(string: registry)!, session: URLSession(configuration: config))
    do {
      _ = try await api.claim(relay: relay, code: "K7QM-2XPD", token: "session")
      return nil
    } catch {
      return error as? RegistryError
    }
  }

  @Test func testOnlyTheRelaysOwn401IsADeadSession() async {
    #expect(await claim(401, #"{"error":"unauthenticated"}"#) == .signedOut)
  }

  @Test func testAMacThatKnowsNoWatchRouteIsJustAMacThatSaidNo() async {
    #expect(await claim(401, #"{"error":"Unauthorized — open the pairing URL"}"#) == .claim("no-code"))
  }

  @Test func testAGatewayIsNotAVerdictOnTheCode() async {
    #expect(await claim(502, "{}") == .unreachable)
    #expect(await claim(503, "{}") == .unreachable)
    #expect(await claim(504, "{}") == .unreachable)
  }

  @Test func testTheMacsReasonComesThrough() async {
    #expect(await claim(403, #"{"ok":false,"reason":"wrong"}"#) == .claim("wrong"))
  }
}
