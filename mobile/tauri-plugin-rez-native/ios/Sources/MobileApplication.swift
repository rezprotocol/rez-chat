import Foundation
import UIKit
import Network
import RezNative

// OS mechanics only; this owner has no WKWebView reference.
final class MobileApplication {
    private let engine: NativeEngine
    private var observers: [NSObjectProtocol] = []
    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "io.rezprotocol.mobile.network-monitor")
    private var wakes: [String: (Bool) -> Void] = [:]
    var onOutput: ((String) -> Void)?
    var onFailure: (() -> Void)?
    init() throws {
        guard let core = Bundle.main.url(forResource: "mobile-core", withExtension: "js", subdirectory: "assets"),
              let deployment = Bundle.main.url(forResource: "mobile-deployment", withExtension: "json", subdirectory: "assets") else {
            throw NSError(domain: "RezMobile", code: 1, userInfo: [NSLocalizedDescriptionKey: "Mobile application resources are missing"])
        }
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("RezChat", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication, .posixPermissions: 0o700])
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
        let exists = FileManager.default.fileExists(atPath: directory.appendingPathComponent("store.sqlite").path)
        let key = try NativeKeychain.storageKey(service: "io.rezprotocol.chat.mobile", existingStore: exists)
        let storage = try NativeStorage(directory: directory, key: key)
        for name in ["store.sqlite", "store.sqlite-wal", "store.sqlite-shm", "runtime.lock"] {
            let path = directory.appendingPathComponent(name).path
            if FileManager.default.fileExists(atPath: path) {
                try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: path)
            }
        }
        engine = try NativeEngine(storage: storage)
        engine.onResult = { [weak self] json in
            DispatchQueue.main.async { [weak self] in if let self = self { self.receive(json) } }
        }
        engine.onFailure = { [weak self] in
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                for callback in self.wakes.values { callback(false) }
                self.wakes.removeAll()
                if let handler = self.onFailure { handler() }
                NSLog("Rez native JavaScript execution failed")
            }
        }
        try engine.evaluate(String(contentsOf: core, encoding: .utf8))
        try engine.post("__rezStartMobile", value: String(contentsOf: deployment, encoding: .utf8))
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in if let self = self { self.wake("onForeground") } })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in if let self = self { self.wake("onBackground") } })
        monitor.pathUpdateHandler = { [weak self] path in if path.status == .satisfied, let self = self { self.wake("onNetworkAvailable") } }
        monitor.start(queue: monitorQueue)
        wake(UIApplication.shared.applicationState == .active ? "onForeground" : "onBackground")
    }
    func dispatch(_ json: String) throws { try engine.post("__rezMobileRequest", value: json) }
    private func receive(_ json: String) {
        if let data = json.data(using: .utf8),
           let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           record["type"] as? String == "chat.mobile.lifecycleResult.v1",
           let id = record["id"] as? String, let completion = wakes.removeValue(forKey: id) {
            if record["ok"] as? Bool != true { NSLog("Rez lifecycle did not complete; awaiting a later OS wake") }
            completion(record["ok"] as? Bool == true)
            return
        }
        if let handler = onOutput { handler(json) }
    }
    func wake(_ name: String, completion: ((Bool) -> Void)? = nil) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { if let completion = completion { completion(false) }; return }
            let id = "os:" + UUID().uuidString
            var task = UIBackgroundTaskIdentifier.invalid
            var finished = false
            let finish: (Bool) -> Void = { success in
                guard !finished else { return }
                finished = true
                if task != .invalid { UIApplication.shared.endBackgroundTask(task); task = .invalid }
                if let completion = completion { completion(success) }
            }
            self.wakes[id] = finish
            // Await the JS completion record before ending an OS execution
            // grant. Expiration also completes exactly once; durable replay
            // remains the JS SDK's responsibility after suspension.
            if UIApplication.shared.applicationState == .background {
                task = UIApplication.shared.beginBackgroundTask(withName: "Rez lifecycle") { [weak self] in
                    if let self = self, let callback = self.wakes.removeValue(forKey: id) { callback(false) }
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
                if let self = self, let callback = self.wakes.removeValue(forKey: id) {
                    NSLog("Rez lifecycle execution window expired")
                    callback(false)
                }
            }
            do {
                let data = try JSONSerialization.data(withJSONObject: ["type": "chat.mobile.lifecycleRequest.v1", "id": id, "name": name])
                try self.engine.post("__rezMobileLifecycle", value: String(decoding: data, as: UTF8.self))
            } catch {
                if let callback = self.wakes.removeValue(forKey: id) { callback(false) }
                NSLog("Rez native lifecycle dispatch failed")
            }
        }
    }
    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        monitor.cancel()
        for callback in wakes.values { callback(false) }
        wakes.removeAll()
        engine.close()
    }
}
