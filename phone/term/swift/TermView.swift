// The term package's view on iOS and macOS: a host that shows the screen
// under its ID, its grid kept at the pane's size and its font scaled to fit.
import Asuka
import Foundation
import SwiftTerm
#if canImport(UIKit)
import UIKit
typealias PlatformColor = UIColor
typealias PlatformFont = UIFont
#else
import AppKit
typealias PlatformColor = NSColor
typealias PlatformFont = NSFont
#endif

@MainActor func makeTerminalView(_ events: TerminalViewEvents) -> any TerminalView { ScreenView(events) }

/// SwiftTerm's view, minus every byte the emulator would send by itself.
///
/// SwiftTerm answers a program's queries (device attributes, the cursor's
/// position, colors), reports focus and the mouse, all through
/// send(source: Terminal, …). Here the program runs on another machine, and
/// those answers would be typed into its pane as if the user had: looking at an
/// agent must never type into it. What the user types takes another road
/// (TerminalView.send(data:)), which stays. Dropped with the rest: the
/// emulator's own click-to-move-the-cursor at a shell prompt (OSC 133 clicks).
/// The wheel is the host's (ScreenBox), as SwiftTerm makes keys of it.
final class PassiveTerminalView: SwiftTerm.TerminalView {
    override func send(source: SwiftTerm.Terminal, data: ArraySlice<UInt8>) {}
}

/// How the pane's grid is drawn in the room a view has.
enum GridFit {
    static let defaultSize: CGFloat = 13
    /// Below this the text is unreadable: the grid is clipped instead.
    static let smallest: CGFloat = 6
    /// The grid's frame gets this much slack: SwiftTerm counts columns as
    /// Int(width / cell), which floating point can round one short.
    static let slack: CGFloat = 0.5

    static func font(size: CGFloat) -> PlatformFont {
        PlatformFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }

    /// The scale the grid is drawn at: whole at the font size when it fits,
    /// shrunk until it does, never below the smallest readable size.
    static func scale(grid: CGSize, room: CGSize, fontSize: CGFloat) -> CGFloat {
        guard grid.width > 0, grid.height > 0, room.width > 0, room.height > 0, fontSize > 0 else { return 1 }
        let fit = min(room.width / grid.width, room.height / grid.height, 1)
        return max(fit, min(1, smallest / fontSize))
    }
}

/// What a screen calls back on the host that shows it.
@MainActor protocol ScreenHost: AnyObject {
    func gridChanged()
    func detach(_ screen: Screen)
}

/// The view Go shows: a plain container holding the screen's SwiftTerm view.
@MainActor final class ScreenView: TerminalView, ScreenHost {
    private let events: TerminalViewEvents
    private let box = ScreenBox()
    private var screen: Screen?
    private var fontSize = GridFit.defaultSize
    private var theme: Theme?
    private lazy var input = InputRelay(events)

    var view: AsukaPlatformView { box }

    init(_ events: TerminalViewEvents) {
        self.events = events
        box.onLayout = { [weak self] in self?.fit() }
        box.onTouch = { [weak self] in self?.events.onTouch() }
    }

    func setID(_ value: String) {
        if let screen, screen.id == value { return }
        if let screen { detach(screen) }
        let next = ScreenDirectory.shared.screen(value)
        next.host?.detach(next)
        next.host = self
        screen = next
        let tv = next.terminalView
        tv.terminalDelegate = input
        box.show(tv)
        applyTheme()
        fit()
    }

    func setFontSize(_ value: Float) {
        let size = CGFloat(value)
        guard size > 0, size != fontSize else { return }
        fontSize = size
        fit()
    }

    func setTheme(_ value: Theme) {
        theme = value
        applyTheme()
    }

    // MARK: ScreenHost

    func gridChanged() { fit() }

    func detach(_ screen: Screen) {
        guard self.screen === screen else { return }
        if screen.host === self { screen.host = nil }
        box.hide(screen.terminalView)
        self.screen = nil
    }

    // MARK: Fitting

    /// Keeps SwiftTerm's view at exactly the pane's grid, then scales it to
    /// the room. The grid is the pane's: neither the window nor the font
    /// changes it. SwiftTerm resizes (and reflows) its screen to whatever frame
    /// it is given, so its frame is only ever set to the grid's own size.
    private func fit() {
        guard let screen else { return }
        let tv = screen.terminalView
        if tv.font.pointSize != fontSize {
            // Rare (the FontSize prop changed): SwiftTerm resizes the screen to
            // the old frame at the new font; the grid is set back just below.
            tv.font = GridFit.font(size: fontSize)
        }
        let terminal = tv.getTerminal()
        if terminal.cols != screen.cols || terminal.rows != screen.rows {
            // The emulator's own resize: the view's would soft-reset the
            // screen's modes, and no frame follows here to restore them.
            terminal.resize(cols: screen.cols, rows: screen.rows)
            #if canImport(UIKit)
            tv.setNeedsDisplay()
            #else
            tv.needsDisplay = true
            #endif
        }
        let optimal = tv.getOptimalFrameSize().size
        let grid = CGSize(width: optimal.width + GridFit.slack, height: optimal.height + GridFit.slack)
        let frame = CGRect(origin: .zero, size: grid)
        if tv.frame != frame { tv.frame = frame }
        box.place(grid: grid, scale: GridFit.scale(grid: grid, room: box.bounds.size, fontSize: fontSize))
    }

    private func applyTheme() {
        guard let theme, let tv = screen?.terminalView else { return }
        if let bg = PlatformColor(hex: theme.background) {
            tv.nativeBackgroundColor = bg
            box.paint(bg)
        }
        if let fg = PlatformColor(hex: theme.foreground) { tv.nativeForegroundColor = fg }
        if let cursor = PlatformColor(hex: theme.cursor) { tv.caretColor = cursor }
    }
}

/// Hands Go what the user typed; ignores the rest of what SwiftTerm reports.
final class InputRelay: TerminalViewDelegate {
    private let events: TerminalViewEvents

    init(_ events: TerminalViewEvents) { self.events = events }

    /// Called on the main thread, as the user types (SwiftTerm asserts it).
    func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
        #if os(macOS)
        // A wheel is never typing (ScreenBox takes it; this is the backstop).
        if NSApp.currentEvent?.type == .scrollWheel { return }
        #endif
        MainActor.assumeIsolatedCompat {
            events.onTouch()
            events.onInput(data: Data(data))
        }
    }

    func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {}
    func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}
    func scrolled(source: SwiftTerm.TerminalView, position: Double) {}
    func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}
    /// A program in the pane setting this device's clipboard (OSC 52) is
    /// ignored: what it sends can be text the user only displayed (a file
    /// they cat), and a swapped-in command waits for their next paste. A
    /// prompt that shows what it would copy can allow it later.
    func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) {}
    /// A program in the pane asking for this device's clipboard (OSC 52) gets nothing.
    func clipboardRead(source: SwiftTerm.TerminalView) -> Data? { nil }
    func bell(source: SwiftTerm.TerminalView) {}
    func iTermContent(source: SwiftTerm.TerminalView, content: ArraySlice<UInt8>) {}

    /// A link the user clicked in the pane (OSC 8): web links only.
    func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link), url.scheme == "https" || url.scheme == "http" else { return }
        #if canImport(UIKit)
        UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
    }
}

extension PlatformColor {
    /// A color from #rrggbb, or nil.
    convenience init?(hex: String) {
        var text = hex.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        let r = CGFloat((value >> 16) & 0xff) / 255
        let g = CGFloat((value >> 8) & 0xff) / 255
        let b = CGFloat(value & 0xff) / 255
        self.init(red: r, green: g, blue: b, alpha: 1)
    }
}
