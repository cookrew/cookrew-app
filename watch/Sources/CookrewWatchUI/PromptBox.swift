import CookrewCore
import SwiftUI

// THE BOX AT THE FOOT, on a wrist: the same chip, the same words saying who they
// go to, the same gold key (src/renderer/src/prompt/GlobalPrompt.tsx). A tap
// opens the system's own input, which is dictation, Scribble and the keyboard in
// one; the words come back into the box and the gold key sends them, because
// what is said to an agent is acted on, and a wrist mishears.

/** The system's text input on a watch; the plain label where there is none. */
struct WordsField<Label: View>: View {
  let prompt: String
  let onWords: (String) -> Void
  @ViewBuilder let label: () -> Label

  var body: some View {
    #if os(watchOS)
      TextFieldLink(prompt: Text(prompt), label: label, onSubmit: onWords)
        .buttonStyle(.plain)
    #else
      label()
    #endif
  }
}

/** The box's height on the glass: the face, the words and the gold key in one slim line. */
let boxHeight: CGFloat = 32

public struct PromptBox: View {
  let store: WatchStore
  /** The card it speaks to; nil on the new agent's page. */
  let card: Card?
  let page: String
  /** Folds the box back into the bar's face (WatchBar.swift): its face, tapped with no words in it. */
  let onFold: (() -> Void)?

  @Environment(\.ink) private var ink

  public init(store: WatchStore, card: Card?, page: String, onFold: (() -> Void)? = nil) {
    self.store = store
    self.card = card
    self.page = page
    self.onFold = onFold
  }

  private var draft: String { store.draft(page) }

  public var body: some View {
    HStack(spacing: 6) {
      // The face folds the box back while it holds no words; with words it is theirs to keep.
      if let onFold, draft.isEmpty {
        Button(action: onFold) { chip.contentShape(Rectangle()) }
          .buttonStyle(.plain)
          .accessibilityLabel("Fold the box")
      } else {
        chip
      }
      WordsField(prompt: placeholder(for: card), onWords: { store.setDraft($0, for: page) }) {
        HStack(spacing: 6) {
          Text(draft.isEmpty ? boxWords(for: card) : draft)
            .font(InkType.box(12.5))
            .foregroundStyle(draft.isEmpty ? ink.muted : ink.ink)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentShape(Rectangle())
      }
      trailing
    }
    .padding(.leading, 5)
    .padding(.trailing, 4)
    // Slim (owner, 11-10): the card's words read in what the head and the box leave.
    .frame(height: boxHeight)
    .background(Capsule().fill(ink.card))
    .overlay(Capsule().strokeBorder(ink.hair2, lineWidth: 1))
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder private var chip: some View {
    if let card {
      InkFace(id: card.id, preset: card.preset, orch: card.orch, status: card.status, size: 22, weight: .small)
    } else {
      Text("＋")
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(ink.sealText)
        .frame(width: 22, height: 22)
    }
  }

  @ViewBuilder private var trailing: some View {
    if !draft.isEmpty {
      Button {
        Task { await store.send(page: page) }
      } label: {
        Image(systemName: "arrow.right")
          .font(.system(size: 13, weight: .bold))
          .foregroundStyle(ink.onGold)
          .frame(width: 25, height: 25)
          .background(Circle().fill(ink.gold))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Send")
    } else if let card, card.status == .working {
      let armed = store.stopArmed(card.id)
      Button {
        Task { await store.stop(card) }
      } label: {
        Text(armed ? "Stop?" : "Esc")
          .font(InkType.word(11))
          .foregroundStyle(armed ? ink.onSeal : ink.soft)
          .frame(height: 25)
          .padding(.horizontal, 8)
          .background(Capsule().fill(armed ? ink.wait : ink.hair))
      }
      .buttonStyle(.plain)
      .accessibilityLabel(armed ? "Tap again to stop \(card.name)" : "Stop \(card.name)")
    }
  }
}
