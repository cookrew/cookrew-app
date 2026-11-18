// Seatbelt probe: can a confined process read a pasteboard? Uses a private NAMED
// pasteboard, never the general one, so the owner's clipboard is never touched.
// Usage: pasteboard-probe <write|read|release> <name> [text]
// Prints exactly one line.
import AppKit

let args = CommandLine.arguments
guard args.count >= 3 else {
  print("USAGE")
  exit(64)
}
let board = NSPasteboard(name: NSPasteboard.Name(args[2]))
switch args[1] {
case "write":
  board.clearContents()
  print(board.setString(args.count > 3 ? args[3] : "", forType: .string) ? "WROTE" : "WRITE-FAILED")
case "read":
  print("READ \(board.string(forType: .string) ?? "<nil>")")
default:
  board.releaseGlobally()
  print("RELEASED")
}
