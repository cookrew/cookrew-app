import XCTest

// The owner's report (11-10): "more" on one real reply (Chinese, markdown) cannot
// be pressed on the wrist. The probe's long card carries that reply verbatim (-mine).

final class MineTests: XCTestCase {
  private var app: XCUIApplication!

  override func setUp() {
    continueAfterFailure = false
    app = XCUIApplication()
    app.launchArguments = ["-mine"] + (ProcessInfo.processInfo.environment["PROBE_SMALL"] == "1" ? ["-small"] : [])
    app.launch()
  }

  private func shot(_ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func control(_ word: String) -> XCUIElement {
    let button = app.buttons[word]
    return button.exists ? button : app.staticTexts[word]
  }

  func testMoreOpensTheRealReply() {
    let seat = app.buttons["Longer, done"]
    XCTAssertTrue(seat.waitForExistence(timeout: 10), app.debugDescription)
    seat.tap()
    usleep(1_000_000)
    shot("1-card")
    let more = control("more")
    XCTAssertTrue(more.waitForExistence(timeout: 5), "no more at all:\n\(app.debugDescription)")
    let reply = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Reply'")).firstMatch
    print("MORE frame \(more.frame) hittable \(more.isHittable) screen \(app.frame) reply \(reply.exists ? "\(reply.frame)" : "?")")
    // Where the word is drawn, as a finger finds it.
    let frame = more.frame
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.minX + 12, dy: frame.minY + 8)).tap()
    usleep(800_000)
    shot("2-after-more")
    print("TREE after more:\n\(app.debugDescription)")
    let reader = app.otherElements["reply-reader"].exists ? app.otherElements["reply-reader"] : app.scrollViews["reply-reader"]
    XCTAssertTrue(reader.waitForExistence(timeout: 3), "more did not open the reader")
    // The reply is one text: the crown must carry its last line onto the screen.
    let body = app.staticTexts.matching(NSPredicate(format: "label CONTAINS '这比在手机上掐表准确得多'")).firstMatch
    XCTAssertTrue(body.exists, "the reader does not hold the whole reply")
    let top = body.frame.minY
    print("READER body \(body.frame) screen \(app.frame)")
    for _ in 0..<20 where body.frame.maxY > app.frame.maxY {
      XCUIDevice.shared.rotateDigitalCrown(delta: 1.0)
      usleep(700_000)
    }
    print("READER after crown \(body.frame)")
    shot("3-reader-end")
    XCTAssertLessThan(body.frame.minY, top, "the crown did not scroll the reader")
    XCTAssertLessThanOrEqual(body.frame.maxY, app.frame.maxY + 1, "the crown did not reach the end of the reply")
  }
}
