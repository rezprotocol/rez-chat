import Foundation
import CryptoKit

do {
    guard CommandLine.arguments.count == 2 else { throw NativeFailure.invalid("Usage: native-probe <bundle.js>") }
    let storage: NativeStorage?
    if let path = ProcessInfo.processInfo.environment["REZ_NATIVE_PROBE_STORE"] {
        // Public fixture key in this test executable only; app targets use Keychain.
        storage = try NativeStorage(directory: URL(fileURLWithPath: path), key: SymmetricKey(data: Data(repeating: 7, count: 32)))
    } else { storage = nil }
    let engine = try NativeEngine(storage: storage, allowLoopback: true)
    let completion = DispatchSemaphore(value: 0)
    var completed = false
    var passed = false
    engine.onResult = { value in
        print(value)
        fflush(stdout)
        if let data = value.data(using: .utf8),
           let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           result["complete"] as? Bool == true {
            completed = true
            passed = result["ok"] as? Bool == true
            completion.signal()
        }
    }
    try engine.evaluate(String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8))
    if ProcessInfo.processInfo.environment["REZ_NATIVE_PROBE_SERVE"] == "1" {
        while let request = readLine() { try engine.post("__rezMobileRequest", value: request) }
        engine.close()
        exit(0)
    }
    guard completion.wait(timeout: .now() + 30) == .success, completed else { throw NativeFailure.invalid("Native probe did not complete") }
    engine.close()
    guard passed else { throw NativeFailure.invalid("Native assertions failed") }
} catch {
    fputs("Native probe failed: \(error.localizedDescription)\n", stderr)
    exit(1)
}
