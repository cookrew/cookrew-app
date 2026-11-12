import CookrewCore
import SwiftUI

// THE BAR AT THE FOOT OF A WRIST (owner 2026-11-12): the Mac's zoom bar
// (src/renderer/src/zoom/ZoomView.tsx · .zv-controls) with its DEVICES and
// WORKSPACES stops left out, so the rest has the room. One pill:
//
//   ‹  · [ARTIFACTS | AGENTS] ·  face
//
// ‹ is one step out, as the card's head is. The two groups are what needs the
// owner (Bar.swift · barInbox): a face picks that agent's card, a picture opens
// that artifact, and an empty group is its word alone. The face at the end is
// the box, folded into whoever its words go to (prompt/prompt-fold.ts); a tap
// opens it into the box (PromptBox.swift), and its face folds it again. It
// stays open while it holds words.

/** The bar's height: the box's own, so folding it moves nothing. */
private let barFace: CGFloat = 22
private let stackFace: CGFloat = 19

public struct WatchBar: View {
  @Bindable var store: WatchStore
  /** The card the box speaks to; nil on the new agent's page. */
  let card: Card?
  let page: String
  /** One step out; nil where there is nowhere to go. */
  let onOut: (() -> Void)?
  let onItem: (CardItem) -> Void

  @State private var opened: Bool
  @Environment(\.ink) private var ink

  public init(store: WatchStore, card: Card?, page: String, onOut: (() -> Void)?, onItem: @escaping (CardItem) -> Void, open: Bool = false) {
    self.store = store
    self.card = card
    self.page = page
    self.onOut = onOut
    self.onItem = onItem
    _opened = State(initialValue: open)
  }

  private var target: BoxTarget { boxTarget(for: card) }

  public var body: some View {
    Group {
      if boxOpen(draft: store.draft(page), opened: opened, target: target) {
        PromptBox(store: store, card: card, page: page, onFold: { opened = false })
      } else {
        folded
      }
    }
    // Sent: the words left, and the box folds back into the face.
    .onChange(of: store.draft(page).isEmpty) { wasEmpty, isEmpty in
      if isEmpty && !wasEmpty { opened = false }
    }
    // Another page under the crown: its box starts folded.
    .onChange(of: store.page) { _, _ in opened = false }
  }

  private var folded: some View {
    let inbox = barInbox(store.visibleCards, here: page)
    return HStack(spacing: 3) {
      if let onOut {
        Button(action: onOut) {
          Image(systemName: "chevron.left")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ink.sealText)
            .frame(width: 20, height: boxHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Back to the crew")
      }
      groups(inbox)
      Spacer(minLength: 0)
      face
    }
    .padding(.leading, onOut == nil ? 5 : 1)
    .padding(.trailing, 4)
    .frame(height: boxHeight)
    .background(Capsule().fill(ink.card))
    .overlay(Capsule().strokeBorder(ink.hair2, lineWidth: 1))
    .accessibilityElement(children: .contain)
  }

  /** ARTIFACTS first, AGENTS next to the face, in one inner pill, as the Mac's bar draws them. */
  private func groups(_ inbox: BarInbox) -> some View {
    HStack(spacing: 0) {
      ArtifactsGroup(items: inbox.items, onItem: onItem)
      Rectangle().fill(ink.hair2).frame(width: 1, height: 14)
      AgentsGroup(agents: inbox.agents, onPick: { store.page = $0.id }, onCrew: onOut)
    }
    .padding(.horizontal, 2)
    .frame(height: boxHeight - 8)
    .overlay(Capsule().strokeBorder(ink.hair2, lineWidth: 1))
  }

  /** The box, folded: whoever its words go to, a ＋ for a new agent. A menu with rows only takes no words. */
  @ViewBuilder private var face: some View {
    let shut = target == .rowsOnly
    Button { opened = true } label: {
      Group {
        if let card {
          InkFace(id: card.id, preset: card.preset, orch: card.orch, status: card.status, size: barFace, weight: .small)
        } else {
          ZStack {
            Circle().strokeBorder(ink.dim, style: StrokeStyle(lineWidth: 1, dash: [2.5, 2.5]))
            Text("＋").font(.system(size: 12, weight: .medium)).foregroundStyle(ink.sealText)
          }
          .frame(width: barFace, height: barFace)
        }
      }
      .frame(width: 26, height: boxHeight)
      .contentShape(Rectangle())
      .opacity(shut ? 0.4 : 1)
    }
    .buttonStyle(.plain)
    .disabled(shut)
    .accessibilityLabel(shut ? "Answer with a row above" : card.map { "Write to \($0.name)" } ?? "Describe a task for a new agent")
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
  let onCrew: (() -> Void)?

  var body: some View {
    let stack = barStack(agents)
    if stack.shown.isEmpty {
      // Empty, the word is the stop: the crew, as the Mac's AGENTS goes to it.
      Button { onCrew?() } label: { GroupWord(word: "AGENTS").contentShape(Rectangle()) }
        .buttonStyle(.plain)
        .disabled(onCrew == nil)
        .accessibilityLabel("Agents")
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
