import CookrewCore
import SwiftUI

// A FACE'S DISC AND LOGO, as the Mac draws them (src/renderer/src/zoom/InkAvatar.tsx · Disc,
// harness-logo.tsx): the harness's own logo on a light disc, a little skeuomorphic (owner
// 2026-11-13: "浅色底带点拟物，不要黑色框了"). Both draw in the face's 100-box (InkFace · inFace).
// Gradients only, no blur: a crew grid of faces costs no extra pass.

/** Where the ensō stood: the status rings (InkMarks · ringWorking, ringWaiting) ride this disc's edge. */
private let disc = (cx: 50.0, cy: 50.5, r: 45.5)

/** The shell's ink prompt on the disc: dark in every palette, since the disc is light in every palette. */
let faceGlyphInk = Color(hex: 0x2A2520)

private func circle(_ cx: Double, _ cy: Double, _ r: Double) -> Path {
  Path(ellipseIn: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2))
}

/** The disc: a soft shadow under it, a warm white body lit from above, a gloss, a bevelled rim; an orchestrator's has a groove ring inside its rim. */
func drawFaceDisc(_ context: inout GraphicsContext, orch: Bool) {
  let (cx, cy, r) = disc
  let shadowR = r + 3.5
  let shadowAt = CGPoint(x: cx, y: cy + 3)
  context.fill(
    circle(shadowAt.x, shadowAt.y, shadowR),
    with: .radialGradient(
      Gradient(stops: [.init(color: Color(hex: 0x3A2C18, alpha: 0.26), location: 0.8), .init(color: Color(hex: 0x3A2C18, alpha: 0), location: 1)]),
      center: shadowAt, startRadius: 0, endRadius: shadowR))
  context.fill(
    circle(cx, cy, r),
    with: .linearGradient(Gradient(colors: [.white, Color(hex: 0xEBE6DD)]), startPoint: CGPoint(x: cx, y: cy - r), endPoint: CGPoint(x: cx, y: cy + r)))
  // The gloss: an ellipse lit near its top, drawn as a circle in a squashed context.
  var gloss = context
  let rx = r * 0.72, ry = r * 0.4
  gloss.translateBy(x: cx, y: cy - 20)
  gloss.scaleBy(x: 1, y: ry / rx)
  gloss.fill(
    circle(0, 0, rx),
    with: .radialGradient(
      Gradient(stops: [.init(color: .white.opacity(0.7), location: 0), .init(color: .white.opacity(0), location: 1)]),
      center: CGPoint(x: 0, y: -0.3 * rx), startRadius: 0, endRadius: 1.2 * rx))
  let rim = r - 0.6
  context.stroke(
    circle(cx, cy, rim),
    with: .linearGradient(
      Gradient(stops: [
        .init(color: .white.opacity(0.95), location: 0),
        .init(color: Color(hex: 0xD8D1C4, alpha: 0.5), location: 0.5),
        .init(color: Color(hex: 0x8A7C66, alpha: 0.45), location: 1)
      ]),
      startPoint: CGPoint(x: cx, y: cy - rim), endPoint: CGPoint(x: cx, y: cy + rim)),
    lineWidth: 1.2)
  if orch {
    context.stroke(circle(cx, cy + 0.6, r - 6), with: .color(.white.opacity(0.9)), lineWidth: 1)
    context.stroke(circle(cx, cy, r - 6), with: .color(Color(hex: 0x6F6250, alpha: 0.28)), lineWidth: 1)
  }
}

/** A logo's width in the 100-box, and its own viewBox (origin, side), as harness-logo.tsx sets them. */
private let logoBox: [InkMark: (size: Double, origin: Double, side: Double)] = [
  .claude: (54, 0, 248), .codex: (50, 0, 24), .opencode: (46, 96, 320), .pi: (48, 140, 520)
]

/** Draws the harness's own logo, colours unchanged, centred on the disc; false for a mark with no maker (a plain shell). */
func drawFaceLogo(_ mark: InkMark, _ context: inout GraphicsContext, opacity: Double) -> Bool {
  guard let box = logoBox[mark] else { return false }
  var art = context
  art.opacity = opacity
  art.translateBy(x: disc.cx - box.size / 2, y: disc.cy - box.size / 2)
  art.scaleBy(x: box.size / box.side, y: box.size / box.side)
  art.translateBy(x: -box.origin, y: -box.origin)
  switch mark {
  case .claude:
    art.fill(LogoPaths.claude, with: .color(Color(hex: 0xD97757)))
  case .codex:
    // The prompt is white in the app's icon: white behind the cloud shows through its cut.
    art.fill(Path(CGRect(x: 5.4, y: 7.4, width: 13.6, height: 9.4)), with: .color(.white))
    art.fill(
      LogoPaths.codex,
      with: .linearGradient(
        Gradient(stops: [
          .init(color: Color(hex: 0xB1A7FF), location: 0), .init(color: Color(hex: 0x7A9DFF), location: 0.5), .init(color: Color(hex: 0x3941FF), location: 1)
        ]),
        startPoint: CGPoint(x: 12, y: 0), endPoint: CGPoint(x: 12, y: 24)),
      style: FillStyle(eoFill: true))
  case .opencode:
    art.fill(LogoPaths.opencodeBlock, with: .color(Color(hex: 0x5A5858)))
    art.fill(LogoPaths.opencodeFrame, with: .color(Color(hex: 0x131010)), style: FillStyle(eoFill: true))
  case .pi:
    for (path, fill) in zip([LogoPaths.pi0, LogoPaths.pi1, LogoPaths.pi2], LogoPaths.piFills) {
      art.fill(path, with: .color(Color(hex: fill)))
    }
  default:
    return false
  }
  return true
}
