// The keyvault package on iOS and macOS: a generic-password keychain item
// behind SecAccessControl .biometryCurrentSet, on this device only and only
// while it has a passcode.
//
// TWO SLOTS AND A POINTER, so a save never loses what was kept. A value is
// written into the slot that is NOT current (`<key>.a` or `<key>.b`), and only
// once it is there does the pointer (`<key>.kept`, nothing secret in it, no
// prompt to read) name it; the old slot goes last. A save that fails anywhere
// — the iPhone locked mid-way, the app killed — leaves the pointer on the old
// value. The pointer also tells a value that biometry changes made unreadable
// (the pointer is there, its slot reads "not found") from one never kept.
import Asuka
import Foundation
import LocalAuthentication
import Security

func makeKeyvault() throws -> any Keyvault { BiometricKeychain() }

final class BiometricKeychain: Keyvault, @unchecked Sendable {
    private let service = "dev.cookrew.phone.keyvault"
    /// One keychain change at a time, whoever calls.
    private let queue = DispatchQueue(label: "dev.cookrew.phone.keyvault")

    func available() throws -> Bool {
        biometryProblem() == nil
    }

    func save(key: String, value: Data) async throws {
        if let problem = biometryProblem() { throw problem }
        var failed: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            .biometryCurrentSet,
            &failed
        ) else {
            throw KeyvaultError.noBiometry
        }
        try await onQueue {
            let current = self.pointer(key)
            let next = current == "a" ? "b" : "a"
            // The slot that is not current: whatever is there is a save that never finished.
            self.remove(account: self.slot(key, next))
            var item = self.base(account: self.slot(key, next))
            item[kSecAttrAccessControl as String] = access
            item[kSecValueData as String] = value
            let added = SecItemAdd(item as CFDictionary, nil)
            guard added == errSecSuccess else { throw self.failure(added) }
            try self.point(key, at: next)
            if let current { self.remove(account: self.slot(key, current)) }
        }
    }

    func load(key: String, reason: String) async throws -> Data {
        let context = LAContext()
        context.localizedReason = reason
        return try await withTaskCancellationHandler {
            try await onQueue {
                guard let current = self.pointer(key) else { throw KeyvaultError.notFound }
                var query = self.base(account: self.slot(key, current))
                query[kSecReturnData as String] = true
                query[kSecMatchLimit as String] = kSecMatchLimitOne
                query[kSecUseAuthenticationContext as String] = context
                var found: CFTypeRef?
                let status = SecItemCopyMatching(query as CFDictionary, &found)
                switch status {
                case errSecSuccess:
                    guard let data = found as? Data else { throw KeyvaultError.notFound }
                    return data
                case errSecItemNotFound:
                    // The pointer names a slot the keychain no longer opens: biometry changed.
                    throw KeyvaultError.invalidated
                default:
                    throw self.failure(status)
                }
            }
        } onCancel: {
            // Go's context ended: take the prompt down.
            context.invalidate()
        }
    }

    func delete(key: String) throws {
        queue.sync {
            self.remove(account: self.slot(key, "a"))
            self.remove(account: self.slot(key, "b"))
            self.remove(account: self.pointerAccount(key))
        }
    }

    // MARK: - Biometry

    /// Why nothing can be kept behind biometry here, or nil. A lockout (too many
    /// failed tries) is not one: saving needs no prompt, and the next load asks for the passcode.
    private func biometryProblem() -> Error? {
        var problem: NSError?
        if LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &problem) { return nil }
        if let problem, problem.domain == LAErrorDomain, problem.code == LAError.biometryLockout.rawValue { return nil }
        return KeyvaultError.noBiometry
    }

    // MARK: - The keychain

    private func base(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            // The data protection keychain on a Mac too: access control lives only there.
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    private func slot(_ key: String, _ name: String) -> String { key + "." + name }

    private func pointerAccount(_ key: String) -> String { key + ".kept" }

    /// The current slot's name, read from the pointer, which never prompts; nil when nothing is kept.
    private func pointer(_ key: String) -> String? {
        var query = base(account: pointerAccount(key))
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess,
              let data = found as? Data,
              let name = String(data: data, encoding: .utf8),
              name == "a" || name == "b"
        else { return nil }
        return name
    }

    /// Points the key at a slot: one update of an item that holds nothing secret.
    private func point(_ key: String, at name: String) throws {
        let value = Data(name.utf8)
        let query = base(account: pointerAccount(key))
        let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: value] as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw failure(updated) }
        var item = query
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        item[kSecValueData as String] = value
        let added = SecItemAdd(item as CFDictionary, nil)
        guard added == errSecSuccess else { throw failure(added) }
    }

    private func remove(account: String) {
        SecItemDelete(base(account: account) as CFDictionary)
    }

    private func failure(_ status: OSStatus) -> Error {
        switch status {
        case errSecUserCanceled, errSecAuthFailed:
            return KeyvaultError.canceled
        case errSecInteractionNotAllowed:
            return KeyvaultError.unavailable
        case errSecItemNotFound:
            return KeyvaultError.notFound
        case errSecNotAvailable, errSecMissingEntitlement:
            return KeyvaultError.noBiometry
        default:
            let message = (SecCopyErrorMessageString(status, nil) as String?) ?? "keychain error"
            return NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: message])
        }
    }

    /// The keychain blocks (and asks for Face ID): on this vault's own serial queue, never the main thread.
    private func onQueue<T>(_ work: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                continuation.resume(with: Result { try work() })
            }
        }
    }
}
