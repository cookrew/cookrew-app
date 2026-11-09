import CookrewCore
import SwiftUI

// THE OUTER STOPS OF THE ZOOM: the account's Macs, then one Mac's workspaces.
// Each row is a door one step in; the system's back chevron is the step out.

/** A row: a word on the left, what it holds under it, a badge for what needs the owner. */
private struct StopRow: View {
  let title: String
  let line: String
  let mark: Color?
  let badge: String?
  let quiet: Bool
  @Environment(\.ink) private var ink

  var body: some View {
    HStack(alignment: .center, spacing: 7) {
      if let mark { Circle().fill(mark).frame(width: 7, height: 7) }
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(InkType.name(15))
          .foregroundStyle(quiet ? ink.muted : ink.ink)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
        Text(line.uppercased())
          .font(InkType.word(9.5))
          .tracking(0.8)
          .foregroundStyle(ink.muted)
          .lineLimit(1)
          .minimumScaleFactor(0.75)
      }
      Spacer(minLength: 0)
      if let badge {
        Text(badge)
          .font(InkType.word(10))
          .fontWeight(.semibold)
          .foregroundStyle(ink.onSeal)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(Capsule().fill(ink.wait))
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 12).fill(ink.card))
    .contentShape(Rectangle())
  }
}

/** The first stop: every Mac on the account. Only the paired one can be gone into. */
public struct DevicesPage: View {
  let rows: [DeviceRow]
  let onOpen: () -> Void
  let onThisWatch: () -> Void
  @Environment(\.ink) private var ink

  public init(rows: [DeviceRow], onOpen: @escaping () -> Void, onThisWatch: @escaping () -> Void) {
    self.rows = rows
    self.onOpen = onOpen
    self.onThisWatch = onThisWatch
  }

  private func line(_ row: DeviceRow) -> String {
    let state = row.online ? "online" : "offline"
    guard let count = row.workspaces else { return state }
    return "\(state) · \(count) workspace\(count == 1 ? "" : "s")"
  }

  public var body: some View {
    CardScroll {
      VStack(alignment: .leading, spacing: 6) {
        ForEach(rows) { row in
          if row.paired {
            Button(action: onOpen) {
              StopRow(title: row.name, line: line(row), mark: row.online ? ink.sealText : ink.dim, badge: nil, quiet: false)
            }
            .buttonStyle(.plain)
          } else {
            // This watch holds no token for it: a code from that Mac is the way in.
            StopRow(title: row.name, line: "pair from that Mac", mark: row.online ? ink.sealText : ink.dim, badge: nil, quiet: true)
          }
        }
        Button(action: onThisWatch) {
          Text("THIS WATCH")
            .font(InkType.word())
            .tracking(1)
            .foregroundStyle(ink.muted)
            .frame(maxWidth: .infinity)
            .frame(height: 30)
        }
        .buttonStyle(.plain)
      }
      .padding(.horizontal, 6)
      .padding(.bottom, 8)
    }
    .background(ink.paper)
  }
}

/** The second stop: the paired Mac's workspaces, counted. */
public struct WorkspacesPage: View {
  let tiles: [WorkspaceTile]
  let onOpen: (String) -> Void
  @Environment(\.ink) private var ink

  public init(tiles: [WorkspaceTile], onOpen: @escaping (String) -> Void) {
    self.tiles = tiles
    self.onOpen = onOpen
  }

  private func line(_ tile: WorkspaceTile) -> String {
    var parts = ["\(tile.agents) agent\(tile.agents == 1 ? "" : "s")"]
    if tile.working > 0 { parts.append("\(tile.working) working") }
    if tile.done > 0 { parts.append("\(tile.done) done") }
    return parts.joined(separator: " · ")
  }

  public var body: some View {
    CardScroll {
      VStack(alignment: .leading, spacing: 6) {
        if tiles.isEmpty {
          Text("Reading the Mac…").font(InkType.words(13)).foregroundStyle(ink.muted).padding(.horizontal, 6)
        }
        ForEach(tiles) { tile in
          Button { onOpen(tile.id) } label: {
            // The dot is where a new agent starts: the Mac's active workspace.
            StopRow(title: tile.name, line: line(tile), mark: tile.active ? ink.sealText : nil, badge: tile.waiting > 0 ? "\(tile.waiting)" : nil, quiet: tile.agents == 0)
          }
          .buttonStyle(.plain)
          .accessibilityLabel(tile.waiting > 0 ? "\(tile.name), \(tile.waiting) need you" : tile.name)
        }
      }
      .padding(.horizontal, 6)
      .padding(.bottom, 8)
    }
    .background(ink.paper)
  }
}
