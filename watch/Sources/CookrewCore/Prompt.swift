import Foundation

// THE BOX AT THE FOOT OF A CARD, read as the Mac reads it
// (src/renderer/src/prompt/prompt-words.ts, send-plan.ts).

public enum BoxTarget: Equatable, Sendable {
  /** Words go to the agent's input line. */
  case reply(String)
  /** Words go into the menu's row to type in. */
  case menuWords(String)
  /** A menu with no row to type in: the rows are the answer, and words would pick the cursor row. */
  case rowsOnly
  /** Words make a new agent. */
  case newAgent
}

public func boxTarget(for card: Card?) -> BoxTarget {
  guard let card else { return .newAgent }
  guard let choice = card.choice else { return .reply(card.id) }
  return choice.hasWordsRow ? .menuWords(card.id) : .rowsOnly
}

/** The empty box says who the words go to. */
public func placeholder(for card: Card?) -> String {
  guard let card else { return "Describe a task for a new agent…" }
  if card.status == .offline { return "\(card.name) is asleep · wakes on send" }
  if card.choice?.hasWordsRow == true { return "Or type your own answer…" }
  return card.status == .waiting ? "Answer \(card.name)…" : "Reply to \(card.name)…"
}

/**
 * The same words in the box's narrow row on a watch: the card's head already
 * names the agent, and its face rides in the box.
 */
public func boxWords(for card: Card?) -> String {
  guard let card else { return "Describe a task…" }
  if card.status == .offline { return "Wakes on send…" }
  if card.choice?.hasWordsRow == true { return "Your own answer…" }
  return card.status == .waiting ? "Answer…" : "Reply…"
}

/** What a wrist can say without saying it, to an agent asking a free question. */
public func quickWords(for card: Card) -> [String] {
  card.status == .waiting && card.choice == nil ? ["Yes", "No", "Go on"] : []
}

/** The face's seed: two agents on one harness are not one brushstroke. */
public func inkSeed(_ id: String) -> Int {
  var h = 7
  for unit in id.utf16 { h = (h * 17 + Int(unit)) % 23 }
  return 5 + h
}

/** Which mark a preset draws: by its name, else the shell prompt. */
public func harnessMark(_ preset: String) -> InkMark {
  let p = preset.lowercased()
  if p.contains("claude") { return .claude }
  if p.contains("codex") { return .codex }
  if p.contains("opencode") { return .opencode }
  if p == "pi" || p.hasPrefix("pi ") || p.contains("pi agent") || p == "pi-agent" { return .pi }
  return .shell
}
