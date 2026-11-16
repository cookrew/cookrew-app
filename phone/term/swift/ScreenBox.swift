// The container a ScreenView shows. It holds SwiftTerm's view, at the
// grid's own size, inside a scaler that shrinks it to the room: at the top
// left, or at the bottom when even the smallest scale is taller than the room
// (a pane's newest lines and its prompt are at the bottom).
import Foundation
#if canImport(UIKit)
import UIKit

final class ScreenBox: UIView {
    var onLayout: (() -> Void)?
    var onTouch: (() -> Void)?
    private let scaler = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        addSubview(scaler)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(touched)))
    }

    required init?(coder: NSCoder) { nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }

    @objc private func touched() { onTouch?() }

    func show(_ view: UIView) {
        if view.superview !== scaler {
            view.removeFromSuperview()
            scaler.addSubview(view)
        }
    }

    func hide(_ view: UIView) {
        if view.superview === scaler { view.removeFromSuperview() }
    }

    func place(grid: CGSize, scale: CGFloat) {
        let shown = CGSize(width: grid.width * scale, height: grid.height * scale)
        let top = shown.height > bounds.height ? bounds.height - shown.height : 0
        scaler.transform = .identity
        scaler.bounds = CGRect(origin: .zero, size: grid)
        scaler.transform = CGAffineTransform(scaleX: scale, y: scale)
        scaler.center = CGPoint(x: shown.width / 2, y: top + shown.height / 2)
    }

    func paint(_ color: UIColor) { backgroundColor = color }
}

enum Clipboard {
    static func copy(_ data: Data) {
        if let text = String(data: data, encoding: .utf8) { UIPasteboard.general.string = text }
    }
}
#else
import AppKit

/// AppKit scales a view whose bounds differ from its frame, events included.
private final class Scaler: NSView {
    override var isFlipped: Bool { true }
}

final class ScreenBox: NSView {
    var onLayout: (() -> Void)?
    var onTouch: (() -> Void)?
    private let scaler = Scaler()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = true
        addSubview(scaler)
    }

    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        onLayout?()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        onLayout?()
    }

    /// A click in the box is the user's: note it, and let it through.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        if hit != nil, NSApp.currentEvent?.type == .leftMouseDown { onTouch?() }
        return hit
    }

    func show(_ view: NSView) {
        if view.superview !== scaler {
            view.removeFromSuperview()
            scaler.addSubview(view)
        }
    }

    func hide(_ view: NSView) {
        if view.superview === scaler { view.removeFromSuperview() }
    }

    func place(grid: CGSize, scale: CGFloat) {
        let shown = NSSize(width: grid.width * scale, height: grid.height * scale)
        let top = shown.height > bounds.height ? bounds.height - shown.height : 0
        let frame = NSRect(x: 0, y: top, width: shown.width, height: shown.height)
        if scaler.frame != frame { scaler.frame = frame }
        if scaler.bounds.size != grid { scaler.setBoundsSize(grid) }
    }

    func paint(_ color: NSColor) { layer?.backgroundColor = color.cgColor }
}

enum Clipboard {
    static func copy(_ data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
#endif

extension MainActor {
    /// Runs body as the main actor's, from code that is on the main thread
    /// but not marked so (a delegate SwiftTerm calls there). assumeIsolated
    /// needs macOS 14 and iOS 17; the package runs on older.
    static func assumeIsolatedCompat(_ body: @MainActor () -> Void) {
        precondition(Thread.isMainThread, "not on the main thread")
        withoutActuallyEscaping(body) { escaping in
            unsafeBitCast(escaping, to: (() -> Void).self)()
        }
    }
}
