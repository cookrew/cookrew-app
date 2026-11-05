import SwiftUI

// THE INK THEME ON A WRIST: the same tokens as ink-theme.css, day and night. The
// always-on face takes the night ones (it must be dark, and it must stay the
// same card).

public struct InkPalette: Equatable, Sendable {
  public let paper: Color
  public let card: Color
  public let ink: Color
  public let soft: Color
  public let muted: Color
  public let dim: Color
  public let hair: Color
  public let hair2: Color
  public let seal: Color
  public let sealText: Color
  public let onSeal: Color
  public let gold: Color
  public let onGold: Color
  public let wait: Color
  public let note: Color
  public let noteText: Color

  public static let day = InkPalette(
    paper: Color(hex: 0xF4EFE4), card: Color(hex: 0xFBF8F1), ink: Color(hex: 0x1D1A16), soft: Color(hex: 0x5D554A),
    muted: Color(hex: 0x6F675B), dim: Color(hex: 0x8C8374), hair: Color(hex: 0x1D1A16, alpha: 0.1), hair2: Color(hex: 0x1D1A16, alpha: 0.16),
    seal: Color(hex: 0xA8692B), sealText: Color(hex: 0x8F5520), onSeal: Color(hex: 0xFBF8F1), gold: Color(hex: 0xE2B866),
    onGold: Color(hex: 0x1D1A16), wait: Color(hex: 0xC0392B), note: Color(hex: 0xF2E6BF), noteText: Color(hex: 0x3A3322)
  )

  public static let night = InkPalette(
    paper: Color(hex: 0x000000), card: Color(hex: 0x211E18), ink: Color(hex: 0xECE4D2), soft: Color(hex: 0xB3A993),
    muted: Color(hex: 0x9A917F), dim: Color(hex: 0x6F6859), hair: Color(hex: 0xECE4D2, alpha: 0.1), hair2: Color(hex: 0xECE4D2, alpha: 0.16),
    seal: Color(hex: 0xC88A47), sealText: Color(hex: 0xD49A5A), onSeal: Color(hex: 0x15130F), gold: Color(hex: 0xD6A24E),
    onGold: Color(hex: 0x15130F), wait: Color(hex: 0xE06A55), note: Color(hex: 0x362E18), noteText: Color(hex: 0xECE0BD)
  )
}

public extension Color {
  init(hex: UInt32, alpha: Double = 1) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: alpha
    )
  }

  /** "#6f8a5c", as an item's tint arrives. */
  init(css: String) {
    self.init(hex: UInt32(css.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0x5D6B7A)
  }
}

private struct InkKey: EnvironmentKey {
  static let defaultValue = InkPalette.day
}

/** The drawing of a still screen: no motion, and scrolling views stand flat. */
private struct StillKey: EnvironmentKey {
  static let defaultValue = false
}

public extension EnvironmentValues {
  var ink: InkPalette {
    get { self[InkKey.self] }
    set { self[InkKey.self] = newValue }
  }

  var inkStill: Bool {
    get { self[StillKey.self] }
    set { self[StillKey.self] = newValue }
  }
}

/** Type on a wrist: the app's voices, sized for the distance. */
enum InkType {
  static func name(_ size: CGFloat = 16) -> Font { .system(size: size, weight: .semibold, design: .serif) }
  static func words(_ size: CGFloat = 15) -> Font { .system(size: size, design: .serif) }
  static func word(_ size: CGFloat = 10) -> Font { .system(size: size, weight: .medium, design: .monospaced) }
  static func box(_ size: CGFloat = 13) -> Font { .system(size: size, design: .monospaced) }
}
