import CookrewCore
import Foundation
import UserNotifications
#if canImport(WatchKit)
  import WatchKit
#endif

// AGENT STATUS ALERTS ON THE WRIST. In front, a status change is a tap (feel);
// not in front, it is a notification. A background refresh reads every machine
// the watch holds a key for every quarter hour or so, as watchOS allows: alerts
// the moment something changes need push, which a free developer team cannot send.

@MainActor
public enum StatusAlerts {
  /** The background refresh's name, as the app scene declares it. */
  public static let refresh = "cookrew.status"
  /** How soon the next background read is asked for; watchOS decides when it runs. */
  static let every: TimeInterval = 15 * 60
  private static let memoryKey = "cookrew.watch.status"

  private static func memories() -> [String: StatusMemory] {
    guard let data = UserDefaults.standard.data(forKey: memoryKey) else { return [:] }
    return (try? JSONDecoder().decode([String: StatusMemory].self, from: data)) ?? [:]
  }

  private static func keep(_ all: [String: StatusMemory]) {
    UserDefaults.standard.set(try? JSONEncoder().encode(all), forKey: memoryKey)
  }

  /** Once: the owner says whether the watch may show alerts. */
  static func ask() async {
    _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
  }

  /** Cards read from a machine: what changed since the wrist last saw them, said when nobody is looking. */
  static func note(_ cards: [Card], machine key: String, name: String, inFront: Bool) {
    var all = memories()
    var memory = all[key] ?? StatusMemory()
    let events = memory.alerts(cards)
    all[key] = memory
    keep(all)
    guard !inFront else { return }
    for event in events { post(event, from: name) }
  }

  private static func post(_ event: WatchEvent, from machine: String) {
    guard let title = alertTitle(event) else { return }
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = machine
    content.sound = .default
    content.threadIdentifier = machine
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
  }

  /** Ask watchOS for the next background read. */
  public static func scheduleNext() {
    #if os(watchOS)
      WKApplication.shared().scheduleBackgroundRefresh(withPreferredDate: Date().addingTimeInterval(every), userInfo: refresh as NSString) { _ in }
    #endif
  }

  /** The background read: every held machine once, then the next one asked for. */
  public static func check(registry origin: String) async {
    defer { scheduleNext() }
    let vault = SessionVault()
    let account = vault.loadAccount()
    let registry = HTTPRegistryAPI(origin: URL(string: origin) ?? URL(filePath: "/"))
    let pass = account.map { held in AccountKeeper(account: held, device: vault.device(), api: registry, keep: { vault.saveAccount($0) }) }
    defer { pass?.retire() }
    for key in vault.shelf().keys {
      guard let session = vault.session(key) else { continue }
      let urls = session.bases.filter { account != nil || $0.kind != "relay" }.compactMap { URL(string: $0.url) }
      let api = HTTPWatchAPI(bases: urls, token: session.token, relay: pass, guarded: session.bases.contains { $0.kind == "relay" })
      guard case .new(let reply, _)? = try? await api.cards(tag: nil) else { continue }
      note(reply.cards, machine: key, name: session.desktop, inFront: false)
    }
  }
}
