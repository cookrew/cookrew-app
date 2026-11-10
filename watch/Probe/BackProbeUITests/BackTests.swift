import XCTest

// The owner's bug (11-10): on an agent card, pressing back toggles more/less
// instead of going back to the agents view.

final class BackTests: XCTestCase {
  private var app: XCUIApplication!

  override func setUp() {
    continueAfterFailure = false
    app = XCUIApplication()
    app.launch()
  }

  private var depth: String { app.staticTexts["depth"].label }
  private var back: XCUIElement { app.buttons["Back to the crew"] }

  private func openLongCard() {
    let seat = app.buttons["Longer, done"]
    XCTAssertTrue(seat.waitForExistence(timeout: 10), app.debugDescription)
    seat.tap()
    XCTAssertTrue(back.waitForExistence(timeout: 5))
    XCTAssertEqual(depth, "depth 2")
  }

  /** The more/less control, whatever it is drawn as. */
  private func moreControl(_ word: String) -> XCUIElement {
    let button = app.buttons[word]
    return button.exists ? button : app.staticTexts[word]
  }

  private func crown(_ delta: Double) {
    XCUIDevice.shared.rotateDigitalCrown(delta: delta)
    usleep(800_000)
  }

  private func pressBackLikeAFinger() {
    // Where the chevron is drawn, as a finger finds it: not the element's own hit point.
    let frame = back.frame
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.minX + 9, dy: frame.midY)).tap()
    usleep(800_000)
  }

  func testBackFolded() {
    openLongCard()
    pressBackLikeAFinger()
    XCTAssertEqual(depth, "depth 1", "folded: back did not step out")
  }

  func testBackOpenAtTop() {
    openLongCard()
    moreControl("more").tap()
    usleep(600_000)
    XCTAssertTrue(moreControl("less").exists, "more did not open")
    pressBackLikeAFinger()
    XCTAssertEqual(depth, "depth 1", "open, unscrolled: back did not step out")
  }

  func testBackOpenScrolled() {
    openLongCard()
    moreControl("more").tap()
    usleep(600_000)
    crown(0.5)
    let shotScrolled = XCTAttachment(screenshot: app.screenshot())
    shotScrolled.name = "open-scrolled"
    shotScrolled.lifetime = .keepAlways
    add(shotScrolled)
    pressBackLikeAFinger()
    let after = XCTAttachment(screenshot: app.screenshot())
    after.name = "after-back"
    after.lifetime = .keepAlways
    add(after)
    XCTAssertEqual(depth, "depth 1", "open, scrolled: back did not step out")
  }

  func testSwipeRightOverWords() {
    openLongCard()
    moreControl("more").tap()
    usleep(600_000)
    crown(0.3)
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.55)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.57)))
    usleep(800_000)
    XCTAssertEqual(depth, "depth 1", "swipe right over the words did not step out")
  }

  func testBackLandsOnTheCardsFace() {
    app.terminate()
    app.launchArguments = ["-restore"]
    app.launch()
    XCTAssertTrue(back.waitForExistence(timeout: 10))
    XCTAssertEqual(depth, "depth 2")
    pressBackLikeAFinger()
    XCTAssertEqual(depth, "depth 1")
    let face = app.buttons["Filler 30, resting"]
    XCTAssertTrue(face.waitForExistence(timeout: 3))
    XCTAssertTrue(face.isHittable, "the face of the card left is not in view")
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "crew-after-back"
    shot.lifetime = .keepAlways
    add(shot)
  }

  private func relaunch(_ argument: String) {
    app.terminate()
    app.launchArguments = [argument]
    app.launch()
  }

  func testCrewFromAboveStaysAtTheTop() {
    relaunch("-stale")
    let first = app.buttons["Longer, done"]
    XCTAssertTrue(first.waitForExistence(timeout: 10))
    XCTAssertTrue(first.isHittable, "entered from above, the crew did not open at its top")
  }

  func testSwipeOutOfNewAgentLandsOnItsSeat() {
    relaunch("-new-agent")
    XCTAssertTrue(app.buttons["Back to the crew"].waitForExistence(timeout: 10))
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.5)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.52)))
    usleep(800_000)
    XCTAssertEqual(depth, "depth 1", "a swipe right on the new-agent page did not step out")
    let seat = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'New agent'")).firstMatch
    XCTAssertTrue(seat.waitForExistence(timeout: 3))
    XCTAssertTrue(seat.isHittable, "the new-agent seat is not in view")
  }

  func testMoreLessStillWork() {
    openLongCard()
    moreControl("more").tap()
    usleep(600_000)
    XCTAssertTrue(moreControl("less").exists, "more did not open")
    crown(1.5)
    let less = moreControl("less")
    if !less.isHittable { crown(1.5) }
    less.tap()
    usleep(800_000)
    XCTAssertTrue(moreControl("more").exists, "less did not fold")
    XCTAssertTrue(back.isHittable)
    pressBackLikeAFinger()
    XCTAssertEqual(depth, "depth 1")
  }

  func testTapOnTextNearTopDoesNotToggle() {
    openLongCard()
    let before = moreControl("more").exists
    // The first line of the words, just under the head.
    let frame = back.frame
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.midX + 40, dy: frame.maxY + 14)).tap()
    usleep(600_000)
    XCTAssertEqual(depth, "depth 2")
    XCTAssertEqual(moreControl("more").exists, before, "a tap on the text toggled more/less")
  }
}
