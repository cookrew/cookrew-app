import CoreGraphics
import Foundation
import Testing
@testable import CookrewCore

private func fixture(_ name: String) throws -> Data {
  let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  return try Data(contentsOf: root.appending(path: "Fixtures/\(name)"))
}

@Suite("the two sides of the wire")
struct ContractTests {
  @Test("the cards the Mac writes are the cards the watch reads")
  func cards() throws {
    let reply = try JSONDecoder().decode(CardsReply.self, from: fixture("cards.json"))
    #expect(reply.cards.map(\.id) == ["asking", "replied", "working", "resting", "asleep"])
    let asking = reply.cards[0]
    #expect(asking.status == .waiting)
    #expect(asking.word == "needs you")
    #expect(asking.orch)
    #expect(asking.choice?.question == "Allow this edit?")
    #expect(asking.choice?.options.count == 3)
    #expect(asking.choice?.escIndex == 2)
    #expect(asking.choice?.id.contains("Allow this edit?") == true)
    let replied = reply.cards[1]
    #expect(replied.words?.text == "Merged.")
    #expect(replied.words?.whole == "Merged.\n\nThe tests pass and the app restarted.")
    #expect(replied.items.map(\.kind) == [.browser, .note])
    #expect(reply.cards[4].status == .offline)
  }

  private struct Stroke: Decodable {
    let mark: String
    let width: Double
    let seed: Int
    let dry: Double
    let body: [[Double]]
    let bristles: Int
    let drop: Drop
    struct Drop: Decodable {
      let x: Double
      let y: Double
      let r: Double
    }
  }

  @Test("every mark is the brush's own, point for point")
  func ink() throws {
    let strokes = try JSONDecoder().decode([Stroke].self, from: fixture("ink-marks.json"))
    #expect(strokes.count == 11)
    for expected in strokes {
      let mark = try #require(InkMark(rawValue: expected.mark))
      let stroke = brushStroke(mark, width: expected.width, seed: expected.seed, dry: expected.dry)
      #expect(stroke.body.count == expected.body.count, "\(expected.mark)")
      var worst = 0.0
      for (point, want) in zip(stroke.body, expected.body) {
        worst = max(worst, abs(point.x - want[0]), abs(point.y - want[1]))
      }
      // The fixture is rounded to two places.
      #expect(worst < 0.0101, "\(expected.mark) drifts by \(worst)")
      #expect(abs(stroke.drop.x - expected.drop.x) < 0.001)
      #expect(abs(stroke.dropRadius - expected.drop.r) < 0.001)
      #expect(stroke.bristles.reduce(0) { $0 + $1.count } <= expected.bristles, "\(expected.mark)")
    }
  }

  @Test("a seed is the same seed the Mac gives that id")
  func seed() {
    #expect(inkSeed("bced030a-d731-4d2a-8fda-52b3e24b71a4") == seedOnTheMac("bced030a-d731-4d2a-8fda-52b3e24b71a4"))
    #expect((5...27).contains(inkSeed("交互优化")))
  }

  private func seedOnTheMac(_ id: String) -> Int {
    var h = 7
    for unit in id.utf16 { h = (h * 17 + Int(unit)) % 23 }
    return 5 + h
  }

  @Test("a preset draws its harness")
  func marks() {
    #expect(harnessMark("Claude Code") == .claude)
    #expect(harnessMark("Codex") == .codex)
    #expect(harnessMark("OpenCode") == .opencode)
    #expect(harnessMark("Pi") == .pi)
    #expect(harnessMark("Shell") == .shell)
  }
}
