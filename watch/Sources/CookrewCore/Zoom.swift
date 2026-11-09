import Foundation

// THE WRIST'S ZOOM: devices → workspaces → agents → one card, as the Mac's and
// the phone's zoom bar walk it (src/shared/zoom-fleet.ts).

/** How far in the wrist is. Kept across launches, so the watch opens where it was left. */
public enum ZoomLevel: Equatable, Hashable, Sendable {
  case devices
  case workspaces
  case agents(String)
  case cards(String)

  public var stored: String {
    switch self {
    case .devices: return "devices"
    case .workspaces: return "workspaces"
    case .agents(let id): return "agents:\(id)"
    case .cards(let id): return "cards:\(id)"
    }
  }

  public init(stored: String) {
    let parts = stored.split(separator: ":", maxSplits: 1).map(String.init)
    switch (parts.first, parts.count > 1 ? parts[1] : "") {
    case ("devices", _): self = .devices
    case ("agents", let id) where !id.isEmpty: self = .agents(id)
    case ("cards", let id) where !id.isEmpty: self = .cards(id)
    default: self = .workspaces
    }
  }

  /** The workspace the cards are read for; nil above them. */
  public var scope: String? {
    switch self {
    case .agents(let id), .cards(let id): return id
    case .devices, .workspaces: return nil
    }
  }

  /** One step out. */
  public var outward: ZoomLevel {
    switch self {
    case .devices, .workspaces: return .devices
    case .agents: return .workspaces
    case .cards(let id): return .agents(id)
    }
  }
}

/** A Mac on the devices stop. */
public struct DeviceRow: Equatable, Identifiable, Sendable {
  public let id: String
  public let name: String
  public let online: Bool
  /** How many the account lists; nil when the wrist has no account to ask. */
  public let workspaces: Int?
  /** The machine the wrist is in now. */
  public let paired: Bool
  /** The watch holds a key for it: a tap goes in. The one it is in is held too. */
  public let held: Bool
  /** Its platform, for the word that names it. */
  public let os: String?

  public init(id: String, name: String, online: Bool, workspaces: Int?, paired: Bool, held: Bool? = nil, os: String? = nil) {
    self.id = id
    self.name = name
    self.online = online
    self.workspaces = workspaces
    self.paired = paired
    self.held = held ?? paired
    self.os = os
  }
}

/**
 * The account's Macs, the paired one first. Its id is the relay road's; a watch
 * paired by six digits has none, so its Mac is found by name, and with no
 * account at all it is the only row. Online, for that one, is what the wrist
 * hears itself.
 */
public func deviceRows(_ machines: [WatchMachine], pairedId: String?, desktop: String, live: Bool, held: Set<String> = []) -> [DeviceRow] {
  let byId = pairedId.flatMap { id in machines.firstIndex { $0.id.lowercased() == id.lowercased() } }
  let found = byId ?? machines.firstIndex { $0.name == desktop }
  let others = machines.indices.filter { $0 != found }.map { at in
    DeviceRow(id: machines[at].id, name: machines[at].name, online: machines[at].online, workspaces: machines[at].workspaces.count, paired: false, held: held.contains(machines[at].id.lowercased()), os: machines[at].os)
  }
  let mine = found.map { machines[$0] }
  let paired = DeviceRow(id: mine?.id ?? "paired", name: mine?.name ?? desktop, online: live, workspaces: mine?.workspaces.count, paired: true, os: mine?.os)
  return [paired] + others
}
