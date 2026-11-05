import CoreGraphics
import Foundation

// INK MARKS: the harness avatars as one brush stroke each, ported line for line
// from src/renderer/src/zoom/ink-marks.ts. A test holds the two to one fixture
// (watch/Fixtures/ink-marks.json), so a face on the wrist is the face on the Mac.

public enum InkMark: String, CaseIterable, Sendable {
  case claude, codex, opencode, pi, shell, enso, ensoClosed, ringWorking, ringWaiting, tick, zee
}

/** Where the corner marks sit: the ensō's top-right shoulder. */
public let inkCorner = CGPoint(x: 86, y: 14)

public struct BrushStroke: Sendable {
  public let body: [CGPoint]
  public let bristles: [[CGPoint]]
  public let drop: CGPoint
  public let dropRadius: Double
}

private typealias Pt = (x: Double, y: Double, p: Double)
private let tau = Double.pi * 2

private func arc(_ cx: Double, _ cy: Double, _ r0: Double, _ a0: Double, _ a1: Double, _ p0: Double = 1, _ p1: Double = 1, _ r1In: Double? = nil) -> [Pt] {
  let r1 = r1In ?? r0
  let n = max(8, Int(ceil(abs(a1 - a0) / 0.12)))
  return (0...n).map { i in
    let u = Double(i) / Double(n)
    let a = a0 + (a1 - a0) * u
    let r = r0 + (r1 - r0) * u
    return (cx + r * cos(a), cy + r * sin(a), p0 + (p1 - p0) * u)
  }
}

/** Catmull-Rom through the control points, sampled by segment length. */
private func spline(_ pts: [Pt]) -> [Pt] {
  var out: [Pt] = []
  for i in 0..<(pts.count - 1) {
    let p1 = pts[i]
    let p0 = i > 0 ? pts[i - 1] : p1
    let p2 = pts[i + 1]
    let p3 = i + 2 < pts.count ? pts[i + 2] : p2
    let len = hypot(p2.x - p1.x, p2.y - p1.y)
    let steps = max(2, Int(ceil(len / 0.8)))
    for s in 0..<steps {
      let t = Double(s) / Double(steps)
      let t2 = t * t
      let t3 = t2 * t
      func c(_ a: Double, _ b: Double, _ d: Double, _ e: Double) -> Double {
        0.5 * (2 * b + (-a + d) * t + (2 * a - 5 * b + 4 * d - e) * t2 + (-a + 3 * b - 3 * d + e) * t3)
      }
      out.append((c(p0.x, p1.x, p2.x, p3.x), c(p0.y, p1.y, p2.y, p3.y), p1.p + (p2.p - p1.p) * t))
    }
  }
  out.append(pts[pts.count - 1])
  return out
}

/** Straight segments with corners rounded by two passes of Chaikin. */
private func linear(_ pts: [Pt]) -> [Pt] {
  var line = pts
  for _ in 0..<2 {
    var next: [Pt] = [line[0]]
    for i in 0..<(line.count - 1) {
      let a = line[i]
      let b = line[i + 1]
      next.append((0.75 * a.x + 0.25 * b.x, 0.75 * a.y + 0.25 * b.y, 0.75 * a.p + 0.25 * b.p))
      next.append((0.25 * a.x + 0.75 * b.x, 0.25 * a.y + 0.75 * b.y, 0.25 * a.p + 0.75 * b.p))
    }
    next.append(line[line.count - 1])
    line = next
  }
  var out: [Pt] = []
  for i in 0..<(line.count - 1) {
    let a = line[i]
    let b = line[i + 1]
    let steps = max(1, Int(ceil(hypot(b.x - a.x, b.y - a.y) / 0.8)))
    for s in 0..<steps {
      let t = Double(s) / Double(steps)
      out.append((a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.p + (b.p - a.p) * t))
    }
  }
  out.append(line[line.count - 1])
  return out
}

/** Even arc-length spacing, so the brush moves at one speed. */
private func resample(_ line: [Pt], step: Double = 0.55) -> [Pt] {
  var out: [Pt] = [line[0]]
  var carry = 0.0
  for i in 1..<line.count {
    let a = line[i - 1]
    let b = line[i]
    let len = hypot(b.x - a.x, b.y - a.y)
    if len == 0 { continue }
    var d = step - carry
    while d <= len {
      let t = d / len
      out.append((a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.p + (b.p - a.p) * t))
      d += step
    }
    carry = len - (d - step)
  }
  out.append(line[line.count - 1])
  return out
}

private let land = -1.95

private func atCorner(_ pts: [Pt]) -> [Pt] {
  pts.map { (inkCorner.x + $0.x, inkCorner.y + $0.y, $0.p) }
}

private func controlLine(_ mark: InkMark) -> [Pt] {
  switch mark {
  case .claude:
    let rays: [Double] = [40, 31, 37, 29, 41, 34, 30, 38, 33, 36, 30]
    var pts: [Pt] = []
    for (k, ray) in rays.enumerated() {
      let a = -Double.pi / 2 + (Double(k) * tau) / Double(rays.count) + (k % 2 != 0 ? 0.05 : -0.04)
      let b = a + tau / Double(rays.count) / 2
      pts.append((50 + 4.5 * cos(a - 0.2), 50 + 4.5 * sin(a - 0.2), 1.05))
      pts.append((50 + ray * cos(a), 50 + ray * sin(a), 0.3))
      pts.append((50 + 4.5 * cos(b), 50 + 4.5 * sin(b), 1.05))
    }
    return linear(pts)
  case .codex:
    let R = 6.0, r = 1.0, d = 2.3, s = 4.4
    let n = 220
    let pts: [Pt] = (0...n).map { i in
      let t = (Double(i) / Double(n)) * tau + 0.35
      let x = (R - r) * cos(t) + d * cos(((R - r) / r) * t)
      let y = (R - r) * sin(t) - d * sin(((R - r) / r) * t)
      let p = 0.55 + 0.45 * abs(sin(3 * t))
      return (50 + s * x, 50 + s * y, i < 6 ? 0.6 + Double(i) * 0.08 : p)
    }
    return linear(pts)
  case .opencode:
    return linear([
      (41, 41, 0.6), (59, 41, 0.95), (59, 59, 0.95), (41, 59, 0.95), (41, 44, 0.8), (33, 33, 0.22), (27, 27, 0.6),
      (73, 27, 1), (73, 73, 1), (27, 73, 1), (27, 36, 0.8), (30, 82, 0.2), (50, 82, 0.9), (62, 82, 0.6)
    ])
  case .pi:
    return spline([
      (31, 84, 0.9), (32.5, 66, 1.05), (34.5, 46, 0.95), (35.5, 35, 0.6), (27, 37, 0.25), (17, 39.5, 0.45),
      (21, 32, 0.75), (40, 30.5, 1.05), (62, 29.5, 1.05), (84, 27, 0.8), (86, 30.5, 0.35), (74, 33.5, 0.22),
      (67, 37, 0.5), (65.5, 52, 0.95), (66.5, 70, 1.05), (70, 81, 0.9), (78.5, 84, 0.45)
    ])
  case .shell:
    return linear([(22, 29, 0.55), (36, 40, 1.05), (49, 50, 0.95), (36, 60, 1.05), (22, 71, 0.55), (36, 73.5, 0.22), (53, 75, 0.6), (67, 75, 1.05), (83, 74, 0.7)])
  case .enso:
    return spline(arc(50, 50.5, 44, -1.95, -1.95 + tau * 0.9, 1.2, 0.35, 45.5))
  case .ensoClosed:
    return spline(arc(50, 50.5, 44, -1.95, -1.95 + tau * 1.04, 1.2, 0.45, 43))
  case .ringWorking:
    return spline(arc(50, 50.5, 44.7, land + tau * 0.3, land, 1.25, 0.4))
  case .ringWaiting:
    return spline(arc(50, 50.5, 45.2, land, land + tau * 1.06, 1.3, 0.75, 44))
  case .tick:
    return linear(atCorner([(-12, 0, 0.7), (-4, 9.5, 1.15), (-4, 9.5, 1.15), (14, -13.5, 0.4)]))
  case .zee:
    return linear(atCorner([(-7.8, -8.2, 0.75), (7.2, -8.9, 1), (7.2, -8.9, 1), (-7.8, 7.9, 1.05), (-7.8, 7.9, 1.05), (8.4, 7.2, 0.6)]))
  }
}

private func noise(_ i: Int, _ seed: Double) -> Double {
  let n = Double(i)
  return 0.5 * sin(n * 0.31 + seed) + 0.3 * sin(n * 0.087 + seed * 1.7) + 0.2 * sin(n * 1.13 + seed * 0.4)
}

private let nib = 0.55
private let brushAngle = -0.6
private let jitter = 0.12

private func widthAt(_ line: [Pt], _ i: Int, width: Double, seed: Double) -> Double {
  let n = line.count
  let u = Double(i) / Double(n - 1)
  let prev = line[max(0, i - 2)]
  let next = line[min(n - 1, i + 2)]
  let theta = atan2(next.y - prev.y, next.x - prev.x)
  let nibbed = 1 - nib + nib * abs(sin(theta - brushAngle))
  let landing = u < 0.04 ? 0.6 + 0.4 * (u / 0.04) : 1
  let lift = u > 0.86 ? pow(max(0, (1 - u) / 0.14), 0.65) : 1
  return max(0.12, (width / 2) * nibbed * landing * lift * line[i].p * (1 + jitter * noise(i, seed)))
}

private final class InkCache: @unchecked Sendable {
  private let lock = NSLock()
  private var lines: [InkMark: [Pt]] = [:]
  private var strokes: [String: BrushStroke] = [:]

  func line(_ mark: InkMark) -> [Pt] {
    lock.lock()
    defer { lock.unlock() }
    if let known = lines[mark] { return known }
    let line = resample(controlLine(mark))
    lines[mark] = line
    return line
  }

  func stroke(_ key: String, _ make: () -> BrushStroke) -> BrushStroke {
    lock.lock()
    let known = strokes[key]
    lock.unlock()
    if let known { return known }
    let stroke = make()
    lock.lock()
    strokes[key] = stroke
    lock.unlock()
    return stroke
  }
}

private let cache = InkCache()

/** The brush outline of a whole mark, and the dry-brush bristles of its tail. */
public func brushStroke(_ mark: InkMark, width: Double = 5.2, seed: Int = 7, dry: Double = 0.22) -> BrushStroke {
  cache.stroke("\(mark.rawValue)|\(width)|\(seed)|\(dry)") {
    let line = cache.line(mark)
    let n = line.count
    let s = Double(seed)
    let dryFrom = Int(floor(Double(n - 1) * (1 - dry)))
    let bodyEnd = min(n, max(2, dryFrom + Int(floor(Double(n - dryFrom) * 0.35))))
    var left: [CGPoint] = []
    var right: [CGPoint] = []
    var widths: [(nx: Double, ny: Double, w: Double)] = []
    widths.reserveCapacity(n)
    for i in 0..<n {
      let a = line[max(0, i - 1)]
      let b = line[min(n - 1, i + 1)]
      let raw = hypot(b.x - a.x, b.y - a.y)
      let len = raw == 0 ? 1 : raw
      let nx = -(b.y - a.y) / len
      let ny = (b.x - a.x) / len
      let w = widthAt(line, i, width: width, seed: s)
      widths.append((nx, ny, w))
      if i < bodyEnd {
        left.append(CGPoint(x: line[i].x + nx * w, y: line[i].y + ny * w))
        right.append(CGPoint(x: line[i].x - nx * w, y: line[i].y - ny * w))
      }
    }
    var bristles: [[CGPoint]] = []
    if dry > 0 {
      let strands: [Double] = [-0.78, -0.42, -0.1, 0.22, 0.55, 0.86]
      for (k, f) in strands.enumerated() {
        let stop = min(n, n - Int(floor(Double((k * 37 + seed * 11) % 23) * Double(n - dryFrom) * 0.025)))
        var run: [CGPoint] = []
        var i = dryFrom
        while i < stop {
          let gap = sin(Double(i) * (0.21 + Double(k) * 0.05) + Double(k) * 2.1 + s) > 0.72 - (Double(i - dryFrom) / Double(max(1, n - dryFrom))) * 0.5
          if gap {
            if run.count > 1 { bristles.append(run) }
            run = []
          } else {
            let (nx, ny, w) = widths[i]
            run.append(CGPoint(x: line[i].x + nx * w * f, y: line[i].y + ny * w * f))
          }
          i += 1
        }
        if run.count > 1 { bristles.append(run) }
      }
    }
    let head = line[0]
    return BrushStroke(body: left + right.reversed(), bristles: bristles, drop: CGPoint(x: head.x, y: head.y), dropRadius: widthAt(line, 3, width: width, seed: s) * 1.15)
  }
}
