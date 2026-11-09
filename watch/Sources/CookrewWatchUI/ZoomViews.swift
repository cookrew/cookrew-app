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

/**
 * The first stop: every machine on the account. One the watch holds a key for
 * is a tap away; one it does not is paired from here, with that machine's code.
 */
public struct DevicesPage: View {
  let rows: [DeviceRow]
  let onOpen: () -> Void
  let onSwitch: (String) -> Void
  let onAdd: (DeviceRow) -> Void
  let onThisWatch: () -> Void
  @Environment(\.ink) private var ink

  public init(rows: [DeviceRow], onOpen: @escaping () -> Void, onSwitch: @escaping (String) -> Void = { _ in }, onAdd: @escaping (DeviceRow) -> Void = { _ in }, onThisWatch: @escaping () -> Void) {
    self.rows = rows
    self.onOpen = onOpen
    self.onSwitch = onSwitch
    self.onAdd = onAdd
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
          Button {
            if row.paired { onOpen() } else if row.held { onSwitch(row.id) } else { onAdd(row) }
          } label: {
            StopRow(title: row.name, line: row.held ? line(row) : (row.online ? "tap to open" : "offline"), mark: row.online ? ink.sealText : ink.dim, badge: nil, quiet: !row.held)
          }
          .buttonStyle(.plain)
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
  /** The word for the machine they are on. */
  let machine: String
  let onOpen: (String) -> Void
  @Environment(\.ink) private var ink

  public init(tiles: [WorkspaceTile], machine: String = machineWord(nil), onOpen: @escaping (String) -> Void) {
    self.tiles = tiles
    self.machine = machine
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
          Text("Reading the \(machine)…").font(InkType.words(13)).foregroundStyle(ink.muted).padding(.horizontal, 6)
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

/** A machine of the account the watch holds no key for: its code, typed here, adds it. */
public struct AddMachinePage: View {
  let name: String
  /** Why it was not simply opened, when there is a reason worth saying. */
  let note: String?
  let onCode: () -> Void
  @Environment(\.ink) private var ink

  public init(name: String, note: String? = nil, onCode: @escaping () -> Void) {
    self.name = name
    self.note = note
    self.onCode = onCode
  }

  public var body: some View {
    CardScroll {
      VStack(alignment: .leading, spacing: 8) {
        if let note { Text(note).font(InkType.words(12.5)).foregroundStyle(ink.wait) }
        Text("On \(name):").font(InkType.words(14)).foregroundStyle(ink.ink)
        Text("⋯ → Apple Watch → GET A CODE").font(InkType.word(10.5)).tracking(0.6).foregroundStyle(ink.sealText)
        Text("The machines already on this watch stay.").font(InkType.words(12.5)).foregroundStyle(ink.muted)
        Button(action: onCode) {
          Text("Enter the code")
            .font(InkType.name(15))
            .foregroundStyle(ink.onSeal)
            .frame(maxWidth: .infinity)
            .frame(height: 38)
            .background(Capsule().fill(ink.seal))
        }
        .buttonStyle(.plain)
        .padding(.top, 4)
      }
      .padding(.horizontal, 10)
      .padding(.bottom, 10)
    }
    .background(ink.paper)
    .navigationTitle(name)
  }
}
