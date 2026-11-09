import CoreGraphics
import Foundation
import Testing
@testable import CookrewCore

@Suite("a finger on a wrist's page")
struct PageTouchTests {
  // A laptop page, drawn whole in a watch's box: it fills the width.
  private let picture = CGSize(width: 1280, height: 800)
  private let box = CGSize(width: 180, height: 140)

  @Test("the whole page is only aimed at: the first tap looks closer, with the spot in the middle")
  func aim() {
    let fit = pageFit(picture: picture, in: box)
    let spot = CGPoint(x: fit.midX + 20, y: fit.midY - 10)
    guard case .aim(let close) = touch(at: spot, view: PictureView(), picture: picture, box: box, closeZoom: 2.6) else {
      Issue.record("expected a look closer")
      return
    }
    #expect(close.zoom == 2.6)
    let before = PictureView().fraction(of: spot, fit: fit)!
    let after = close.fraction(of: CGPoint(x: box.width / 2, y: box.height / 2), fit: fit)!
    #expect(abs(after.x - before.x) < 0.001)
    #expect(abs(after.y - before.y) < 0.001)
  }

  @Test("a spot by the edge comes as near the middle as the page lets it, and no gap shows")
  func edge() {
    guard case .aim(let close) = touch(at: CGPoint(x: 1, y: 70), view: PictureView(), picture: picture, box: box, closeZoom: 2.6) else {
      Issue.record("expected a look closer")
      return
    }
    let rect = close.rect(fit: pageFit(picture: picture, in: box))
    #expect(rect.minX <= 0.001)
  }

  @Test("close up a tap is the click, where it was aimed; off the picture it is nothing")
  func click() {
    let close = PictureView(zoom: 2.6)
    let fit = pageFit(picture: picture, in: box)
    #expect(touch(at: CGPoint(x: fit.midX, y: fit.midY), view: close, picture: picture, box: box, closeZoom: 2.6) == .click(CGPoint(x: 0.5, y: 0.5)))
    // The page stands at the top: below its foot is off the picture.
    #expect(touch(at: CGPoint(x: 90, y: fit.maxY + 5), view: PictureView(), picture: picture, box: box, closeZoom: 2.6) == .none)
  }

  @Test("a swipe up the whole picture scrolls the page down one picture; close up, less")
  func swipe() {
    let fit = pageFit(picture: picture, in: box)
    #expect(abs(swipeShare(-fit.height, view: PictureView(), picture: picture, box: box) - 1) < 0.0001)
    #expect(abs(swipeShare(fit.height, view: PictureView(zoom: 2), picture: picture, box: box) + 0.5) < 0.0001)
  }
}

@Suite("how a page sits and paces on a wrist")
struct PageFitPaceTests {
  private let picture = CGSize(width: 1280, height: 800)
  private let box = CGSize(width: 180, height: 140)

  @Test("a page stands at the top of its box, full width, not floating in the middle")
  func top() {
    let fit = pageFit(picture: picture, in: box)
    #expect(fit.minY == 0)
    #expect(fit.width == 180)
  }

  @Test("close up, a drag past the page's edge is how far to scroll the page; inside it, nothing")
  func overflow() {
    let fit = pageFit(picture: picture, in: box)
    let close = PictureView(zoom: 2.6)
    #expect(panOverflow(PictureView(zoom: 2.6, pan: CGSize(width: 0, height: 10)), fit: fit, box: box) == 0)
    let limit = (fit.height * 2.6 - box.height) / 2
    let past = PictureView(zoom: 2.6, pan: CGSize(width: 0, height: -limit - 40))
    #expect(abs(panOverflow(close.clamped(fit: fit, box: box), fit: fit, box: box)) < 0.001)
    #expect(abs(panOverflow(past, fit: fit, box: box) + 40) < 0.001)
  }

  @Test("pictures are asked for slowly at rest, once soon after a touch, never closer than the gap")
  func pace() {
    let t0 = Date(timeIntervalSince1970: 1000)
    var pace = FramePace()
    #expect(pace.due(t0))
    pace.fetched(at: t0)
    #expect(!pace.due(t0.addingTimeInterval(1)))
    #expect(pace.due(t0.addingTimeInterval(FramePace.idle)))
    pace.sent(at: t0.addingTimeInterval(0.1))
    #expect(!pace.due(t0.addingTimeInterval(0.3)))
    #expect(!pace.due(t0.addingTimeInterval(0.1 + FramePace.settle)))
    #expect(pace.due(t0.addingTimeInterval(FramePace.gap)))
    pace.fetched(at: t0.addingTimeInterval(0.6))
    // A crown turning sends on every beat: the pictures still keep the gap.
    for beat in stride(from: 0.6, to: 3.0, by: 0.25) { pace.sent(at: t0.addingTimeInterval(beat)) }
    #expect(!pace.due(t0.addingTimeInterval(0.6 + FramePace.gap - 0.01)))
  }
}

@Suite("a page moved on the wrist before the Mac's picture comes")
struct PageDriftTests {
  private let t0 = Date(timeIntervalSince1970: 2000)

  @Test("a move stands until the Mac's next picture, which already has it; then nothing is left to move")
  func holds() {
    var drift = PageDrift()
    drift.moved(0.3, at: t0)
    drift.moved(0.2, at: t0.addingTimeInterval(0.2))
    #expect(abs(drift.share - 0.5) < 0.0001)
    drift.expire(at: t0.addingTimeInterval(2))
    #expect(abs(drift.share - 0.5) < 0.0001)
    #expect(drift.waiting)
    drift.pictureCame()
    #expect(drift.share == 0)
    #expect(!drift.waiting)
  }

  @Test("a Mac that never answers does not leave the page shifted for good, and one move is never more than a few screens")
  func expires() {
    var drift = PageDrift()
    drift.moved(9, at: t0)
    #expect(drift.share == PageDrift.most)
    drift.expire(at: t0.addingTimeInterval(PageDrift.patience))
    #expect(drift.share == 0)
  }

  @Test("waiting on a moved page, pictures are asked for at the gap, not at rest's pace")
  func eager() {
    var pace = FramePace()
    pace.fetched(at: t0)
    #expect(!pace.due(t0.addingTimeInterval(FramePace.gap), eager: false))
    #expect(pace.due(t0.addingTimeInterval(FramePace.gap), eager: true))
    #expect(!pace.due(t0.addingTimeInterval(FramePace.gap - 0.01), eager: true))
  }

  @Test("a crown turn is a share of the picture, down for a turn up")
  func crown() {
    var crown = CrownScroll()
    #expect(crown.turned(to: 10) == 0)
    let moved = crown.turned(to: 11)
    #expect(abs(moved - CrownScroll.sharePerUnit) < 0.0001)
    #expect(abs((crown.take() ?? 0) - CrownScroll.sharePerUnit) < 0.0001)
    #expect(crown.take() == nil)
  }
}
