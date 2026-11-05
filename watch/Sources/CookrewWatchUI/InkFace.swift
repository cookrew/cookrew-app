import CookrewCore
import SwiftUI

// AN AGENT IN INK: its harness mark inside an ensō (src/renderer/src/zoom/
// InkAvatar.tsx). Its status is a second brush in red over the same ink: working
// laps a third of a turn, waiting closes the ring and blinks it with the mark,
// done ticks the shoulder, offline fades the ink and writes a z.

private let viewBox = 108.0
private let glyphAt = CGPoint(x: 14.5, y: 15)
private let glyphScale = 0.71
private let ride = 5.6

/** The smaller the face, the fatter the red has to be to be seen. */
public enum InkWeight: Double {
  case large = 1
  case regular = 1.2
  case small = 1.45
  case mini = 1.9
}

private func draw(_ stroke: BrushStroke, _ context: inout GraphicsContext, color: Color, opacity: Double = 1) {
  var body = Path()
  body.addLines(stroke.body)
  body.closeSubpath()
  var ink = context
  ink.opacity = opacity
  ink.fill(body, with: .color(color))
  let r = stroke.dropRadius
  ink.fill(Path(ellipseIn: CGRect(x: stroke.drop.x - r, y: stroke.drop.y - r, width: r * 2, height: r * 2)), with: .color(color))
  var bristles = Path()
  for run in stroke.bristles { bristles.addLines(run) }
  ink.opacity = opacity * 0.82
  ink.stroke(bristles, with: .color(color), style: StrokeStyle(lineWidth: 0.42, lineCap: .round))
}

private func inFace(_ context: inout GraphicsContext, _ size: CGSize) {
  let scale = size.width / viewBox
  context.scaleBy(x: scale, y: scale)
  context.translateBy(x: 4, y: 4)
}

public struct InkFace: View {
  public let id: String
  public let preset: String
  public let orch: Bool
  public let status: CardStatus
  public let size: CGFloat
  public let weight: InkWeight

  @Environment(\.ink) private var ink
  @Environment(\.inkStill) private var still
  @State private var turned = false
  @State private var dimmed = false

  public init(id: String, preset: String, orch: Bool = false, status: CardStatus, size: CGFloat, weight: InkWeight = .regular) {
    self.id = id
    self.preset = preset
    self.orch = orch
    self.status = status
    self.size = size
    self.weight = weight
  }

  private var seed: Int { inkSeed(id) }
  private var mini: Bool { weight == .mini }

  private var cornerName: InkMark? {
    status == .done ? .tick : status == .offline ? .zee : nil
  }

  public var body: some View {
    ZStack {
      own
      if status == .working { lap }
      if status == .waiting { ring }
      if cornerName != nil { corner }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
    .onAppear {
      guard !still else { return }
      withAnimation(.timingCurve(0.45, 0.05, 0.55, 0.95, duration: 1.8).repeatForever(autoreverses: false)) { turned = true }
      withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) { dimmed = true }
    }
  }

  private var own: some View {
    Canvas { context, canvas in
      inFace(&context, canvas)
      let color = ink.ink
      let fade = status == .offline ? 0.34 : 1
      // The ensō steps aside round a corner mark: a cut, so it works on any ground.
      context.drawLayer { layer in
        draw(brushStroke(orch ? .ensoClosed : .enso, width: mini ? 8.5 : 4.6, seed: seed), &layer, color: color, opacity: fade)
        if let cornerName {
          var cut = layer
          cut.blendMode = .destinationOut
          var path = Path()
          path.addLines(cornerStroke(cornerName).body)
          path.closeSubpath()
          cut.transform = cut.transform.concatenating(.identity)
          applyCorner(&cut)
          cut.stroke(path, with: .color(.black), style: StrokeStyle(lineWidth: 7, lineJoin: .round))
          cut.fill(path, with: .color(.black))
        }
      }
      if !mini, status != .waiting {
        var glyph = context
        glyph.translateBy(x: glyphAt.x, y: glyphAt.y)
        glyph.scaleBy(x: glyphScale, y: glyphScale)
        draw(brushStroke(harnessMark(preset), width: 6.2, seed: seed), &glyph, color: color, opacity: fade)
      }
    }
  }

  private func cornerStroke(_ mark: InkMark) -> BrushStroke {
    mark == .tick ? brushStroke(.tick, width: 7, seed: seed, dry: 0.28) : brushStroke(.zee, width: 4.3, seed: seed, dry: 0.12)
  }

  /** A corner mark grows outward from the shoulder. */
  private func applyCorner(_ context: inout GraphicsContext) {
    let k = weight.rawValue
    context.translateBy(x: inkCorner.x, y: inkCorner.y)
    context.scaleBy(x: k, y: k)
    context.translateBy(x: -inkCorner.x, y: -inkCorner.y)
  }

  private var lap: some View {
    Canvas { context, canvas in
      inFace(&context, canvas)
      draw(brushStroke(.ringWorking, width: ride * 1.08 * weight.rawValue, seed: seed, dry: 0.42), &context, color: ink.wait)
    }
    .rotationEffect(.degrees(turned ? 360 : 0), anchor: UnitPoint(x: 54 / viewBox, y: 54.5 / viewBox))
  }

  private var ring: some View {
    Canvas { context, canvas in
      inFace(&context, canvas)
      draw(brushStroke(.ringWaiting, width: ride * 1.22 * weight.rawValue, seed: seed, dry: 0.08), &context, color: ink.wait)
      if !mini {
        var glyph = context
        glyph.translateBy(x: glyphAt.x, y: glyphAt.y)
        glyph.scaleBy(x: glyphScale, y: glyphScale)
        draw(brushStroke(harnessMark(preset), width: 6.2, seed: seed), &glyph, color: ink.wait)
      }
    }
    .opacity(dimmed ? 0.2 : 1)
  }

  private var corner: some View {
    Canvas { context, canvas in
      inFace(&context, canvas)
      guard let cornerName else { return }
      applyCorner(&context)
      draw(cornerStroke(cornerName), &context, color: status == .done ? ink.wait : ink.ink, opacity: status == .offline ? 0.8 : 1)
    }
  }
}
