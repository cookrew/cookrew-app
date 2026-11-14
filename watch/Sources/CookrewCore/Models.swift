import Foundation

// The cards as /api/watch/cards says them (src/main/watch-cards.ts). A test on
// each side holds this to one fixture: watch/Fixtures/cards.json.

/** What an ink face draws (src/renderer/src/zoom/ink-status.ts). */
public enum CardStatus: String, Decodable, Sendable {
  case idle, working, waiting, done, offline
}

public struct CardWords: Decodable, Equatable, Sendable {
  public enum Tone: String, Decodable, Sendable { case working, waiting, done }
  public let text: String
  public let tone: Tone
  public let full: String?

  public init(text: String, tone: Tone, full: String? = nil) {
    self.text = text
    self.tone = tone
    self.full = full
  }

  /** The whole message, however much of it there is. */
  public var whole: String { full ?? text }
}

/** A row of the menu an agent waits on (src/shared/wait-choice.ts). */
public struct WaitOption: Decodable, Equatable, Sendable {
  public enum Role: String, Decodable, Sendable { case toggle, type, submit, chat }
  public let key: String
  public let label: String
  public let detail: String?
  public let role: Role?
  public let checked: Bool?

  public init(key: String, label: String, detail: String? = nil, role: Role? = nil, checked: Bool? = nil) {
    self.key = key
    self.label = label
    self.detail = detail
    self.role = role
    self.checked = checked
  }

  /** A tick, or a move to the row to type in: the menu stays, showing what changed. */
  public var staysOpen: Bool { role == .toggle || role == .type }
}

public struct WaitSteps: Decodable, Equatable, Sendable {
  public let done: Int
  public let total: Int
}

public struct WaitChoice: Decodable, Equatable, Sendable {
  public let id: String
  public let kind: String
  public let question: String
  public let sub: String?
  public let options: [WaitOption]
  public let cursor: Int?
  public let escIndex: Int?
  public let steps: WaitSteps?

  public init(id: String, kind: String = "menu", question: String, sub: String? = nil, options: [WaitOption], cursor: Int? = nil, escIndex: Int? = nil, steps: WaitSteps? = nil) {
    self.id = id
    self.kind = kind
    self.question = question
    self.sub = sub
    self.options = options
    self.cursor = cursor
    self.escIndex = escIndex
    self.steps = steps
  }

  /** The menu has a row to type in: the box's words are its answer. */
  public var hasWordsRow: Bool { options.contains { $0.role == .type } }

  /** One question, wherever its cursor stands: an answered one is known when it shows again. */
  public var signature: String {
    ([kind, question, sub ?? ""] + options.map { "\($0.checked == true ? "✓" : "")\($0.label)" }).joined(separator: "\u{0}")
  }
}

public struct CardItem: Decodable, Equatable, Identifiable, Sendable {
  public enum Kind: String, Decodable, Sendable { case browser, note }
  public let id: String
  public let kind: Kind
  public let title: String
  public let host: String
  public let tint: String
  public let initial: String

  public init(id: String, kind: Kind, title: String, host: String, tint: String, initial: String) {
    self.id = id
    self.kind = kind
    self.title = title
    self.host = host
    self.tint = tint
    self.initial = initial
  }
}

public struct CardWorkspace: Decodable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let active: Bool

  public init(id: String, name: String, active: Bool) {
    self.id = id
    self.name = name
    self.active = active
  }
}

public struct Card: Decodable, Equatable, Identifiable, Sendable {
  public let id: String
  public let name: String
  public let preset: String
  public let orch: Bool
  public let workspace: CardWorkspace
  public let status: CardStatus
  public let word: String
  public let words: CardWords?
  public let about: String?
  public let choice: WaitChoice?
  public let items: [CardItem]
  public let browsers: Int
  public let notes: Int
  public let at: Double

  public init(id: String, name: String, preset: String = "Claude Code", orch: Bool = false, workspace: CardWorkspace = CardWorkspace(id: "w", name: "Cookrew Dev", active: true), status: CardStatus, word: String, words: CardWords? = nil, about: String? = nil, choice: WaitChoice? = nil, items: [CardItem] = [], browsers: Int = 0, notes: Int = 0, at: Double = 0) {
    self.id = id
    self.name = name
    self.preset = preset
    self.orch = orch
    self.workspace = workspace
    self.status = status
    self.word = word
    self.words = words
    self.about = about
    self.choice = choice
    self.items = items
    self.browsers = browsers
    self.notes = notes
    self.at = at
  }
}

/** One workspace on the Mac, counted (src/main/watch-cards.ts · watchWorkspaces). */
public struct WorkspaceTile: Decodable, Equatable, Identifiable, Sendable {
  public let id: String
  public let name: String
  public let active: Bool
  public let agents: Int
  public let waiting: Int
  public let working: Int
  public let done: Int
  /** The compact avatar data, present on newer desktops and empty on older ones. */
  public let presets: [String]
  public let artifacts: [CardItem]

  public init(id: String, name: String, active: Bool, agents: Int, waiting: Int, working: Int, done: Int, presets: [String] = [], artifacts: [CardItem] = []) {
    self.id = id
    self.name = name
    self.active = active
    self.agents = agents
    self.waiting = waiting
    self.working = working
    self.done = done
    self.presets = presets
    self.artifacts = artifacts
  }

  private enum CodingKeys: String, CodingKey {
    case id, name, active, agents, waiting, working, done, presets, artifacts
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(String.self, forKey: .id)
    name = try values.decode(String.self, forKey: .name)
    active = try values.decode(Bool.self, forKey: .active)
    agents = try values.decode(Int.self, forKey: .agents)
    waiting = try values.decode(Int.self, forKey: .waiting)
    working = try values.decode(Int.self, forKey: .working)
    done = try values.decode(Int.self, forKey: .done)
    presets = try values.decodeIfPresent([String].self, forKey: .presets) ?? []
    artifacts = try values.decodeIfPresent([CardItem].self, forKey: .artifacts) ?? []
  }
}

public struct CardsReply: Decodable, Equatable, Sendable {
  public let cards: [Card]
  public let activeWorkspaceId: String
  /** Every workspace on the Mac. A Mac older than the zoom sends none. */
  public let workspaces: [WorkspaceTile]?
  /** What the machine is (its process.platform). An older one does not say. */
  public let platform: String?

  public init(cards: [Card], activeWorkspaceId: String, workspaces: [WorkspaceTile]? = nil, platform: String? = nil) {
    self.cards = cards
    self.activeWorkspaceId = activeWorkspaceId
    self.workspaces = workspaces
    self.platform = platform
  }
}

/**
 * The word for the machine, as the desktop says it (src/shared/machine-words.ts):
 * Cookrew runs on a Mac, a PC or a Linux machine. Before the wrist has heard
 * which, a computer.
 */
public func machineWord(_ platform: String?) -> String {
  switch platform {
  case nil: return "computer"
  case "darwin": return "Mac"
  case "win32": return "PC"
  default: return "machine"
  }
}

/** The tiles an old Mac never sent, counted from its cards, in the order they came. */
public func tilesFrom(_ cards: [Card]) -> [WorkspaceTile] {
  var order: [CardWorkspace] = []
  var byId: [String: [Card]] = [:]
  for card in cards {
    if byId[card.workspace.id] == nil { order.append(card.workspace) }
    byId[card.workspace.id, default: []].append(card)
  }
  return order.map { workspace in
    let crew = byId[workspace.id] ?? []
    let count = { (status: CardStatus) in crew.filter { $0.status == status }.count }
    return WorkspaceTile(
      id: workspace.id,
      name: workspace.name,
      active: workspace.active,
      agents: crew.count,
      waiting: count(.waiting),
      working: count(.working),
      done: count(.done),
      presets: crew.map(\.preset),
      artifacts: Array(crew.flatMap(\.items).prefix(3))
    )
  }
}

/** Adds the workspace avatar's compact data to a newer desktop's count tiles. */
public func tilesWithAvatar(_ tiles: [WorkspaceTile], cards: [Card]) -> [WorkspaceTile] {
  let derived = Dictionary(grouping: cards, by: { $0.workspace.id })
  return tiles.map { tile in
    guard let crew = derived[tile.id], !crew.isEmpty else { return tile }
    return WorkspaceTile(
      id: tile.id,
      name: tile.name,
      active: tile.active,
      agents: tile.agents,
      waiting: tile.waiting,
      working: tile.working,
      done: tile.done,
      presets: crew.map(\.preset),
      artifacts: Array(crew.flatMap(\.items).prefix(3))
    )
  }
}

/**
 * The tiles in the account's order. A workspace the account knows and the Mac
 * did not count has no agents on the board; one the account has not heard of
 * yet still shows, last.
 */
public func mergedTiles(_ tiles: [WorkspaceTile], names: [MachineWorkspace]) -> [WorkspaceTile] {
  guard !names.isEmpty else { return tiles }
  let named = names.map { name in
    tiles.first { $0.id == name.id } ?? WorkspaceTile(id: name.id, name: name.name, active: false, agents: 0, waiting: 0, working: 0, done: 0)
  }
  return named + tiles.filter { tile in !names.contains { $0.id == tile.id } }
}

/** A workspace by name, as the account lists it. */
public struct MachineWorkspace: Decodable, Equatable, Sendable {
  public let id: String
  public let name: String

  public init(id: String, name: String) {
    self.id = id
    self.name = name
  }
}

/** A Mac on the account (registry GET /v2/me/desktops · src/shared/zoom-fleet.ts). */
public struct WatchMachine: Decodable, Equatable, Identifiable, Sendable {
  public let id: String
  public let name: String
  public let online: Bool
  public let workspaces: [MachineWorkspace]
  /** Its platform, from the profile it publishes; nil when it publishes none. */
  public let os: String?

  public init(id: String, name: String, online: Bool, workspaces: [MachineWorkspace], os: String? = nil) {
    self.id = id
    self.name = name
    self.online = online
    self.workspaces = workspaces
    self.os = os
  }

  private enum Keys: String, CodingKey { case id, deviceId, name, online, workspaces, profile }
  private struct Profile: Decodable { let os: String? }

  public init(from decoder: Decoder) throws {
    let row = try decoder.container(keyedBy: Keys.self)
    // A registry older than the fleet rows says only deviceId.
    guard let id = try row.decodeIfPresent(String.self, forKey: .id) ?? row.decodeIfPresent(String.self, forKey: .deviceId) else {
      throw DecodingError.keyNotFound(Keys.id, .init(codingPath: row.codingPath, debugDescription: "no id"))
    }
    self.id = id
    name = try row.decode(String.self, forKey: .name)
    online = (try? row.decodeIfPresent(Bool.self, forKey: .online)) == true
    workspaces = (try? row.decodeIfPresent([MachineWorkspace].self, forKey: .workspaces)) ?? []
    os = (try? row.decodeIfPresent(Profile.self, forKey: .profile))?.os
  }
}

/** The Mac a watch is paired with: the one its relay road names. A six-digit pairing has none. */
public func pairedMachineId(_ bases: [Base]) -> String? {
  for base in bases where base.kind == "relay" {
    // The relay road ends `…/api/m/<machine id>` (Account.swift · relayBase), wherever the registry is mounted.
    let parts = (URL(string: base.url)?.path() ?? "").split(separator: "/")
    if let at = parts.lastIndex(of: "m"), at >= 1, parts[at - 1] == "api", parts.indices.contains(at + 1) { return parts[at + 1].lowercased() }
  }
  return nil
}

/** A way to this Mac, best first (src/main/watch-bases.ts). */
public struct Base: Codable, Equatable, Sendable {
  public let kind: String
  public let url: String

  public init(kind: String, url: String) {
    self.kind = kind
    self.url = url
  }
}

public struct ClaimReply: Decodable, Sendable {
  public let token: String
  public let desktop: String
  public let bases: [Base]
}

public struct NoteBody: Decodable, Equatable, Sendable {
  public let name: String
  public let content: String

  public init(name: String, content: String) {
    self.name = name
    self.content = content
  }
}

/** What a tap on a menu does (src/main/menu-answer.ts · parseMenuRequest). */
public enum MenuAct: Equatable, Sendable {
  case row(Int)
  case esc
  case step(Int)
  case words(String)

  var json: [String: Any] {
    switch self {
    case .row(let index): return ["kind": "row", "index": index]
    case .esc: return ["kind": "esc"]
    case .step(let dir): return ["kind": "step", "dir": dir]
    case .words(let text): return ["kind": "words", "text": text]
    }
  }
}

/** What a wrist does to a browser card (src/main/watch-routes.ts · browserInputOf). */
public enum BrowserInput: Equatable, Sendable {
  /** Fractions of the picture. */
  case tap(x: Double, y: Double)
  case scroll(dy: Double)
  /** A swipe: a share of the picture's height, where the finger was (fractions of the picture). */
  case swipe(share: Double, x: Double, y: Double)
  case text(String)
  case enter

  var json: [String: Any] {
    switch self {
    case .tap(let x, let y): return ["t": "tap", "x": x, "y": y]
    case .scroll(let dy): return ["t": "scroll", "dy": dy]
    // dy is for a Mac too old to read a share: about a laptop window's height.
    case .swipe(let share, let x, let y): return ["t": "scroll", "fy": share, "dy": (share * 800).rounded(), "x": x, "y": y]
    case .text(let text): return ["t": "text", "text": text]
    case .enter: return ["t": "enter"]
    }
  }
}
