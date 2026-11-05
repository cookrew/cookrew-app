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
 * A crown turn as wheel distance. The crown reports faster than a Mac should be
 * told, so turns add up here and leave a few times a second, none lost.
 */
public struct CrownScroll: Equatable, Sendable {
  /** Page px per crown unit. */
  public static let pixelsPerUnit = 60.0
  private var last: Double?
  private var owed = 0.0

  public init() {}

  public mutating func turned(to value: Double) {
    if let last { owed += (value - last) * Self.pixelsPerUnit }
    last = value
  }

  /** What is owed, whole px; nil when it is nothing worth sending. */
  public mutating func take() -> Double? {
    let px = owed.rounded()
    guard abs(px) >= 1 else { return nil }
    owed -= px
    return px
  }
}
