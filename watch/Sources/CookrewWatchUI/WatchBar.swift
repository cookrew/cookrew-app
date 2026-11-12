import CookrewCore
import SwiftUI

// THE BAR AT THE FOOT OF A WRIST (Bar.swift; owner 2026-11-12, as the phone
// draws it): on every page, and never a way out (that is the top left's).
//
//   HitlBar   the devices, workspaces and crew stops: [ARTIFACTS | AGENTS] · ＋
//             A face opens that agent's card, a picture that artifact; ＋ opens
//             in place into the new agent's box, and folds back once sent.
//   ReplyBar  an agent's card: its box, open, (face) Reply… ➜. A menu with rows
//             only leaves it in place, dimmed: "Pick a row above".

private let barFace: CGFloat = 22
private let stackFace: CGFloat = 19

/** A stop with the HITL bar at its foot, the content above it clipped (a watch's scroll view catches touches past its frame). */
public struct HitlPage<Content: View>: View {
  @Bindable var store: WatchStore
  let onAgent: (Card) -> Void
  let onItem: (CardItem) -> Void
  /** The stop, given the new agent's box: the crew's ＋ seat opens it too. */
  let content: (Binding<Bool>) -> Content
  @State private var newOpen: Bool
  @Environment(\.ink) private var ink

  public init(store: WatchStore, onAgent: @escaping (Card) -> Void, onItem: @escaping (CardItem) -> Void, newOpen: Bool = false, @ViewBuilder content: @escaping (Binding<Bool>) -> Content) {
    self.store = store
    self.onAgent = onAgent
    self.onItem = onItem
    self.content = content
    _newOpen = State(initialValue: newOpen)
  }

  public var body: some View {
    VStack(spacing: 0) {
      content($newOpen)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        .contentShape(Rectangle())
      HitlBar(store: store, newOpen: $newOpen, onAgent: onAgent, onItem: onItem)
        .padding(.horizontal, boxSides)
        .padding(.bottom, boxFloor)
    }
    .background(ink.paper)
    .ignoresSafeArea(.container, edges: .bottom)
  }
}

public struct HitlBar: View {
  @Bindable var store: WatchStore
  @Binding var newOpen: Bool
  let onAgent: (Card) -> Void
  let onItem: (CardItem) -> Void
  @Environment(\.ink) private var ink

  public init(store: WatchStore, newOpen: Binding<Bool>, onAgent: @escaping (Card) -> Void, onItem: @escaping (CardItem) -> Void) {
    self.store = store
    _newOpen = newOpen
    self.onAgent = onAgent
    self.onItem = onItem
  }

  private var open: Bool { boxOpen(draft: store.draft(newAgentPage), opened: newOpen, target: .newAgent) }

  public var body: some View {
    VStack(spacing: 4) {
      line
      if open {
        PromptBox(store: store, card: nil, page: newAgentPage, onFold: { newOpen = false })
      } else {
        folded
      }
    }
    // Sent: the words left, and the box folds back into ＋.
    .onChange(of: store.draft(newAgentPage).isEmpty) { wasEmpty, isEmpty in
      if isEmpty && !wasEmpty { newOpen = false }
    }
  }

  /** One line over the bar: what was just started, why it was not, or where the new agent will be. */
  @ViewBuilder private var line: some View {
    if let sent = store.sent(newAgentPage) {
      note("Started · \(sent)", ink.sealText)
    } else if let notice = store.notice, !store.draft(newAgentPage).isEmpty {
      note(notice, ink.wait)
    } else if open, let workspace = store.newAgentWorkspace {
      note("New agent in \(workspace)", ink.muted)
    }
  }

  private func note(_ words: String, _ color: Color) -> some View {
    Text(words)
      .font(InkType.words(11.5))
      .foregroundStyle(color)
      .lineLimit(1)
      .truncationMode(.tail)
      .padding(.horizontal, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var folded: some View {
    HStack(spacing: 3) {
      groups(barInbox(store.visibleCards, here: nil))
      Spacer(minLength: 0)
      plus
    }
    .padding(.leading, 5)
    .padding(.trailing, 4)
    .frame(height: boxHeight)
    .background(Capsule().fill(ink.card))
    .overlay(Capsule().strokeBorder(ink.hair2, lineWidth: 1))
    .accessibilityElement(children: .contain)
  }

  /** ARTIFACTS first, AGENTS next to ＋, in one inner pill, as the Mac's bar draws them. */
  private func groups(_ inbox: BarInbox) -> some View {
    HStack(spacing: 0) {
      ArtifactsGroup(items: inbox.items, onItem: onItem)
      Rectangle().fill(ink.hair2).frame(width: 1, height: 14)
      AgentsGroup(agents: inbox.agents, onPick: onAgent)
    }
    .padding(.horizontal, 2)
    .frame(height: boxHeight - 8)
    .overlay(Capsule().strokeBorder(ink.hair2, lineWidth: 1))
  }

  /** The box folded: ＋, for a new agent. */
  private var plus: some View {
    Button { newOpen = true } label: {
      ZStack {
        Circle().strokeBorder(ink.dim, style: StrokeStyle(lineWidth: 1, dash: [2.5, 2.5]))
        Text("＋").font(.system(size: 12, weight: .medium)).foregroundStyle(ink.sealText)
      }
      .frame(width: barFace, height: barFace)
      .frame(width: 26, height: boxHeight)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Describe a task for a new agent")
  }
}

/** An agent's card's bar: its box, always open; dimmed where the menu takes rows only. */
public struct ReplyBar: View {
  let store: WatchStore
  let card: Card
  @Environment(\.ink) private var ink

  public init(store: WatchStore, card: Card) {
    self.store = store
    self.card = card
  }

  public var body: some View {
    if barShape(on: card) == .shut {
      shut
    } else {
      PromptBox(store: store, card: card, page: card.id)
    }
  }

  /** Where the box always is, so the bar never jumps: the face and the words pointing up at the rows. */
  private var shut: some View {
    HStack(spacing: 6) {
      InkFace(id: card.id, preset: card.preset, orch: card.orch, status: card.status, size: barFace, weight: .small)
      // No key: nothing here sends, and the words want the room (a 41 mm wrist).
      Text(rowsOnlyWords)
        .font(InkType.box(12.5))
        .foregroundStyle(ink.muted)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.leading, 5)
    .padding(.trailing, 4)
    .frame(height: boxHeight)
    .background(Capsule().fill(ink.card))
    .overlay(Capsule().strokeBorder(ink.hair2, lineWidth: 1))
    .opacity(0.6)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Answer \(card.name) with a row above")
  }
}

/** A group with nothing in it: its word, as the Mac's bar draws an empty stop. */
private struct GroupWord: View {
  let word: String
  @Environment(\.ink) private var ink

  var body: some View {
    Text(word)
      .font(InkType.word(8.5))
      .tracking(0.4)
      .foregroundStyle(ink.soft)
      .lineLimit(1)
      .fixedSize()
      .padding(.horizontal, 5)
  }
}

/** "+N": how many more stand behind the stack. */
private struct MoreCoin: View {
  let more: Int
  @Environment(\.ink) private var ink

  var body: some View {
    if more > 0 {
      Text("+\(more)")
        .font(InkType.word(8.5))
        .foregroundStyle(ink.soft)
        .fixedSize()
        .padding(.leading, 5)
    }
  }
}

private struct ArtifactsGroup: View {
  let items: [CardItem]
  let onItem: (CardItem) -> Void
  @Environment(\.ink) private var ink

  var body: some View {
    let stack = barStack(items)
    if stack.shown.isEmpty {
      GroupWord(word: "ARTIFACTS").opacity(0.7).accessibilityLabel("No artifacts")
    } else {
      HStack(spacing: -3) {
        ForEach(stack.shown) { item in
          Button { onItem(item) } label: { coin(item) }
            .buttonStyle(.plain)
            .accessibilityLabel("Open \(item.kind == .note ? "note" : "browser") \(item.title)")
        }
        MoreCoin(more: stack.more)
      }
      .padding(.horizontal, 4)
    }
  }

  private func coin(_ item: CardItem) -> some View {
    Text(item.kind == .browser ? item.initial : "✎")
      .font(.system(size: 9, weight: .bold, design: .serif))
      .foregroundStyle(ink.onSeal)
      .frame(width: stackFace, height: stackFace)
      .background(RoundedRectangle(cornerRadius: 4).fill(item.kind == .browser ? Color(css: item.tint) : ink.seal))
      .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ink.card, lineWidth: 1))
  }
}

private struct AgentsGroup: View {
  let agents: [Card]
  let onPick: (Card) -> Void

  var body: some View {
    let stack = barStack(agents)
    if stack.shown.isEmpty {
      // Empty, the word alone: nobody needs the owner.
      GroupWord(word: "AGENTS").opacity(0.7).accessibilityLabel("Nobody needs you")
    } else {
      HStack(spacing: -3) {
        ForEach(stack.shown) { card in
          Button { onPick(card) } label: {
            InkFace(id: card.id, preset: card.preset, orch: card.orch, status: card.status, size: stackFace, weight: .small)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("\(card.name), \(card.word)")
        }
        MoreCoin(more: stack.more)
      }
      .padding(.horizontal, 4)
    }
  }
}
