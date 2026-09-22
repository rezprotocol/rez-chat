import Foundation
import JavaScriptCore

// One serial executor owns the JSContext. No WebView participates in core
// execution. UI and OS callbacks enqueue work; native completion callbacks
// return to this executor before invoking JavaScript.
public final class NativeEngine {
    let queue = DispatchQueue(label: "io.rezprotocol.mobile.javascript")
    private var context: JSContext!
    private let crypto = NativeCrypto()
    private let storage: NativeStorage?
    private var network: NativeNetwork!
    private var timers: [Int: DispatchSourceTimer] = [:]
    private var nextTimer = 0
    private var failed: String?
    public var onResult: ((String) -> Void)?
    public var onFailure: (() -> Void)?

    public init(storage: NativeStorage? = nil, allowLoopback: Bool = false) throws {
        self.storage = storage
        self.network = NativeNetwork(queue: queue, allowLoopback: allowLoopback)
        try queue.sync {
            guard let context = JSContext() else { throw NativeFailure.invalid("JavaScriptCore allocation failed") }
            self.context = context
            self.network.onEvent = { [weak self] id, event, value, code in
                guard let self = self, let context = self.context else { return }
                guard let callback = context.objectForKeyedSubscript("__rezNetworkEvent"), !callback.isUndefined else {
                    self.recordFailure("Native network event handler missing")
                    return
                }
                callback.call(withArguments: [id, event, value, code])
            }
            context.exceptionHandler = { [weak self] _, value in
                guard let self = self else { return }
                self.recordFailure(value.map { $0.toString() } ?? "JavaScript exception")
            }
            let invoke: @convention(block) (String) -> String = { [weak self] json in
                guard let self = self else { return "{\"ok\":false,\"error\":\"engine closed\"}" }
                return self.invoke(json)
            }
            context.setObject(invoke, forKeyedSubscript: "__rezNativeInvoke" as NSString)
            let encode: @convention(block) (String) -> [UInt8] = { Array($0.utf8) }
            let decode: @convention(block) (String) -> String = { [weak context] json in
                guard let data = json.data(using: .utf8), let bytes = try? JSONDecoder().decode([UInt8].self, from: data) else {
                    if let context = context { context.exception = JSValue(newErrorFromMessage: "Invalid UTF-8 byte input", in: context) }
                    return ""
                }
                return String(decoding: bytes, as: UTF8.self)
            }
            context.setObject(encode, forKeyedSubscript: "__rezEncode" as NSString)
            context.setObject(decode, forKeyedSubscript: "__rezDecode" as NSString)
            let timer: @convention(block) (JSValue, Double, Bool) -> Int = { [weak self] callback, delay, repeating in
                guard let self = self else { return 0 }
                self.nextTimer += 1
                let id = self.nextTimer
                let source = DispatchSource.makeTimerSource(queue: self.queue)
                let milliseconds = max(1, min(Int(delay.isFinite ? delay : 1), 2_147_483_647))
                source.schedule(deadline: .now() + .milliseconds(milliseconds), repeating: repeating ? .milliseconds(milliseconds) : .never)
                source.setEventHandler { [weak self] in
                    guard let self = self else { return }
                    if !repeating, let timer = self.timers.removeValue(forKey: id) { timer.setEventHandler(handler: nil); timer.cancel() }
                    callback.call(withArguments: [])
                }
                self.timers[id] = source
                source.resume()
                return id
            }
            let clearTimer: @convention(block) (Int) -> Void = { [weak self] id in
                guard let self = self, let source = self.timers.removeValue(forKey: id) else { return }
                source.setEventHandler(handler: nil)
                source.cancel()
            }
            let result: @convention(block) (String) -> Void = { [weak self] value in
                guard let self = self, let handler = self.onResult else { return }
                handler(value)
            }
            context.setObject(timer, forKeyedSubscript: "__rezTimer" as NSString)
            context.setObject(clearTimer, forKeyedSubscript: "__rezClearTimer" as NSString)
            context.setObject(result, forKeyedSubscript: "__rezResult" as NSString)
            // Encoding must exist before loading modules containing constant
            // TextEncoder expressions. These are platform API mechanics only.
            context.evaluateScript("""
                globalThis.TextEncoder = class TextEncoder {
                  encode(value = '') { return Uint8Array.from(__rezEncode(String(value))); }
                };
                globalThis.TextDecoder = class TextDecoder {
                  constructor(encoding = 'utf-8', options = {}) {
                    if (String(encoding).toLowerCase() !== 'utf-8' || options.fatal) throw new Error('Unsupported decoder options');
                  }
                  decode(value = new Uint8Array()) {
                    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                    return __rezDecode(JSON.stringify(Array.from(bytes)));
                  }
                };
                globalThis.setTimeout = (fn, delay = 0, ...args) => __rezTimer(() => fn(...args), delay, false);
                globalThis.setInterval = (fn, delay = 0, ...args) => __rezTimer(() => fn(...args), delay, true);
                globalThis.clearTimeout = globalThis.clearInterval = (id) => __rezClearTimer(id);
                globalThis.queueMicrotask = (fn) => Promise.resolve().then(fn);
                globalThis.console = Object.fromEntries(['log', 'info', 'debug', 'warn', 'error'].map(level => [level, (...args) => __rezResult(JSON.stringify({level, message:args.map(String).join(' ')}))]));
            """)
            if let error = self.failed { throw NativeFailure.invalid(error) }
        }
    }

    private func recordFailure(_ message: String?) {
        failed = message ?? "JavaScript exception"
        // Async timer/network exceptions must reach the owner too; merely
        // retaining a flag until the next UI call silently lost these faults.
        if let handler = onFailure { handler() }
    }

    private func invoke(_ json: String) -> String {
        do {
            guard let data = json.data(using: .utf8), data.count <= 16 * 1024 * 1024,
                  let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let method = request["method"] as? String, let args = request["args"] as? [Any],
                  args.allSatisfy({ $0 is String || $0 is NSNumber }) else { throw NativeFailure.invalid("Invalid native primitive request") }
            let values: [Any]
            if method.hasPrefix("crypto.") { values = try crypto.invoke(method, args) }
            else if method.hasPrefix("storage."), let storage = storage { values = try storage.invoke(method, args) }
            else if method.hasPrefix("network.") { values = try network.invoke(method, args) }
            else if method == "url.parse" {
                guard args.count == 2, let input = args[0] as? String, let base = args[1] as? String,
                      let url = URL(string: input, relativeTo: base.isEmpty ? nil : URL(string: base)),
                      let parts = URLComponents(url: url.absoluteURL, resolvingAgainstBaseURL: true),
                      let scheme = parts.scheme, let host = parts.host else { throw NativeFailure.invalid("Invalid absolute URL") }
                values = [url.absoluteURL.absoluteString, scheme + ":", host, parts.port.map(String.init) ?? "", parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath,
                          parts.percentEncodedQuery.map { "?" + $0 } ?? "", parts.percentEncodedFragment.map { "#" + $0 } ?? "", parts.user ?? "", parts.password ?? ""]
            }
            else if method == "bytes.base64Encode" {
                guard let json = args.first as? String, let input = json.data(using: .utf8) else { throw NativeFailure.invalid("Invalid byte input") }
                values = [Data(try JSONDecoder().decode([UInt8].self, from: input)).base64EncodedString()]
            } else if method == "bytes.base64Decode" {
                guard let input = args.first as? String, let bytes = Data(base64Encoded: input) else { throw NativeFailure.invalid("Invalid base64") }
                values = [String(decoding: try JSONEncoder().encode(Array(bytes)), as: UTF8.self)]
            } else { throw NativeFailure.invalid("Unknown native primitive") }
            return String(decoding: try JSONSerialization.data(withJSONObject: ["ok": true, "values": values]), as: UTF8.self)
        } catch {
            let message: String
            if let failure = error as? NativeFailure { message = failure.localizedDescription }
            else { message = "Native primitive failed" }
            // Never include the request, key bytes or provider data in errors.
            let code = ["DELIVERY_RUNTIME_ALREADY_ACTIVE", "DELIVERY_RUNTIME_FENCED"].contains(message) ? message : "NATIVE_PRIMITIVE_FAILED"
            let output: [String: Any] = ["ok": false, "error": message, "code": code]
            guard let data = try? JSONSerialization.data(withJSONObject: output) else { return "{\"ok\":false,\"error\":\"native error encoding failed\"}" }
            return String(decoding: data, as: UTF8.self)
        }
    }

    public func evaluate(_ source: String) throws {
        try queue.sync {
            failed = nil
            guard let context = context else { throw NativeFailure.invalid("Native engine closed") }
            context.evaluateScript(source)
            if let error = failed { throw NativeFailure.invalid(error) }
        }
    }
    public func post(_ function: String, value: String) throws {
        try queue.sync {
            guard let context = context, let callback = context.objectForKeyedSubscript(function), callback.isObject else { throw NativeFailure.invalid("Native JS entrypoint unavailable") }
            failed = nil
            callback.call(withArguments: [value])
            if let error = failed { throw NativeFailure.invalid(error) }
        }
    }
    public func close() {
        queue.sync {
            for timer in timers.values { timer.setEventHandler(handler: nil); timer.cancel() }
            timers.removeAll()
            network.close()
            context = nil
            if let storage = storage { storage.close() }
        }
    }
}
