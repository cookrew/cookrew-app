import XCTest

// The owner's bugs (11-10): on an agent card, pressing back toggled more/less
// instead of going back to the agents view; and "more" opened the reply under
// the box, where nothing new could be seen. "more" now opens a reader.

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

  /** The reader "more" opens over the card: the whole reply, alone on the screen. */
  private var reader: XCUIElement { app.otherElements["reply-reader"].exists ? app.otherElements["reply-reader"] : app.scrollViews["reply-reader"] }

  /** Press "more" where the word is drawn, as a finger does. */
  private func pressMore() {
    let more = moreControl("more")
    XCTAssertTrue(more.waitForExistence(timeout: 5))
    let frame = more.frame
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.minX + 12, dy: frame.minY + 8)).tap()
    usleep(800_000)
  }

  private func closeReader() {
    // The system draws the sheet's close button; more than one element may carry its name.
    let close = app.buttons["Close"].exists ? app.buttons["Close"].firstMatch : app.buttons["Done"].firstMatch
    XCTAssertTrue(close.waitForExistence(timeout: 3), "no way to close the reader:\n\(app.debugDescription)")
    close.tap()
    usleep(800_000)
  }

  func testMoreOpensTheWholeReply() {
    openLongCard()
    pressMore()
    XCTAssertTrue(reader.waitForExistence(timeout: 3), "more did not open the reader:\n\(app.debugDescription)")
    // The reply is alone on the screen: no box to hide its words under.
    XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Reply'")).firstMatch.isHittable, "the box still covers the reply")
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "reader-top"
    shot.lifetime = .keepAlways
    add(shot)
    // The crown carries the reply's last line onto the screen (the reply is one text).
    let body = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'headless Chrome never turns a touch into a text selection'")).firstMatch
    XCTAssertTrue(body.exists, "the reader does not hold the whole reply")
    let top = body.frame.minY
    for _ in 0..<20 where body.frame.maxY > app.frame.maxY { crown(1.0) }
    XCTAssertLessThan(body.frame.minY, top, "the crown did not scroll the reader")
    XCTAssertLessThanOrEqual(body.frame.maxY, app.frame.maxY + 1, "the crown did not reach the end of the reply")
    closeReader()
    XCTAssertFalse(reader.exists, "the reader did not close")
    XCTAssertEqual(depth, "depth 2", "closing the reader left the card")
    XCTAssertTrue(moreControl("more").exists, "the card is not as it was")
  }

  func testBackAfterReading() {
    openLongCard()
    pressMore()
    XCTAssertTrue(reader.waitForExistence(timeout: 3))
    closeReader()
    pressBackLikeAFinger()
    XCTAssertEqual(depth, "depth 1", "after reading, back did not step out")
  }

  func testSwipeRightOverWords() {
    openLongCard()
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

  func testTapOnTextNearTopDoesNotToggle() {
    openLongCard()
    let before = moreControl("more").exists
    // The first line of the words, just under the head.
    let frame = back.frame
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.midX + 40, dy: frame.maxY + 14)).tap()
    usleep(600_000)
    XCTAssertEqual(depth, "depth 2")
    XCTAssertFalse(reader.exists, "a tap on the text opened the reader")
    XCTAssertEqual(moreControl("more").exists, before, "a tap on the text changed the card")
  }
}
