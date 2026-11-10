import CookrewCore
import SwiftUI

// THE AGENTS STOP: one workspace's crew on a wrist, faces in rows, the ones that
// need the owner first. A tap goes in to that card.

public struct CrewGrid: View {
  let store: WatchStore
  /** The page the wrist just stepped out of: its face is brought into view. Nil coming in from above. */
  let left: String?
  let onNewAgent: (() -> Void)?
  let onPick: (String) -> Void
  @Environment(\.ink) private var ink

  public init(store: WatchStore, left: String? = nil, onNewAgent: (() -> Void)? = nil, onPick: @escaping (String) -> Void) {
    self.store = store
    self.left = left
    self.onNewAgent = onNewAgent
    self.onPick = onPick
  }

  /** Waiting first, then the rest as the Mac ordered them. */
  private var crew: [Card] { crewOrder(store.visibleCards) }

  public var body: some View {
    ScrollViewReader { reader in
      grid
        // Back out of a card: its face is in view, however far down the crew it sits.
        // Coming in from the workspaces it stays at the top, where the waiting ones are.
        .onAppear {
          guard let face = faceInView(page: left, crew: crew) else { return }
          reader.scrollTo(face, anchor: .center)
        }
    }
    .background(ink.paper)
  }

  private var grid: some View {
    CardScroll {
      VStack(alignment: .leading, spacing: 8) {
        if crew.isEmpty {
          Text(store.link == .live ? "No agents here" : "Reading the \(store.machine)…")
            .font(InkType.words(13))
            .foregroundStyle(ink.muted)
            .frame(maxWidth: .infinity)
            .padding(.top, 12)
        }
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 3), spacing: 8) {
          ForEach(crew) { card in
            Button { onPick(card.id) } label: { seat(card) }.buttonStyle(.plain).id(card.id)
          }
          if let onNewAgent {
            Button(action: onNewAgent) { newSeat }.buttonStyle(.plain).id(newAgentPage)
          }
        }
      }
      .padding(.horizontal, 10)
      .padding(.bottom, 10)
    }
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
