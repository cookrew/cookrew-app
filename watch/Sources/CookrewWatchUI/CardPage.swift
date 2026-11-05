import CookrewCore
import SwiftUI

// AN AGENT'S CARD ON A WRIST. The parts are the card's own, in its order
// (src/renderer/src/zoom/AgentCard.tsx): the face, name, state and counts; the
// latest words; three thumbnails; the box. A waiting agent's menu stands where
// its words were, in the red frame of the box over the prompt (WaitChoices.tsx).

/** The system clock has the top right of the screen; the head leaves it room. */
let clockRoom: CGFloat = 46

/** Crown-scrolled on a watch; flat where a drawing is made of it. */
struct CardScroll<Content: View>: View {
  @ViewBuilder let content: () -> Content
  @Environment(\.inkStill) private var still

  var body: some View {
    if still {
      Color.clear
        .overlay(alignment: .topLeading) {
          VStack(alignment: .leading, spacing: 0) { content() }
        }
        .clipped()
    } else {
      ScrollView { content() }
    }
  }
}

struct CardHead: View {
  let card: Card
  let onFace: () -> Void
  @Environment(\.ink) private var ink

  private var stateColor: Color {
    switch card.status {
    case .waiting: return ink.wait
    case .done: return ink.sealText
    case .working: return ink.ink
    default: return ink.muted
    }
  }

  var body: some View {
    HStack(alignment: .center, spacing: 7) {
      Button(action: onFace) {
        InkFace(id: card.id, preset: card.preset, orch: card.orch, status: card.status, size: 34, weight: .large)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("All agents")
      VStack(alignment: .leading, spacing: 1) {
        Text(card.name)
          .font(InkType.name())
          .foregroundStyle(ink.ink)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
          .padding(.trailing, clockRoom)
        // The state is the word that must be read; the counts go first.
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 6) {
            state
            counts
          }
          state
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.leading, 11)
    .padding(.trailing, 6)
  }

  private var state: some View {
    Text(card.word.uppercased())
      .font(InkType.word())
      .tracking(1)
      .foregroundStyle(stateColor)
      .fontWeight(card.status == .waiting ? .semibold : .medium)
      .lineLimit(1)
      .fixedSize()
  }

  @ViewBuilder private var counts: some View {
    if card.browsers > 0 || card.notes > 0 {
      HStack(spacing: 5) {
        if card.browsers > 0 { Label2(symbol: "globe", count: card.browsers) }
        if card.notes > 0 { Label2(symbol: "doc.text", count: card.notes) }
      }
      .foregroundStyle(ink.dim)
    }
  }
}

private struct Label2: View {
  let symbol: String
  let count: Int

  var body: some View {
    HStack(spacing: 2) {
      Image(systemName: symbol).font(.system(size: 8.5))
      Text("\(count)").font(InkType.word())
    }
  }
}

/** A reply as a card holds it: inline marks read, a line break kept. */
func marked(_ text: String) -> AttributedString {
  let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
  return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
}

/** The latest words: as many as a card's face holds, the rest a tap away. */
struct CardWordsView: View {
  let card: Card
  let sent: String?
  @Environment(\.ink) private var ink
  @State private var openOn: String?

  private static let folded = 4

  private var whole: String? { card.words?.whole }
  private var open: Bool { whole != nil && openOn == whole }
  /** About this much reads as more than a card's face holds. */
  private var long: Bool { (whole?.count ?? 0) > 110 || (whole?.contains("\n") ?? false) }

  var body: some View {
    if let sent {
      VStack(alignment: .leading, spacing: 2) {
        Text("SENT").font(InkType.word()).tracking(1).foregroundStyle(ink.sealText)
        Text(sent).font(InkType.words(14)).foregroundStyle(ink.soft).lineLimit(3)
      }
    } else if let words = card.words {
      if words.tone == .working {
        VStack(alignment: .leading, spacing: 3) {
          if let about = card.about {
            Text(about).font(InkType.words(14)).foregroundStyle(ink.ink).lineLimit(3)
          }
          Text(words.text).font(InkType.words(13)).italic().foregroundStyle(ink.soft).lineLimit(2)
        }
      } else {
        VStack(alignment: .leading, spacing: 2) {
          Text(marked(words.whole))
            .font(InkType.words())
            .foregroundStyle(ink.ink)
            .lineLimit(open ? nil : Self.folded)
            .fixedSize(horizontal: false, vertical: true)
          if long {
            Text(open ? "less" : "more")
              .font(InkType.word(11))
              .foregroundStyle(ink.sealText)
          }
        }
        .contentShape(Rectangle())
        .onTapGesture {
          if long { openOn = open ? nil : whole }
        }
      }
    } else if let about = card.about {
      Text(about).font(InkType.words(14)).foregroundStyle(ink.soft).lineLimit(4)
    }
  }
}

/** A row of the menu: its key, its words, tapped to answer. */
struct WaitRow: View {
  let choice: WaitChoice
  let index: Int
  let sent: Int?
  let onTap: () -> Void
  @Environment(\.ink) private var ink

  private var option: WaitOption { choice.options[index] }
  private var filled: Bool { sent == index }
  private var spent: Bool { sent != nil && !filled }
  private var isCursor: Bool { index == choice.cursor }

  var body: some View {
    Button(action: onTap) {
      HStack(alignment: .top, spacing: 6) {
        Text(filled ? "✓" : option.role == .submit ? "↵" : option.key)
          .font(InkType.word(11))
          .foregroundStyle(filled ? ink.onSeal : ink.soft)
          .frame(width: 18, height: 18)
          .background(RoundedRectangle(cornerRadius: 4).fill(filled ? ink.seal.opacity(0) : ink.hair))
        VStack(alignment: .leading, spacing: 1) {
          Text(option.label)
            .font(InkType.words(14))
            .foregroundStyle(filled ? ink.onSeal : ink.ink)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
          if index == choice.escIndex {
            Text("esc · then type").font(InkType.word(9.5)).foregroundStyle(filled ? ink.onSeal : ink.dim)
          } else if option.role == .type {
            Text("type · the box ↓").font(InkType.word(9.5)).foregroundStyle(ink.dim)
          } else if let detail = option.detail {
            Text(detail).font(InkType.words(11.5)).foregroundStyle(ink.muted).lineLimit(2)
          }
        }
        Spacer(minLength: 0)
        if let checked = option.checked {
          Image(systemName: checked ? "checkmark.square.fill" : "square")
            .font(.system(size: 14))
            .foregroundStyle(checked ? ink.wait : ink.dim)
        }
      }
      .padding(.vertical, 6)
      .padding(.horizontal, 7)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 8).fill(filled ? ink.seal : ink.card))
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(isCursor && sent == nil ? ink.wait.opacity(0.7) : ink.hair2, lineWidth: 1))
      .opacity(spent ? 0.45 : 1)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(option.key.isEmpty ? "" : "\(option.key): ")\(option.label)")
  }
}

/** The menu an agent waits on: the question, then its rows, in the red frame. */
struct WaitBlock: View {
  let store: WatchStore
  let card: Card
  let view: WaitView
  @Environment(\.ink) private var ink

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(view.choice.question)
        .font(InkType.words(14.5))
        .foregroundStyle(ink.ink)
        .fixedSize(horizontal: false, vertical: true)
      if let sub = view.choice.sub {
        Text(sub).font(InkType.word(10)).foregroundStyle(ink.muted).lineLimit(2)
      }
      if let steps = view.choice.steps {
        HStack {
          Button("‹") { Task { await store.step(card, by: -1) } }.buttonStyle(.plain)
          Text("\(steps.done) of \(steps.total) answered").font(InkType.word())
          Button("›") { Task { await store.step(card, by: 1) } }.buttonStyle(.plain)
        }
        .foregroundStyle(ink.soft)
      }
      ForEach(view.choice.options.indices, id: \.self) { index in
        WaitRow(choice: view.choice, index: index, sent: view.sent) {
          Task { await store.answer(card, row: index) }
        }
      }
    }
    .padding(7)
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(ink.wait, lineWidth: 1.5))
  }
}

/** Words to hand when a question has no menu: a tap fills the box, the gold key sends them. */
struct QuickWords: View {
  let words: [String]
  let onPick: (String) -> Void
  @Environment(\.ink) private var ink

  var body: some View {
    HStack(spacing: 5) {
      ForEach(words, id: \.self) { word in
        Button { onPick(word) } label: {
          Text(word)
            .font(InkType.words(13.5))
            .foregroundStyle(ink.ink)
            .lineLimit(1)
            .frame(maxWidth: .infinity)
            .frame(height: 32)
            .background(Capsule().fill(ink.card))
            .overlay(Capsule().strokeBorder(ink.hair2, lineWidth: 1))
        }
        .buttonStyle(.plain)
      }
    }
  }
}

/** A browser or note on the card's strip, with its coin. */
struct ItemThumb: View {
  let item: CardItem
  @Environment(\.ink) private var ink

  var body: some View {
    ZStack(alignment: .topLeading) {
      RoundedRectangle(cornerRadius: 6).fill(item.kind == .note ? ink.note : ink.card)
      VStack(alignment: .leading, spacing: 3) {
        if item.kind == .browser {
          RoundedRectangle(cornerRadius: 2).fill(Color(css: item.tint)).frame(height: 13)
        }
        RoundedRectangle(cornerRadius: 1).fill(ink.hair2).frame(height: 2.5)
        RoundedRectangle(cornerRadius: 1).fill(ink.hair2).frame(width: 26, height: 2.5)
      }
      .padding(.top, 12)
      .padding(.horizontal, 5)
      coin.offset(x: -3, y: -3)
    }
    .frame(height: 42)
    .frame(maxWidth: .infinity)
    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ink.hair2, lineWidth: 1))
    .accessibilityLabel("\(item.kind.rawValue): \(item.title)")
  }

  private var coin: some View {
    Text(item.kind == .browser ? item.initial : "✎")
      .font(.system(size: 9, weight: .bold, design: .serif))
      .foregroundStyle(ink.onSeal)
      .frame(width: 15, height: 15)
      .background(Circle().fill(item.kind == .browser ? Color(css: item.tint) : ink.seal))
  }
}

public struct CardPage: View {
  let store: WatchStore
  let card: Card
  /** The face was tapped: all agents. */
  let onFace: () -> Void
  /** A thumbnail was tapped. */
  let onItem: (CardItem) -> Void

  @Environment(\.ink) private var ink

  public init(store: WatchStore, card: Card, onFace: @escaping () -> Void, onItem: @escaping (CardItem) -> Void) {
    self.store = store
    self.card = card
    self.onFace = onFace
    self.onItem = onItem
  }

  public var body: some View {
    let wait = store.waitView(card)
    let rowsOnly = boxTarget(for: card) == .rowsOnly
    VStack(spacing: 0) {
      CardHead(card: card, onFace: onFace)
        .padding(.top, 4)
      CardScroll {
        VStack(alignment: .leading, spacing: 8) {
          if let wait {
            WaitBlock(store: store, card: card, view: wait)
          } else if card.choice != nil {
            // The answer went: the agent takes it.
            Text("Answered · the agent goes on").font(InkType.words(13)).italic().foregroundStyle(ink.soft)
          } else {
            CardWordsView(card: card, sent: store.sent(card.id))
          }
          if wait == nil, store.draft(card.id).isEmpty, !quickWords(for: card).isEmpty {
            QuickWords(words: quickWords(for: card)) { store.setDraft($0, for: card.id) }
          }
          if let notice = store.notice, store.page == card.id {
            Text(notice).font(InkType.words(12.5)).foregroundStyle(ink.wait)
          }
          if !card.items.isEmpty, wait == nil {
            HStack(spacing: 6) {
              ForEach(card.items) { item in
                Button { onItem(item) } label: { ItemThumb(item: item) }.buttonStyle(.plain)
              }
              ForEach(card.items.count..<3, id: \.self) { _ in Color.clear.frame(height: 1) }
            }
          }
        }
        .padding(.horizontal, 10)
        .padding(.top, 7)
        .padding(.bottom, 6)
      }
      if !rowsOnly {
        PromptBox(store: store, card: card, page: card.id)
          .padding(.horizontal, 5)
          .padding(.bottom, 5)
      }
    }
    .background(ink.paper)
    .task(id: "\(card.id)|\(card.status.rawValue)") {
      // Looked at for a moment, a reply is read; a crown passing over it is not.
      guard card.status == .done else { return }
      try? await Task.sleep(nanoseconds: UInt64(readSeconds * 1_000_000_000))
      guard !Task.isCancelled, store.page == card.id else { return }
      await store.read(card)
    }
  }
}

/** The page after the last card: the box with nobody on it makes a new agent. */
public struct NewAgentPage: View {
  let store: WatchStore
  @Environment(\.ink) private var ink

  public init(store: WatchStore) {
    self.store = store
  }

  public var body: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 0)
      ZStack {
        Circle().strokeBorder(ink.dim, style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
        Text("＋").font(.system(size: 22)).foregroundStyle(ink.sealText)
      }
      .frame(width: 58, height: 58)
      Text("New agent").font(InkType.name(17)).foregroundStyle(ink.ink).padding(.top, 8)
      if let workspace = store.cards.first(where: { $0.workspace.active })?.workspace.name {
        Text("in \(workspace)").font(InkType.words(13)).foregroundStyle(ink.muted).padding(.top, 1)
      }
      if let sent = store.sent(newAgentPage) {
        Text("Started · \(sent)").font(InkType.words(12.5)).foregroundStyle(ink.sealText).lineLimit(2).padding(.top, 6).padding(.horizontal, 12)
      } else if let notice = store.notice, store.page == newAgentPage {
        Text(notice).font(InkType.words(12.5)).foregroundStyle(ink.wait).padding(.top, 6).padding(.horizontal, 12)
      }
      Spacer(minLength: 0)
      PromptBox(store: store, card: nil, page: newAgentPage)
        .padding(.horizontal, 5)
        .padding(.bottom, 5)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(ink.paper)
  }
}
