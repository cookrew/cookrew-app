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

public struct CardsReply: Decodable, Equatable, Sendable {
  public let cards: [Card]
  public let activeWorkspaceId: String
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
  case text(String)
  case enter

  var json: [String: Any] {
    switch self {
    case .tap(let x, let y): return ["t": "tap", "x": x, "y": y]
    case .scroll(let dy): return ["t": "scroll", "dy": dy]
    case .text(let text): return ["t": "text", "text": text]
    case .enter: return ["t": "enter"]
    }
  }
}
