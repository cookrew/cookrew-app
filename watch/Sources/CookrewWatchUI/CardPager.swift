import CookrewCore
import SwiftUI

// ONE WORKSPACE'S CARDS: a page each, then a new agent there. The crown walks
// them up and down; the system's bar is hidden, so the way out is the card's
// own head (chevron + face), or a swipe right anywhere on the card.

public struct CardPager: View {
  @Bindable var store: WatchStore
  /** One step out: back to the crew these cards are from. */
  let onOut: () -> Void
  let onItem: (CardItem) -> Void
  let onThisWatch: () -> Void

  public init(store: WatchStore, onOut: @escaping () -> Void, onItem: @escaping (CardItem) -> Void, onThisWatch: @escaping () -> Void = {}) {
    self.store = store
    self.onOut = onOut
    self.onItem = onItem
    self.onThisWatch = onThisWatch
  }

  /** A swipe right across a card: one step out. The pages go up and down, so sideways is free. */
  private var swipeOut: some Gesture {
    DragGesture(minimumDistance: 24).onEnded { drag in
      if isSwipeOut(dx: drag.translation.width, dy: drag.translation.height) { onOut() }
    }
  }

  public var body: some View {
    TabView(selection: $store.page) {
      ForEach(store.visibleCards) { card in
        CardPage(store: store, card: card, onFace: onOut, onItem: onItem)
          .wholeGlass()
          .simultaneousGesture(swipeOut)
          .tag(Optional(card.id))
      }
      NewAgentPage(store: store, onThisWatch: onThisWatch, onOut: onOut)
        .wholeGlass()
        .simultaneousGesture(swipeOut)
        .tag(Optional(newAgentPage))
    }
    #if os(watchOS)
      .tabViewStyle(.verticalPage)
      .toolbar(.hidden, for: .navigationBar)
    #endif
  }
}

extension View {
  /** A card uses the whole of the glass: its head sits beside the system's clock, not under it. */
  func wholeGlass() -> some View {
    ignoresSafeArea(.container, edges: .top)
  }
}
