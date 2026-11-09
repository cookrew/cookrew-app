import CookrewCore
import SwiftUI

// PAIRING: six digits from ⋯ → Apple Watch on the Mac or the phone, and where
// that Mac is. The address is usually filled in already (Local.xcconfig); digits
// are big keys, because a wrist cannot aim.

public enum PairFailure: Equatable, Sendable {
  case noAddress
  case unreachable
  case refused(String)

  var words: String {
    switch self {
    case .noAddress: return "Set the computer's address"
    case .unreachable: return "Can't reach that computer"
    case .refused("paused"): return "Too many tries · wait a minute"
    case .refused("burned"), .refused("expired"), .refused("no-code"): return "Ask for a new code"
    case .refused: return "Wrong code"
    }
  }
}

public struct PairView: View {
  @Binding var address: String
  let digits: String
  let busy: Bool
  let failure: PairFailure?
  let onDigit: (String) -> Void
  let onDelete: () -> Void

  @Environment(\.ink) private var ink

  public init(address: Binding<String>, digits: String, busy: Bool, failure: PairFailure?, onDigit: @escaping (String) -> Void, onDelete: @escaping () -> Void) {
    self._address = address
    self.digits = digits
    self.busy = busy
    self.failure = failure
    self.onDigit = onDigit
    self.onDelete = onDelete
  }

  private let keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"]

  public var body: some View {
    VStack(spacing: 3) {
      WordsField(prompt: "Computer address", onWords: { address = $0 }) {
        Text(address.isEmpty ? "Computer address…" : address)
          .font(InkType.word(10.5))
          .foregroundStyle(address.isEmpty ? ink.sealText : ink.muted)
          .lineLimit(1)
          .padding(.trailing, clockRoom)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.leading, 14)
          .frame(height: 20)
      }
      Group {
        if let failure {
          Text(failure.words).font(InkType.words(13)).foregroundStyle(ink.wait).lineLimit(1)
        } else if busy {
          Text("Pairing…").font(InkType.words(13)).foregroundStyle(ink.soft)
        } else {
          HStack(spacing: 7) {
            ForEach(0..<6, id: \.self) { index in
              Circle()
                .fill(index < digits.count ? ink.ink : ink.hair2)
                .frame(width: 9, height: 9)
            }
          }
        }
      }
      .frame(height: 20)
      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 3), spacing: 3) {
        ForEach(keys.indices, id: \.self) { index in
          let key = keys[index]
          if key.isEmpty {
            Color.clear.frame(height: 40)
          } else {
            Button {
              key == "⌫" ? onDelete() : onDigit(key)
            } label: {
              Text(key)
                .font(.system(size: 19, weight: .medium, design: .serif))
                .foregroundStyle(ink.ink)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
                .background(RoundedRectangle(cornerRadius: 10).fill(ink.card))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(ink.hair2, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .disabled(busy)
          }
        }
      }
      .padding(.horizontal, 5)
      .padding(.bottom, 4)
    }
    .background(ink.paper)
  }
}
