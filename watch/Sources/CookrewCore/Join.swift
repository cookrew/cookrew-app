import Foundation

// ONE CODE, TWO DOORS. The code gets the watch into the account at the registry,
// which spends it there; the Mac that minted it kept its own copy (watch-pairing.ts
// · arm), so the same eight characters claim the Mac down the relay. Nothing says
// which Mac: the account lists them, none says it is awake, and only the one
// holding the code answers yes. So the watch simply asks them in turn.

public enum JoinStep: Equatable, Sendable {
  case joining
  case finding
}

public enum JoinFailure: Error, Equatable, Sendable {
  /** Wrong or expired: the registry will not say which. */
  case wrongCode
  /** A Mac no longer holds a code. */
  case ended
  case slow
  /** In the account, but no Mac answered. The code is good for a retry. */
  case macAway
  case noNetwork
  case locked
  /** The account refused this device: the next code goes in under a new one. */
  case newDevice
  case signedOut
}

public enum JoinOutcome: Equatable, Sendable {
  case paired(WatchSession, WatchAccount)
  case failed(JoinFailure)
}

private enum Found {
  case mac(URL, ClaimReply)
  case failed(JoinFailure)
}

/** Ask each Mac in turn; what they all said decides the words. */
private func findMac(code: String, account: WatchAccount, api: RegistryAPI) async -> Found {
  let desktops: [WatchDesktop]
  do {
    desktops = try await api.desktops(token: account.token)
  } catch RegistryError.signedOut {
    return .failed(.signedOut)
  } catch {
    return .failed(.noNetwork)
  }
  var heard: [RegistryError] = []
  for desktop in desktops {
    guard let relay = relayBase(registry: account.registry, username: account.username, desktop: desktop.deviceId) else { continue }
    do {
      return .mac(relay, try await api.claim(relay: relay, code: code, token: account.token))
    } catch RegistryError.signedOut {
      return .failed(.signedOut)
    } catch {
      heard.append(error as? RegistryError ?? .unreachable)
    }
  }
  if heard.contains(.slow) { return .failed(.slow) }
  if heard.contains(.claim("wrong")) { return .failed(.wrongCode) }
  if heard.isEmpty || heard.contains(.unreachable) { return .failed(.macAway) }
  return .failed(.ended)
}

private func failure(of error: Error) -> JoinFailure {
  switch error as? RegistryError {
  case .wrongCode: return .wrongCode
  case .slow: return .slow
  case .locked: return .locked
  case .badDevice: return .newDevice
  default: return .noNetwork
  }
}

/**
 * The whole act. `held` is a session the watch already has: a retry, or a watch
 * pairing again, goes straight to the Mac. `keep` runs the moment the account is
 * joined, since the code is spent by then and cannot get the watch in twice.
 */
public func pairWatch(
  code typed: String,
  held: WatchAccount?,
  device: WatchDevice,
  name: String,
  registry: String,
  api: RegistryAPI,
  now: Double,
  keep: @Sendable (WatchAccount) -> Void,
  step: @Sendable (JoinStep) -> Void
) async -> JoinOutcome {
  let code = dashedCode(typed)
  func enter() async -> Result<WatchAccount, JoinFailure> {
    step(.joining)
    do {
      let reply = try await api.join(code: code, device: device, name: name)
      let account = WatchAccount(registry: registry, username: reply.username, deviceId: reply.deviceId, token: reply.token, exp: reply.exp)
      keep(account)
      return .success(account)
    } catch {
      return .failure(failure(of: error))
    }
  }
  var account: WatchAccount
  let standing = held.flatMap { $0.exp > now ? $0 : nil }
  if let standing {
    account = standing
  } else {
    switch await enter() {
    case .success(let joined): account = joined
    case .failure(let why): return .failed(why)
    }
  }
  step(.finding)
  var found = await findMac(code: code, account: account, api: api)
  // Under a session the watch already held, a refusal may only mean the wrong
  // door: the session ended, or this code is another account's. If the code has
  // not been spent it still gets the watch in, so it has one go at that.
  if case .failed(let why) = found, standing != nil, [.signedOut, .ended, .wrongCode].contains(why) {
    switch await enter() {
    case .success(let joined):
      account = joined
      step(.finding)
      found = await findMac(code: code, account: account, api: api)
    case .failure(let entry):
      return .failed(why == .signedOut || entry == .newDevice ? entry : why)
    }
  }
  switch found {
  case .failed(let why):
    return .failed(why)
  case .mac(let relay, let reply):
    let bases = basesAfterJoin(relay: relay, named: reply.bases)
    return .paired(WatchSession(desktop: reply.desktop, bases: bases, token: reply.token), account)
  }
}

/**
 * The registry spends a code before it answers, so a join whose reply was lost has
 * used the code up. Tried again it reads as wrong, and it was not mistyped.
 */
public func afterLostReply(_ why: JoinFailure, unanswered: Bool) -> JoinFailure {
  unanswered && why == .wrongCode ? .ended : why
}

/** What opens the relay, for HTTPWatchAPI. */
public protocol RelayPass: Sendable {
  var host: String { get }
  var port: Int? { get }
  func token() async -> String
  /** What to try now that the relay refused this token; nil means the session is over. */
  func newer(than token: String) async -> String?
}

/** Whether a keeper still speaks for this watch, asked and acted on under one lock. */
private final class Standing: @unchecked Sendable {
  private let lock = NSLock()
  private var retired = false

  func retire() {
    lock.lock()
    retired = true
    lock.unlock()
  }

  func ifStanding(_ act: () -> Void) {
    lock.lock()
    defer { lock.unlock() }
    if !retired { act() }
  }
}

/** After a renewal fails, how long before asking again: the registry allows five a minute. */
let renewRestMs: Double = 60 * 1000

/**
 * Holds the session and renews it on the device key, a week before it ends, as a
 * Mac does. Never after: a session that has ended was ended by the clock or by
 * "not me", and the key must not bring it back. The registry would allow it; this
 * is the watch's own rule, as it is the Mac's (src/shared/session-renew.ts).
 *
 * One exception, and it is not a revival: a renewal whose reply never came may have
 * closed this token and made one the watch never saw. Then the relay's refusal says
 * nothing about the owner's wishes, so that renewal gets one more try.
 */
public actor AccountKeeper: RelayPass {
  public nonisolated let host: String
  public nonisolated let port: Int?
  private var account: WatchAccount
  private let device: WatchDevice
  private let api: RegistryAPI
  private let now: @Sendable () -> Double
  private let keep: @Sendable (WatchAccount) -> Void
  private var renewing: Task<Bool, Never>?
  private var restUntil: Double = 0
  /** A renewal went out and no answer came back. */
  private var unanswered = false
  /** The relay refused this session and nothing replaced it: only a new code will. */
  private var refused = false
  private nonisolated let standing = Standing()

  public init(
    account: WatchAccount,
    device: WatchDevice,
    api: RegistryAPI,
    now: @escaping @Sendable () -> Double = nowMs,
    keep: @escaping @Sendable (WatchAccount) -> Void
  ) {
    self.host = URL(string: account.registry)?.host() ?? ""
    self.port = URL(string: account.registry)?.port
    self.account = account
    self.device = device
    self.api = api
    self.now = now
    self.keep = keep
  }

  /** The watch has left this session: a renewal still in flight must not write it back. */
  public nonisolated func retire() {
    standing.retire()
  }

  public func token() async -> String {
    if !refused, renewDue(exp: account.exp, now: now()), now() >= restUntil { await renew() }
    return account.token
  }

  public func newer(than token: String) async -> String? {
    if let renewing { _ = await renewing.value }
    if account.token != token { return account.token }
    if unanswered {
      guard account.exp > now(), now() >= restUntil else { return nil }
      if await renew() { return account.token }
      if unanswered { return nil }
    }
    refused = true
    return nil
  }

  /** One at a time: each renewal closes the session before it, and two would race to leave a dead token. */
  @discardableResult public func renew() async -> Bool {
    if let renewing { return await renewing.value }
    let task = Task { await renewOnce() }
    renewing = task
    let done = await task.value
    renewing = nil
    return done
  }

  private func renewOnce() async -> Bool {
    do {
      account = account.renewed(try await api.renew(account: account, device: device))
      unanswered = false
      let renewed = account
      standing.ifStanding { keep(renewed) }
      return true
    } catch RegistryError.signedOut {
      // Not `refused`: a spent nonce answers the same 401, so this rests and asks again.
      unanswered = false
      restUntil = now() + renewRestMs
      return false
    } catch {
      unanswered = true
      restUntil = now() + renewRestMs
      return false
    }
  }
}
