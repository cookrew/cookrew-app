import CookrewCore
import ImageIO
import SwiftUI

// A CARD'S BROWSER AND NOTE, on a wrist. A browser is a picture of its page: the
// crown scrolls the page, a tap taps it, the magnifier looks closer, and the box
// types into whatever field has the focus. Words typed there go in as a paste,
// the way the phone's do.

func picture(_ data: Data) -> CGImage? {
  guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

/** The picture of the page, and where it stands in its box. */
struct PageFrame: View {
  let image: CGImage
  let view: PictureView
  let box: CGSize

  var body: some View {
    let size = CGSize(width: image.width, height: image.height)
    let rect = view.rect(fit: fitRect(picture: size, in: box))
    Image(decorative: image, scale: 1)
      .resizable()
      .frame(width: rect.width, height: rect.height)
      .clipShape(RoundedRectangle(cornerRadius: 8 * view.zoom))
      .position(x: rect.midX, y: rect.midY)
  }
}

public struct BrowserPage: View {
  let store: WatchStore
  let item: CardItem
  /** A picture to stand with, before any has come. */
  let first: CGImage?

  @Environment(\.ink) private var ink
  @Environment(\.inkStill) private var still
  @Environment(\.scenePhase) private var phase
  @State private var image: CGImage?
  @State private var tag: String?
  @State private var view = PictureView()
  @State private var box: CGSize = .zero
  @State private var dragFrom: CGSize?
  @State private var crownValue = 0.0
  @State private var crown = CrownScroll()
  @State private var words = ""
  @State private var tapped: CGPoint?
  @State private var failed: String?

  private static let closeZoom = 2.6

  public init(store: WatchStore, item: CardItem, first: CGImage? = nil) {
    self.store = store
    self.item = item
    self.first = first
  }

  private var shown: CGImage? { image ?? first }

  private func tap(at point: CGPoint) {
    guard let shown else { return }
    let fit = fitRect(picture: CGSize(width: shown.width, height: shown.height), in: box)
    guard let fraction = view.fraction(of: point, fit: fit) else { return }
    tapped = point
    send(.tap(x: fraction.x, y: fraction.y))
    Task {
      try? await Task.sleep(nanoseconds: 350_000_000)
      tapped = nil
    }
  }

  private func send(_ input: BrowserInput) {
    Task {
      do {
        try await store.client.input(input, to: item.id)
        failed = nil
      } catch WatchError.refused(let why) {
        failed = why
      } catch {
        failed = "The Mac is not answering"
      }
    }
  }

  private func zoomToggle() {
    view = view.zoom > 1 ? PictureView() : PictureView(zoom: Self.closeZoom)
  }

  private var drag: some Gesture {
    DragGesture(minimumDistance: 6)
      .onChanged { value in
        guard view.zoom > 1, let shown else { return }
        let from = dragFrom ?? view.pan
        dragFrom = from
        let next = PictureView(zoom: view.zoom, pan: CGSize(width: from.width + value.translation.width, height: from.height + value.translation.height))
        view = next.clamped(fit: fitRect(picture: CGSize(width: shown.width, height: shown.height), in: box), box: box)
      }
      .onEnded { _ in dragFrom = nil }
  }

  public var body: some View {
    VStack(spacing: 4) {
      HStack(spacing: 5) {
        Text(item.host)
          .font(InkType.word(10))
          .foregroundStyle(ink.muted)
          .lineLimit(1)
          .padding(.trailing, clockRoom)
        Spacer(minLength: 0)
      }
      .padding(.leading, 34)
      .frame(height: 16)
      GeometryReader { geometry in
        ZStack {
          ink.paper
          if let shown {
            PageFrame(image: shown, view: view, box: geometry.size)
          } else {
            Text(failed ?? "Loading the page…").font(InkType.words(13)).foregroundStyle(ink.muted)
          }
          if let tapped {
            Circle().strokeBorder(ink.wait, lineWidth: 2).frame(width: 26, height: 26).position(tapped)
          }
        }
        .contentShape(Rectangle())
        .clipped()
        .gesture(SpatialTapGesture().onEnded { tap(at: $0.location) })
        .simultaneousGesture(drag)
        .onAppear { box = geometry.size }
        .onChange(of: geometry.size) { _, next in box = next }
      }
      .clipShape(RoundedRectangle(cornerRadius: 10))
      .padding(.horizontal, 5)
      .overlay(alignment: .bottomTrailing) {
        Button(action: zoomToggle) {
          Image(systemName: view.zoom > 1 ? "minus.magnifyingglass" : "plus.magnifyingglass")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ink.onSeal)
            .frame(width: 28, height: 28)
            .background(Circle().fill(Color.black.opacity(0.55)))
        }
        .buttonStyle(.plain)
        .padding(.trailing, 10)
        .padding(.bottom, 5)
        .accessibilityLabel(view.zoom > 1 ? "See the whole page" : "Look closer")
      }
      if let failed, shown != nil {
        Text(failed).font(InkType.words(12)).foregroundStyle(ink.wait).lineLimit(1).padding(.horizontal, 10)
      }
      box2
        .padding(.horizontal, 5)
        .padding(.bottom, 5)
    }
    .background(ink.paper)
    .modifier(CrownTurns(value: $crownValue))
    .onChange(of: crownValue) { _, next in crown.turned(to: next) }
    .task(id: "\(item.id)|\(phase == .active)") {
      if phase == .active { await loop() }
    }
  }

  /** The box, speaking to the page. */
  private var box2: some View {
    HStack(spacing: 6) {
      WordsField(prompt: "Type into the page…", onWords: { words = $0 }) {
        Text(words.isEmpty ? "Type…" : words)
          .font(InkType.box(12.5))
          .foregroundStyle(words.isEmpty ? ink.muted : ink.ink)
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(Rectangle())
      }
      Button {
        if words.isEmpty {
          send(.enter)
        } else {
          send(.text(words))
          words = ""
        }
      } label: {
        Image(systemName: words.isEmpty ? "return" : "arrow.right")
          .font(.system(size: 13, weight: .bold))
          .foregroundStyle(words.isEmpty ? ink.soft : ink.onGold)
          .frame(width: 30, height: 30)
          .background(Circle().fill(words.isEmpty ? ink.hair : ink.gold))
      }
      .buttonStyle(.plain)
      .accessibilityLabel(words.isEmpty ? "Enter" : "Type it")
    }
    .padding(.leading, 12)
    .padding(.trailing, 5)
    .frame(height: 40)
    .background(Capsule().fill(ink.card))
    .overlay(Capsule().strokeBorder(ink.hair2, lineWidth: 1))
  }

  /** A fresh picture a little over once a second, and what the crown has turned, while this is on screen. */
  private func loop() async {
    guard !still else { return }
    var beat = 0
    while !Task.isCancelled {
      if let dy = crown.take() { send(.scroll(dy: dy)) }
      if beat % 5 == 0 {
        do {
          let width = Int(max(box.width, 180) * 2)
          if case .new(let data, let next) = try await store.client.frame(item.id, width: width, tag: tag) {
            tag = next
            if let decoded = picture(data) { image = decoded }
          }
          failed = nil
        } catch WatchError.refused(let why) {
          failed = why
        } catch {
          failed = "The Mac is not answering"
        }
      }
      beat += 1
      try? await Task.sleep(nanoseconds: 250_000_000)
    }
  }
}

/** The crown turns a value on a watch; there is no crown anywhere else. */
private struct CrownTurns: ViewModifier {
  @Binding var value: Double

  func body(content: Content) -> some View {
    #if os(watchOS)
      content
        .focusable()
        .digitalCrownRotation($value, from: -1_000_000, through: 1_000_000, sensitivity: .medium, isContinuous: true, isHapticFeedbackEnabled: true)
    #else
      content
    #endif
  }
}

public struct NotePage: View {
  let store: WatchStore
  let item: CardItem
  let first: NoteBody?
  @Environment(\.ink) private var ink
  @State private var note: NoteBody?
  @State private var failed = false

  public init(store: WatchStore, item: CardItem, first: NoteBody? = nil) {
    self.store = store
    self.item = item
    self.first = first
  }

  public var body: some View {
    CardScroll {
      VStack(alignment: .leading, spacing: 6) {
        Text((note ?? first)?.name ?? item.title)
          .font(InkType.name())
          .foregroundStyle(ink.noteText)
          .padding(.leading, 22)
          .padding(.trailing, clockRoom)
        if let body = (note ?? first)?.content {
          Text(marked(body)).font(InkType.words(14)).foregroundStyle(ink.noteText)
        } else {
          Text(failed ? "The Mac is not answering" : "Loading the note…").font(InkType.words(13)).foregroundStyle(ink.muted)
        }
      }
      .padding(.horizontal, 10)
      .padding(.top, 6)
      .padding(.bottom, 12)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(ink.note)
    .task(id: item.id) {
      do {
        note = try await store.client.note(item.id)
      } catch {
        failed = true
      }
    }
  }
}
