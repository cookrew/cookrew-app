import CookrewCore
import SwiftUI

// EVERY AGENT AT ONCE: the crew view on a wrist. Faces in rows, by workspace, the
// ones that need the owner first. A tap goes to that card.

public struct CrewGrid: View {
  let store: WatchStore
  let onPick: (String) -> Void
  @Environment(\.ink) private var ink

  public init(store: WatchStore, onPick: @escaping (String) -> Void) {
    self.store = store
    self.onPick = onPick
  }

  private var groups: [(name: String, cards: [Card])] {
    var order: [String] = []
    var byName: [String: [Card]] = [:]
    for card in store.cards {
      if byName[card.workspace.name] == nil { order.append(card.workspace.name) }
      byName[card.workspace.name, default: []].append(card)
    }
    return order.map { ($0, byName[$0] ?? []) }
  }

  public var body: some View {
    CardScroll {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(groups, id: \.name) { group in
          Text(group.name.uppercased())
            .font(InkType.word())
            .tracking(1)
            .foregroundStyle(ink.muted)
            .lineLimit(1)
            .padding(.trailing, clockRoom)
          LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 3), spacing: 8) {
            ForEach(group.cards) { card in
              Button { onPick(card.id) } label: { seat(card) }.buttonStyle(.plain)
            }
          }
        }
      }
      .padding(.horizontal, 10)
      .padding(.top, 6)
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
}
