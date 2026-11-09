import CoreGraphics
import Foundation

// THE PICTURE OF A PAGE ON A WRIST: where a tap lands in it, and how far a crown
// turn scrolls it. A page is far wider than a watch, so the picture can be
// looked at closer; a tap still has to land on the page where it was aimed.

/** The largest rect of the picture's shape inside the box, centred. */
public func fitRect(picture: CGSize, in box: CGSize) -> CGRect {
  guard picture.width > 0, picture.height > 0, box.width > 0, box.height > 0 else { return .zero }
  let scale = min(box.width / picture.width, box.height / picture.height)
  let size = CGSize(width: picture.width * scale, height: picture.height * scale)
  return CGRect(x: (box.width - size.width) / 2, y: (box.height - size.height) / 2, width: size.width, height: size.height)
}

/** How the picture stands in its box: `zoom` about the fit's centre, moved by `pan`. */
public struct PictureView: Equatable, Sendable {
  public var zoom: Double
  public var pan: CGSize

  public init(zoom: Double = 1, pan: CGSize = .zero) {
    self.zoom = zoom
    self.pan = pan
  }

  /** The rect the picture covers on screen. */
  public func rect(fit: CGRect) -> CGRect {
    let width = fit.width * zoom
    let height = fit.height * zoom
    return CGRect(x: fit.midX - width / 2 + pan.width, y: fit.midY - height / 2 + pan.height, width: width, height: height)
  }

  /** A pan that leaves no gap the zoom could have filled. */
  public func clamped(fit: CGRect, box: CGSize) -> PictureView {
    let limitX = max(0, (fit.width * zoom - box.width) / 2)
    let limitY = max(0, (fit.height * zoom - box.height) / 2)
    return PictureView(zoom: zoom, pan: CGSize(width: min(limitX, max(-limitX, pan.width)), height: min(limitY, max(-limitY, pan.height))))
  }

  /** A tap as fractions of the picture; nil off it. */
  public func fraction(of point: CGPoint, fit: CGRect) -> CGPoint? {
    let rect = rect(fit: fit)
    guard rect.width > 0, rect.height > 0, rect.contains(point) else { return nil }
    return CGPoint(x: (point.x - rect.minX) / rect.width, y: (point.y - rect.minY) / rect.height)
  }
}

/**
 * A crown turn as a share of the page's picture: the same unit a swipe speaks, so
 * the wrist can move the picture by it at once, and the Mac turns it into the
 * page's own pixels. The crown reports faster than a Mac should be told, so turns
 * add up here and leave a few times a second, none lost.
 */
public struct CrownScroll: Equatable, Sendable {
  /** A picture's height per crown unit: about a laptop wheel notch and a half. */
  public static let sharePerUnit = 0.075
  /** Less than this is not worth a message. */
  private static let least = 0.005
  private var last: Double?
  private var owed = 0.0

  public init() {}

  /** The share this turn moved, for the picture to follow now. */
  @discardableResult
  public mutating func turned(to value: Double) -> Double {
    defer { last = value }
    guard let last else { return 0 }
    let moved = (value - last) * Self.sharePerUnit
    owed += moved
    return moved
  }

  /** What is owed to the Mac; nil when it is nothing worth sending. */
  public mutating func take() -> Double? {
    guard abs(owed) >= Self.least else { return nil }
    defer { owed = 0 }
    return owed
  }
}

/**
 * THE PAGE MOVED ON THE WRIST BEFORE THE MAC'S PICTURE OF IT CAME. A crown turn
 * or a swipe moves the held picture at once, by the share sent; it stands there
 * until the Mac's next picture, which already shows the page moved, and then
 * there is nothing left to move: no snap back, no jump forward. A Mac that never
 * answers does not leave the page shifted for good.
 */
public struct PageDrift: Equatable, Sendable {
  /** Pictures' heights the page has moved that the held picture does not show yet. Down is positive. */
  public private(set) var share = 0.0
  private var since: Date?
  /** How long a move waits for its picture. */
  public static let patience = 3.5
  /** No more than this many screens ahead of the picture. */
  public static let most = 3.0

  public init() {}

  public var waiting: Bool { since != nil }

  public mutating func moved(_ by: Double, at now: Date) {
    share = min(Self.most, max(-Self.most, share + by))
    if since == nil { since = now }
  }

  /** A new picture of the page: the moves are in it. */
  public mutating func pictureCame() {
    share = 0
    since = nil
  }

  public mutating func expire(at now: Date) {
    guard let since, now.timeIntervalSince(since) >= Self.patience else { return }
    pictureCame()
  }
}

/** What a finger on the page does. */
public enum PageTouch: Equatable, Sendable {
  /** The whole page is too small to aim at: look closer, at the spot touched. */
  case aim(PictureView)
  /** Close enough to aim: a click, at these fractions of the picture. */
  case click(CGPoint)
  /** Off the picture. */
  case none
}

/**
 * A TAP ON A WRIST'S PAGE. A desktop page drawn whole on a watch is a seventh of
 * its size, and a finger covers a whole button there: so the first tap looks
 * closer at the spot, centred, and a tap close up is the click.
 */
public func touch(at point: CGPoint, view: PictureView, picture: CGSize, box: CGSize, closeZoom: Double) -> PageTouch {
  let fit = pageFit(picture: picture, in: box)
  guard let at = view.fraction(of: point, fit: fit) else { return .none }
  if view.zoom > 1 { return .click(at) }
  let width = fit.width * closeZoom
  let height = fit.height * closeZoom
  // The spot touched moves to the middle of the box, as far as the page's edges let it.
  let pan = CGSize(
    width: box.width / 2 - at.x * width - (fit.midX - width / 2),
    height: box.height / 2 - at.y * height - (fit.midY - height / 2)
  )
  return .aim(PictureView(zoom: closeZoom, pan: pan).clamped(fit: fit, box: box))
}

/** A swipe as a share of the picture's height: the page moves as far as the finger did on it. Up scrolls down. */
public func swipeShare(_ translation: CGFloat, view: PictureView, picture: CGSize, box: CGSize) -> Double {
  let height = view.rect(fit: pageFit(picture: picture, in: box)).height
  guard height > 0 else { return 0 }
  return Double(-translation / height)
}

/**
 * Where a page stands on a wrist: full width, at the top of its box. A laptop
 * page is wider than a watch is tall, so centred it floated with a gap above
 * and below; at the top it reads like a page, and taps and swipes share it.
 */
public func pageFit(picture: CGSize, in box: CGSize) -> CGRect {
  let fit = fitRect(picture: picture, in: box)
  return CGRect(x: fit.minX, y: 0, width: fit.width, height: fit.height)
}

/** Close up, how far a drag asked to go past the page's top or bottom: that much is a scroll of the page. */
public func panOverflow(_ asked: PictureView, fit: CGRect, box: CGSize) -> CGFloat {
  asked.pan.height - asked.clamped(fit: fit, box: box).pan.height
}

/**
 * HOW OFTEN A WRIST ASKS FOR THE PAGE. The Mac takes a picture of a page at most
 * every few seconds unless a touch asks for one, and every ask is work on the
 * Mac that a phone scrolling the same page is waiting behind. So: slowly at
 * rest, once soon after a touch, and never closer together than the gap, however
 * fast the crown turns.
 */
public struct FramePace: Equatable, Sendable {
  public static let idle = 1.5
  public static let settle = 0.45
  public static let gap = 0.6
  private var last: Date?
  private var wanted: Date?

  public init() {}

  /** Something went to the page: its picture is wanted once it has had time to change. */
  public mutating func sent(at now: Date) {
    if wanted == nil { wanted = now.addingTimeInterval(Self.settle) }
  }

  /** Eager while a moved page waits for its picture: then every gap will do. */
  public func due(_ now: Date, eager: Bool = false) -> Bool {
    guard let last else { return true }
    let since = now.timeIntervalSince(last)
    if since < Self.gap { return false }
    if eager { return true }
    if let wanted, now >= wanted { return true }
    return since >= Self.idle
  }

  public mutating func fetched(at now: Date) {
    last = now
    if let at = wanted, now >= at { wanted = nil }
  }
}
