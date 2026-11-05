import CookrewCore
import SwiftUI

// PAIRING BY ONE CODE: what the wrist shows from first launch to the first card.
// The code comes from ⋯ → Apple Watch on the phone or the Mac (WatchPairSheet.tsx).

/** The registry's alphabet: no 0, 1, I or O, so nothing on the pad can be misread. */
private let alphabet = Array("23456789ABCDEFGHJKLMNPQRSTUVWXYZ").map(String.init)
let codeLength = 8

public struct InkButton: View {
  let title: String
  let quiet: Bool
  let action: () -> Void
  @Environment(\.ink) private var ink

  public init(title: String, quiet: Bool = false, action: @escaping () -> Void) {
    self.title = title
    self.quiet = quiet
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 15, weight: .semibold, design: .serif))
        .foregroundStyle(quiet ? ink.ink : ink.onGold)
        .frame(maxWidth: .infinity)
        .frame(height: 40)
        .background(Capsule().fill(quiet ? ink.card : ink.gold))
        .overlay(Capsule().strokeBorder(ink.hair2, lineWidth: quiet ? 1 : 0))
    }
    .buttonStyle(.plain)
  }
}

public struct WelcomeView: View {
  let onCode: () -> Void
  let onDigits: () -> Void
  @Environment(\.ink) private var ink

  public init(onCode: @escaping () -> Void, onDigits: @escaping () -> Void) {
    self.onCode = onCode
    self.onDigits = onDigits
  }

  public var body: some View {
    VStack(spacing: 5) {
      InkFace(id: "cookrew", preset: "Claude Code", orch: true, status: .idle, size: 46, weight: .large).padding(.top, 18)
      Text("Cookrew").font(InkType.name(18)).foregroundStyle(ink.ink)
      Text("On your phone or Mac, open ⋯ and pick Apple Watch")
        .font(InkType.words(13))
        .foregroundStyle(ink.soft)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 12)
      Spacer(minLength: 0)
      InkButton(title: "Enter the code", action: onCode).padding(.horizontal, 6)
      Button(action: onDigits) {
        Text("Six digits instead").font(InkType.words(12)).foregroundStyle(ink.muted).frame(height: 20)
      }
      .buttonStyle(.plain)
      .padding(.bottom, 3)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(ink.paper)
  }
}

/** All 32 keys on one screen, so eight characters need no paging. */
public struct CodePad: View {
  let typed: String
  let error: String?
  let onKey: (String) -> Void
  let onDelete: () -> Void
  @Environment(\.ink) private var ink

  public init(typed: String, error: String? = nil, onKey: @escaping (String) -> Void, onDelete: @escaping () -> Void) {
    self.typed = typed
    self.error = error
    self.onKey = onKey
    self.onDelete = onDelete
  }

  private func slot(_ index: Int) -> some View {
    let chars = Array(typed)
    return Text(index < chars.count ? String(chars[index]) : "·")
      .font(.system(size: 13, weight: .semibold, design: .monospaced))
      .foregroundStyle(error != nil ? ink.wait : index < chars.count ? ink.ink : ink.dim)
      .frame(width: 10.5)
  }

  private func key(_ word: String, height: CGFloat, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(word)
        .font(.system(size: 15, weight: .medium, design: .monospaced))
        .foregroundStyle(ink.ink)
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .background(RoundedRectangle(cornerRadius: 7).fill(ink.card))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(ink.hair2, lineWidth: 1))
    }
    .buttonStyle(.plain)
  }

  private func letter(_ index: Int, height: CGFloat) -> some View {
    key(alphabet[index], height: height) { onKey(alphabet[index]) }
  }

  public var body: some View {
    GeometryReader { space in
      let head: CGFloat = error == nil ? 25 : 40
      let height = (space.size.height - head - 6 - 5 * 2) / 6
      VStack(spacing: 2) {
        HStack(spacing: 0) {
          ForEach(0..<4, id: \.self) { slot($0) }
          Text("-").font(.system(size: 13, design: .monospaced)).foregroundStyle(ink.dim).frame(width: 7)
          ForEach(4..<codeLength, id: \.self) { slot($0) }
          Spacer(minLength: 0)
        }
        .padding(.leading, 11)
        .frame(height: 23)
        if let error {
          Text(error).font(InkType.words(12)).foregroundStyle(ink.wait).lineLimit(1).frame(height: 13)
        }
        ForEach(0..<5, id: \.self) { row in
          HStack(spacing: 2) {
            ForEach(0..<6, id: \.self) { col in letter(row * 6 + col, height: height) }
          }
        }
        HStack(spacing: 2) {
          letter(30, height: height)
          letter(31, height: height)
          key("⌫", height: height, action: onDelete).frame(width: (space.size.width - 8 - 10) / 6 * 4 + 6)
        }
      }
      .padding(.horizontal, 4)
    }
    .background(ink.paper)
  }
}

/** The act in progress, ticking off what is done. */
public struct JoinSteps: View {
  let done: [String]
  let now: String?
  @Environment(\.ink) private var ink

  public init(done: [String], now: String?) {
    self.done = done
    self.now = now
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      InkFace(id: "cookrew", preset: "Claude Code", orch: true, status: now == nil ? .done : .working, size: 46, weight: .large)
        .frame(maxWidth: .infinity)
        .padding(.top, 26)
        .padding(.bottom, 6)
      ForEach(done, id: \.self) { line in
        HStack(spacing: 6) {
          Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(ink.sealText)
          Text(line).font(InkType.words(14)).foregroundStyle(ink.soft)
        }
      }
      if let now {
        HStack(spacing: 6) {
          Circle().fill(ink.wait).frame(width: 7, height: 7).padding(.horizontal, 2)
          Text(now).font(InkType.words(14)).foregroundStyle(ink.ink)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 22)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(ink.paper)
  }
}

/** Something stopped the pairing: what, and the one thing to do next. */
public struct NoticeView: View {
  let title: String
  let words: String
  let action: String
  let status: CardStatus
  let onAction: () -> Void
  @Environment(\.ink) private var ink

  public init(title: String, words: String, action: String, status: CardStatus = .offline, onAction: @escaping () -> Void) {
    self.title = title
    self.words = words
    self.action = action
    self.status = status
    self.onAction = onAction
  }

  public var body: some View {
    VStack(spacing: 5) {
      InkFace(id: "cookrew", preset: "Claude Code", orch: true, status: status, size: 40, weight: .large).padding(.top, 26)
      Text(title).font(InkType.name(16)).foregroundStyle(ink.ink).multilineTextAlignment(.center)
      Text(words).font(InkType.words(13)).foregroundStyle(ink.soft).multilineTextAlignment(.center).padding(.horizontal, 12)
      Spacer(minLength: 0)
      InkButton(title: action, action: onAction).padding(.horizontal, 6).padding(.bottom, 6)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(ink.paper)
  }
}

/** What this watch is joined to, and the way out. Forgetting takes a second tap. */
public struct ThisWatchPage: View {
  let desktop: String
  let account: String?
  let line: WatchLine
  let onForget: () -> Void
  @State private var armed = false
  @Environment(\.ink) private var ink

  public init(desktop: String, account: String?, line: WatchLine, onForget: @escaping () -> Void) {
    self.desktop = desktop
    self.account = account
    self.line = line
    self.onForget = onForget
  }

  private var words: String {
    let road = line == .relay ? "through cookrew.dev" : "on your network"
    return account.map { "signed in as \($0) · \(road)" } ?? road
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("THIS WATCH")
        .font(InkType.word())
        .tracking(1)
        .foregroundStyle(ink.muted)
        .padding(.leading, 6)
        .padding(.top, 8)
        .padding(.trailing, clockRoom)
      VStack(alignment: .leading, spacing: 1) {
        Text(desktop).font(InkType.words(15)).foregroundStyle(ink.ink).lineLimit(1)
        Text(words).font(InkType.words(11.5)).foregroundStyle(ink.muted)
      }
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 12).fill(ink.card))
      Spacer(minLength: 0)
      InkButton(title: armed ? "Tap again to forget" : "Forget this watch", quiet: !armed) {
        if armed { onForget() } else { armed = true }
      }
      .padding(.bottom, 6)
    }
    .padding(.horizontal, 6)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(ink.paper)
  }
}
