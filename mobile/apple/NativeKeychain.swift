import Foundation
import Security
import CryptoKit

public enum NativeKeychain {
    // This key never enters JavaScript. AfterFirstUnlock permits bounded wakes
    // after the user has unlocked once; ThisDeviceOnly prevents cloud migration.
    public static func storageKey(service: String, existingStore: Bool) throws -> SymmetricKey {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                   kSecAttrService as String: service,
                                   kSecAttrAccount as String: "storage-key-v1",
                                   kSecReturnData as String: true,
                                   kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess {
            guard let data = result as? Data, data.count == 32 else { throw NativeFailure.invalid("Invalid storage key") }
            return SymmetricKey(data: data)
        }
        guard status == errSecItemNotFound, !existingStore else { throw NativeFailure.invalid("Storage key unavailable; unlock device or recover account") }
        let key = SymmetricKey(size: .bits256)
        let data = key.withUnsafeBytes { Data($0) }
        let add: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                 kSecAttrService as String: service,
                                 kSecAttrAccount as String: "storage-key-v1",
                                 kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                                 kSecValueData as String: data]
        let added = SecItemAdd(add as CFDictionary, nil)
        if added == errSecDuplicateItem { return try storageKey(service: service, existingStore: true) }
        guard added == errSecSuccess else { throw NativeFailure.invalid("Cannot persist storage key") }
        return key
    }
}
