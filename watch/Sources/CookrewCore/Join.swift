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
  // A session the registry ended on a watch that thought it held one: this code
  // has not been spent, so it can still get the watch back in.
  if case .failed(.signedOut) = found, standing != nil {
    switch await enter() {
    case .success(let joined): account = joined
    case .failure(let why): return .failed(why)
    }
    step(.finding)
    found = await findMac(code: code, account: account, api: api)
  }
  switch found {
  case .failed(let why):
    return .failed(why)
  case .mac(let relay, let reply):
    let bases = basesAfterJoin(relay: relay, named: reply.bases)
    return .paired(WatchSession(desktop: reply.desktop, bases: bases, token: reply.token), account)
  }
}

/** What opens the relay, for HTTPWatchAPI: the session, and renewing it. */
public protocol RelayPass: Sendable {
  var host: String { get }
  func token() async -> String
  func renewNow() async -> Bool
}

/** Holds the session and renews it on the device key, a week out or when refused. */
public actor AccountKeeper: RelayPass {
  public nonisolated let host: String
  private var account: WatchAccount
  private let device: WatchDevice
  private let api: RegistryAPI
  private let now: @Sendable () -> Double
  private let keep: @Sendable (WatchAccount) -> Void

  public init(
    account: WatchAccount,
    device: WatchDevice,
    api: RegistryAPI,
    now: @escaping @Sendable () -> Double = nowMs,
    keep: @escaping @Sendable (WatchAccount) -> Void
  ) {
    self.host = URL(string: account.registry)?.host() ?? ""
    self.account = account
    self.device = device
    self.api = api
    self.now = now
    self.keep = keep
  }

  public func token() async -> String {
    if renewDue(exp: account.exp, now: now()) { _ = await renewNow() }
    return account.token
  }

  public func renewNow() async -> Bool {
    guard let next = try? await api.renew(account: account, device: device) else { return false }
    account = account.renewed(next)
    keep(account)
    return true
  }
}
