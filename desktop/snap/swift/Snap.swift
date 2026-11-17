// The snap package on macOS: the window as the window server shows it.
// (Drawing the views into a bitmap is no substitute: SwiftTerm's text lives
// in a layer surface that neither cacheDisplay nor CALayer.render can read.)
import AppKit
import Asuka
import Foundation

func makeSnap() throws -> any Snap { WindowSnap() }

final class WindowSnap: Snap {
    @MainActor func window(path: String) throws {
        let windows = NSApp.windows.filter { $0.isVisible }
        guard let window = NSApp.keyWindow ?? windows.first else {
            throw AsukaNativeError.unsupported("no window to picture")
        }
        guard let image = composited(window) else {
            throw AsukaNativeError.unsupported("the window server would not picture the window")
        }
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw AsukaNativeError.unsupported("the picture would not encode")
        }
        try png.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    /// The window as the window server composites it: what is on screen,
    /// layers and all. An app may picture its own windows without asking.
    /// Looked up at run time: the SDK no longer declares it.
    @MainActor private func composited(_ window: NSWindow) -> CGImage? {
        typealias Capture = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return nil }
        let capture = unsafeBitCast(symbol, to: Capture.self)
        let optionIncludingWindow: UInt32 = 1 << 3
        let boundsIgnoreFraming: UInt32 = 1 << 0
        return capture(.null, optionIncludingWindow, UInt32(window.windowNumber), boundsIgnoreFraming)?.takeRetainedValue()
    }

    @MainActor func keys(text: String) throws {
        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }),
              let root = window.contentView, let terminal = Self.terminal(in: root)
        else {
            throw AsukaNativeError.unsupported("no terminal on screen")
        }
        window.makeFirstResponder(terminal)
        for ch in text {
            let s = String(ch)
            let code: UInt16 = s == "\r" ? 36 : 0
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                guard let event = NSEvent.keyEvent(
                    with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber, context: nil, characters: s, charactersIgnoringModifiers: s,
                    isARepeat: false, keyCode: code)
                else { continue }
                window.sendEvent(event)
            }
        }
    }

    @MainActor func wheel(lines: Int) throws {
        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }),
              let root = window.contentView, let terminal = Self.terminal(in: root),
              let screen = NSScreen.screens.first,
              let cg = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: Int32(clamping: lines), wheel2: 0, wheel3: 0)
        else {
            throw AsukaNativeError.unsupported("no terminal to scroll")
        }
        // Over the terminal's middle, in the window server's coordinates
        // (top left of the main screen), and addressed to this window.
        let inWindow = terminal.convert(NSPoint(x: terminal.bounds.midX, y: terminal.bounds.midY), to: nil)
        let onScreen = window.convertPoint(toScreen: inWindow)
        cg.location = CGPoint(x: onScreen.x, y: screen.frame.height - onScreen.y)
        cg.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowNumber))
        cg.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowNumber))
        guard let event = NSEvent(cgEvent: cg) else { throw AsukaNativeError.unsupported("no wheel event") }
        // Through the app's queue, so AppKit dispatches it as a real one.
        NSApp.postEvent(event, atStart: false)
    }

    /// The first SwiftTerm view under view.
    @MainActor private static func terminal(in view: NSView) -> NSView? {
        if String(describing: type(of: view)).contains("TerminalView") { return view }
        for sub in view.subviews {
            if let found = terminal(in: sub) { return found }
        }
        return nil
    }
}
