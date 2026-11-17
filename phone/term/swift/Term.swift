// The term package's module on iOS and macOS: terminals kept by ID, each a
// SwiftTerm screen whose bytes and sizes arrive from any thread and are
// applied on the main thread in the order they came.
import Asuka
import Foundation
import SwiftTerm

func makeTerminals() throws -> any Terminals { ScreenDirectory.shared }

/// A Terminal comes from Terminals.Open only.
func makeTerminal() throws -> any Terminal {
    throw AsukaNativeError.unsupported("a terminal comes from Terminals.Open")
}

/// Every open screen, by the ID its views show. Touched on the main thread only.
final class ScreenDirectory: Terminals {
    static let shared = ScreenDirectory()

    private var screens: [String: Screen] = [:]

    /// Each Open is one hold on the screen, given back by one Close: the
    /// screen goes when the last holder closes it. A screen already open keeps
    /// its grid (resizing it would reflow what it shows).
    @MainActor func `open`(id: String, cols: Int, rows: Int, scrollback: Int) throws -> any Terminal {
        guard cols > 0, rows > 0 else {
            throw AsukaNativeError.unsupported("a terminal needs a grid (got \(cols)x\(rows))")
        }
        let screen = self.screen(id, scrollback: scrollback)
        if screen.hold() == 1 {
            try screen.resize(cols: cols, rows: rows)
        }
        return screen
    }

    /// The live screen under id, made if there is none: a view may be shown
    /// before Open. A closed screen is never handed out again.
    @MainActor func screen(_ id: String, scrollback: Int = Screen.defaultScrollback) -> Screen {
        if let found = screens[id], !found.isClosed { return found }
        let made = Screen(id: id, scrollback: scrollback)
        screens[id] = made
        return made
    }

    @MainActor func forget(_ screen: Screen) {
        if screens[screen.id] === screen { screens[screen.id] = nil }
        screen.host?.detach(screen)
    }
}

/// One terminal: SwiftTerm's view, kept while no host shows it, and the
/// queue of what Go sent it.
final class Screen: Terminal {
    static let defaultScrollback = 2000

    private enum Op {
        case feed(Data)
        case resize(Int, Int)
        case bottom
    }

    let id: String
    private let lock = NSLock()
    private var ops: [Op] = []
    private var drainScheduled = false
    private var closed = false
    private var holders = 0

    // Main thread only from here.
    private let scrollback: Int
    private var made: PassiveTerminalView?
    private(set) var cols = 80
    private(set) var rows = 24
    weak var host: ScreenHost?

    init(id: String, scrollback: Int) {
        self.id = id
        self.scrollback = max(0, scrollback)
    }

    // MARK: Terminal (any thread)

    func feed(data: Data) throws {
        if !data.isEmpty { enqueue(.feed(data)) }
    }

    func resize(cols: Int, rows: Int) throws {
        guard cols > 0, rows > 0 else {
            throw AsukaNativeError.unsupported("a terminal needs a grid (got \(cols)x\(rows))")
        }
        enqueue(.resize(cols, rows))
    }

    func scrollToBottom() throws { enqueue(.bottom) }

    /// Closes this holder's hold; the last one closes the screen.
    func close() throws {
        lock.lock()
        holders = max(0, holders - 1)
        guard holders == 0, !closed else {
            lock.unlock()
            return
        }
        closed = true
        ops.removeAll()
        lock.unlock()
        if Thread.isMainThread {
            MainActor.assumeIsolatedCompat { ScreenDirectory.shared.forget(self) }
        } else {
            DispatchQueue.main.async { ScreenDirectory.shared.forget(self) }
        }
    }

    /// One more holder (an Open); the count after it.
    func hold() -> Int {
        lock.lock()
        defer { lock.unlock() }
        holders += 1
        return holders
    }

    var isClosed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return closed
    }

    private func enqueue(_ op: Op) {
        lock.lock()
        if closed {
            lock.unlock()
            return
        }
        ops.append(op)
        let schedule = !drainScheduled
        drainScheduled = true
        lock.unlock()
        if schedule {
            DispatchQueue.main.async { self.drain() }
        }
    }

    /// Applies what queued since the last drain. Runs of bytes are fed as one,
    /// so a burst costs SwiftTerm one parse and one redraw.
    @MainActor private func drain() {
        lock.lock()
        let batch = ops
        ops = []
        drainScheduled = false
        lock.unlock()
        var bytes = Data()
        for op in batch {
            switch op {
            case .feed(let data):
                bytes.append(data)
            case .resize(let c, let r):
                flush(&bytes)
                // A hello starts a stream, maybe after one that died inside an
                // escape sequence: CAN ends any sequence left half parsed.
                terminalView.feed(byteArray: [0x18])
                applyGrid(cols: c, rows: r)
            case .bottom:
                flush(&bytes)
                terminalView.scroll(toPosition: 1)
            }
        }
        flush(&bytes)
    }

    @MainActor private func flush(_ bytes: inout Data) {
        guard !bytes.isEmpty else { return }
        let view = terminalView
        bytes.withUnsafeBytes { raw in
            view.feed(byteArray: ArraySlice(raw.bindMemory(to: UInt8.self)))
        }
        bytes = Data()
    }

    @MainActor private func applyGrid(cols: Int, rows: Int) {
        self.cols = cols
        self.rows = rows
        let view = terminalView
        let terminal = view.getTerminal()
        if terminal.cols != cols || terminal.rows != rows {
            view.resize(cols: cols, rows: rows)
        }
        host?.gridChanged()
    }

    // MARK: The view (main thread)

    /// SwiftTerm's view, made on first use.
    @MainActor var terminalView: PassiveTerminalView {
        if let made { return made }
        // Kitty images a pane draws are kept up to 16 MB (SwiftTerm's default
        // is 320 MB per screen, too much for a phone with several open).
        let options = TerminalOptions(cols: cols, rows: rows, scrollback: scrollback, kittyImageCacheLimitBytes: 16 << 20)
        let view = PassiveTerminalView(frame: .zero, font: GridFit.font(size: GridFit.defaultSize), options: options)
        made = view
        return view
    }
}
