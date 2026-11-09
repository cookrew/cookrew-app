import CoreGraphics
import Testing
@testable import CookrewCore

@Suite("a finger on a wrist's page")
struct PageTouchTests {
  // A laptop page, drawn whole in a watch's box: it fills the width.
  private let picture = CGSize(width: 1280, height: 800)
  private let box = CGSize(width: 180, height: 140)

  @Test("the whole page is only aimed at: the first tap looks closer, with the spot in the middle")
  func aim() {
    let fit = fitRect(picture: picture, in: box)
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
    let rect = close.rect(fit: fitRect(picture: picture, in: box))
    #expect(rect.minX <= 0.001)
  }

  @Test("close up a tap is the click, where it was aimed; off the picture it is nothing")
  func click() {
    let close = PictureView(zoom: 2.6)
    #expect(touch(at: CGPoint(x: 90, y: 70), view: close, picture: picture, box: box, closeZoom: 2.6) == .click(CGPoint(x: 0.5, y: 0.5)))
    #expect(touch(at: CGPoint(x: 90, y: 2), view: PictureView(), picture: picture, box: box, closeZoom: 2.6) == .none)
  }

  @Test("a swipe up the whole picture scrolls the page down one picture; close up, less")
  func swipe() {
    let fit = fitRect(picture: picture, in: box)
    #expect(abs(swipeShare(-fit.height, view: PictureView(), picture: picture, box: box) - 1) < 0.0001)
    #expect(abs(swipeShare(fit.height, view: PictureView(zoom: 2), picture: picture, box: box) + 0.5) < 0.0001)
  }
}
