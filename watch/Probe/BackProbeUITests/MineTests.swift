import XCTest

// The owner's real reply (Chinese, markdown) on the long card (-mine): "more"
// opens it where it stands, and the room between the head and the box is what
// the wrist reads it in. That room is printed, so a change to either is measured.

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

  func testMoreOpensTheRealReplyInPlace() {
    let seat = app.buttons["Longer, done"]
    XCTAssertTrue(seat.waitForExistence(timeout: 10), app.debugDescription)
    seat.tap()
    usleep(1_000_000)
    shot("1-card")
    let back = app.buttons["Back to the crew"]
    let box = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Reply'")).firstMatch
    XCTAssertTrue(back.exists && box.exists, app.debugDescription)
    let more = control("more")
    XCTAssertTrue(more.waitForExistence(timeout: 5))
    // Where the word is drawn, as a finger finds it.
    let frame = more.frame
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.minX + 12, dy: frame.minY + 8)).tap()
    usleep(800_000)
    shot("2-open")
    XCTAssertTrue(control("less").exists, "more did not open")
    print("ROOM screen \(app.frame.height) back \(back.frame) box \(box.frame) words \(Int(box.frame.minY - back.frame.maxY)) pt between head and box")
  }
}
