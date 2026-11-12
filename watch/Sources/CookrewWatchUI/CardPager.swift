import CookrewCore
import SwiftUI

// ONE WORKSPACE'S CARDS: a page each. The crown walks them up and down; the
// system's bar is hidden, so the way out is the card's own head (chevron +
// face), or a swipe right anywhere on the card. A new agent is the bar's ＋ on
// the stops (WatchBar.swift · HitlBar; owner 2026-11-12), no page of its own.

public struct CardPager: View {
  @Bindable var store: WatchStore
  /** One step out: back to the crew these cards are from. */
  let onOut: () -> Void
  let onItem: (CardItem) -> Void

  public init(store: WatchStore, onOut: @escaping () -> Void, onItem: @escaping (CardItem) -> Void) {
    self.store = store
    self.onOut = onOut
    self.onItem = onItem
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
    }
    // The last card left the workspace, as the Mac answered: back on its crew, where ＋ is.
    .onChange(of: store.link == .live && store.visibleCards.isEmpty) { _, gone in
      if gone { onOut() }
    }
    #if os(watchOS)
      .tabViewStyle(.verticalPage)
      .toolbar(.hidden, for: .navigationBar)
    #endif
  }
}

extension View {
  /**
   * A card uses the whole of the glass: its head sits beside the system's clock,
   * not under it, and its box down in the bottom inset (boxFloor keeps it clear of
   * the corners).
   */
  func wholeGlass() -> some View {
    ignoresSafeArea(.container, edges: [.top, .bottom])
  }
}
