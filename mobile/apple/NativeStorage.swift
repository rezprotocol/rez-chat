import Foundation
import SQLite3
import CryptoKit
import Darwin

// Generic encrypted KV only. SQL never interprets a Rez record. SQLite FULL
// commits precede acknowledgement; flock excludes other engines/processes and
// releases automatically on process death. The persisted epoch fences grants.
public final class NativeStorage {
    private var db: OpaquePointer?
    private let key: SymmetricKey
    private let lockPath: String
    private var lockFd: Int32 = -1
    private var owner = ""
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    public init(directory: URL, key: SymmetricKey) throws {
        self.key = key
        lockPath = directory.appendingPathComponent("runtime.lock").path
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let path = directory.appendingPathComponent("store.sqlite").path
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            if let db = db { sqlite3_close_v2(db) }; db = nil
            throw NativeFailure.invalid("Cannot open native storage")
        }
        do {
            try execute("PRAGMA journal_mode=WAL")
            try execute("PRAGMA synchronous=FULL")
            try execute("PRAGMA fullfsync=ON")
            sqlite3_busy_timeout(db, 5000)
            try execute("CREATE TABLE IF NOT EXISTS kv (scope TEXT NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY(scope,key))")
            try execute("CREATE TABLE IF NOT EXISTS epoch (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL)")
            try execute("INSERT OR IGNORE INTO epoch VALUES (1,0)")
        } catch { sqlite3_close_v2(db); db = nil; throw error }
    }
    deinit { close() }
    public func close() {
        if lockFd >= 0 { flock(lockFd, LOCK_UN); Darwin.close(lockFd); lockFd = -1; owner = "" }
        if let db = db { sqlite3_close_v2(db); self.db = nil }
    }
    private func execute(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw NativeFailure.invalid("Native storage transaction failed") }
    }
    private func prepare(_ sql: String, _ strings: [String] = []) throws -> OpaquePointer {
        guard db != nil else { throw NativeFailure.invalid("Native storage closed") }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement = statement else { throw NativeFailure.invalid("Cannot prepare native storage operation") }
        for (index, string) in strings.enumerated() {
            guard string.utf8.count <= 16 * 1024 * 1024, !string.contains("\0"), sqlite3_bind_text(statement, Int32(index + 1), string, -1, transient) == SQLITE_OK else {
                sqlite3_finalize(statement); throw NativeFailure.invalid("Cannot bind native storage input")
            }
        }
        return statement
    }
    private func argument(_ args: [Any], _ index: Int) throws -> String {
        guard index < args.count, let value = args[index] as? String else { throw NativeFailure.invalid("Invalid storage argument") }
        return value
    }
    private func aad(_ scope: String, _ name: String) throws -> Data { try JSONEncoder().encode([scope, name]) }
    func invoke(_ method: String, _ args: [Any]) throws -> [Any] {
        if method == "storage.acquireOwner" {
            guard args.count == 1, !(try argument(args, 0)).isEmpty, lockFd == -1 else { throw NativeFailure.invalid("DELIVERY_RUNTIME_ALREADY_ACTIVE") }
            let fd = Darwin.open(lockPath, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
            guard fd >= 0 else { throw NativeFailure.invalid("Cannot open runtime ownership lock") }
            guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { Darwin.close(fd); throw NativeFailure.invalid("DELIVERY_RUNTIME_ALREADY_ACTIVE") }
            do {
                let statement = try prepare("UPDATE epoch SET value=value+1 WHERE id=1 AND value<9007199254740991 RETURNING value")
                defer { sqlite3_finalize(statement) }
                guard sqlite3_step(statement) == SQLITE_ROW else { throw NativeFailure.invalid("Cannot advance runtime epoch") }
                let epoch = sqlite3_column_int64(statement, 0)
                guard sqlite3_step(statement) == SQLITE_DONE else { throw NativeFailure.invalid("Cannot persist runtime epoch") }
                lockFd = fd; owner = UUID().uuidString
                return [epoch, owner]
            } catch { flock(fd, LOCK_UN); Darwin.close(fd); throw error }
        }
        if method == "storage.assertOwner" || method == "storage.releaseOwner" {
            guard lockFd >= 0, try argument(args, 0) == owner else { throw NativeFailure.invalid("DELIVERY_RUNTIME_FENCED") }
            if method == "storage.releaseOwner" { flock(lockFd, LOCK_UN); Darwin.close(lockFd); lockFd = -1; owner = "" }
            return []
        }
        let scope = try argument(args, 0), name = try argument(args, 1)
        if method == "storage.set" {
            let plaintext = Data(try argument(args, 2).utf8)
            let sealed = try AES.GCM.seal(plaintext, using: key, authenticating: aad(scope, name))
            guard let value = sealed.combined else { throw NativeFailure.invalid("Storage encryption failed") }
            let statement = try prepare("INSERT INTO kv VALUES (?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value", [scope, name])
            defer { sqlite3_finalize(statement) }
            let bound = value.withUnsafeBytes { sqlite3_bind_blob(statement, 3, $0.baseAddress, Int32($0.count), transient) }
            guard bound == SQLITE_OK, sqlite3_step(statement) == SQLITE_DONE else { throw NativeFailure.invalid("Native storage commit failed") }
            return []
        }
        if method == "storage.get" {
            let statement = try prepare("SELECT value FROM kv WHERE scope=? AND key=?", [scope, name])
            defer { sqlite3_finalize(statement) }
            let status = sqlite3_step(statement)
            if status == SQLITE_DONE { return [false, ""] }
            guard status == SQLITE_ROW, let bytes = sqlite3_column_blob(statement, 0) else { throw NativeFailure.invalid("Native storage read failed") }
            let ciphertext = Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 0)))
            let value = try AES.GCM.open(AES.GCM.SealedBox(combined: ciphertext), using: key, authenticating: aad(scope, name))
            guard let json = String(data: value, encoding: .utf8) else { throw NativeFailure.invalid("Native storage encoding corrupt") }
            return [true, json]
        }
        if method == "storage.delete" {
            let statement = try prepare("DELETE FROM kv WHERE scope=? AND key=?", [scope, name])
            defer { sqlite3_finalize(statement) }
            guard sqlite3_step(statement) == SQLITE_DONE else { throw NativeFailure.invalid("Native storage deletion failed") }
            return [sqlite3_changes(db) > 0]
        }
        if method == "storage.keys" {
            let statement = try prepare("SELECT key FROM kv WHERE scope=? ORDER BY key", [scope])
            defer { sqlite3_finalize(statement) }
            var keys: [String] = []
            while true {
                let status = sqlite3_step(statement)
                if status == SQLITE_DONE { return keys }
                guard status == SQLITE_ROW, let value = sqlite3_column_text(statement, 0) else { throw NativeFailure.invalid("Native storage enumeration failed") }
                let key = String(cString: value)
                if key.hasPrefix(name) { keys.append(key) }
            }
        }
        throw NativeFailure.invalid("Unknown native storage primitive")
    }
}
