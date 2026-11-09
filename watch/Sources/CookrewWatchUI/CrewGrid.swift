import CookrewCore
import SwiftUI

// THE AGENTS STOP: one workspace's crew on a wrist, faces in rows, the ones that
// need the owner first. A tap goes in to that card.

public struct CrewGrid: View {
  let store: WatchStore
  let onNewAgent: (() -> Void)?
  let onPick: (String) -> Void
  @Environment(\.ink) private var ink

  public init(store: WatchStore, onNewAgent: (() -> Void)? = nil, onPick: @escaping (String) -> Void) {
    self.store = store
    self.onNewAgent = onNewAgent
    self.onPick = onPick
  }

  /** Waiting first, then the rest as the Mac ordered them. */
  private var crew: [Card] {
    let cards = store.visibleCards
    return cards.filter { $0.status == .waiting } + cards.filter { $0.status != .waiting }
  }

  public var body: some View {
    CardScroll {
      VStack(alignment: .leading, spacing: 8) {
        if crew.isEmpty {
          Text(store.link == .live ? "No agents here" : "Reading the Mac…")
            .font(InkType.words(13))
            .foregroundStyle(ink.muted)
            .frame(maxWidth: .infinity)
            .padding(.top, 12)
        }
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 3), spacing: 8) {
          ForEach(crew) { card in
            Button { onPick(card.id) } label: { seat(card) }.buttonStyle(.plain)
          }
          if let onNewAgent {
            Button(action: onNewAgent) { newSeat }.buttonStyle(.plain)
          }
        }
      }
      .padding(.horizontal, 10)
      .padding(.bottom, 10)
    }
    .background(ink.paper)
  }

  private func seat(_ card: Card) -> some View {
    VStack(spacing: 2) {
      InkFace(id: card.id, preset: card.preset, orch: card.orch, status: card.status, size: 46, weight: .regular)
      Text(card.name)
        .font(InkType.words(11))
        .foregroundStyle(card.status == .waiting ? ink.wait : ink.ink)
        .lineLimit(1)
    }
    .accessibilityLabel("\(card.name), \(card.word)")
  }

  private var newSeat: some View {
    VStack(spacing: 2) {
      ZStack {
        Circle().strokeBorder(ink.dim, style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
        Text("＋").font(.system(size: 18)).foregroundStyle(ink.sealText)
      }
      .frame(width: 46, height: 46)
      Text("New").font(InkType.words(11)).foregroundStyle(ink.muted).lineLimit(1)
    }
    .accessibilityLabel("New agent")
  }
}
