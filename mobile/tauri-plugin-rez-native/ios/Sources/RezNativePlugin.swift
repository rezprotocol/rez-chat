import Foundation
import Tauri
import RezNative
import WebKit

private struct NativeDispatchArgs: Decodable { let request: String }
private struct NativeRequestIdentity: Decodable { let id: String }
private struct NativeSubscribeArgs: Decodable { let channel: Channel }

// Data-only transport. No chat directives or convergence decisions live here.
final class RezNativePlugin: Plugin {
    private var application: MobileApplication?
    private var pending: [String: Invoke] = [:]
    private var pendingSizes: [String: Int] = [:]
    private var channel: Channel?
    private var failed = false
    private let fileSharing = MobileFileSharing()
    override public func load(webview: WKWebView) { fileSharing.webview = webview }
    @objc public func shareFile(_ invoke: Invoke) { fileSharing.share(invoke) }
    private func ready() throws -> MobileApplication {
        if failed { throw NSError(domain: "RezMobile", code: 2, userInfo: [NSLocalizedDescriptionKey: "Native execution failed. Restart Rez Chat to recover durable state."]) }
        if let application = application { return application }
        let created = try MobileApplication()
        created.onFailure = { [weak self] in
            guard let self = self else { return }
            self.failed = true
            for invoke in self.pending.values { invoke.reject("Native execution failed. Restart Rez Chat to recover durable state.") }
            self.pending.removeAll()
            self.pendingSizes.removeAll()
        }
        created.onOutput = { [weak self] json in
            DispatchQueue.main.async {
                guard let self = self, let bytes = json.data(using: .utf8),
                      let record = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { return }
                if let id = record["id"] as? String, let invoke = self.pending.removeValue(forKey: id) {
                    self.pendingSizes.removeValue(forKey: id)
                    invoke.resolve(json)
                }
                else if record["event"] is String, let channel = self.channel {
                    do { try channel.send(json) } catch { NSLog("Rez UI event delivery failed") }
                } else if record["level"] as? String == "error" || record["level"] as? String == "warn" {
                    NSLog("Rez native runtime reported a diagnostic; inspect app diagnostics")
                }
            }
        }
        application = created
        return created
    }
    @objc public func subscribe(_ invoke: Invoke) {
        do {
            let args = try invoke.parseArgs(NativeSubscribeArgs.self)
            _ = try ready()
            channel = args.channel
            invoke.resolve()
        } catch { invoke.reject("Native startup failed: " + error.localizedDescription) }
    }
    @objc public func dispatch(_ invoke: Invoke) {
        do {
            let args = try invoke.parseArgs(NativeDispatchArgs.self)
            guard args.request.utf8.count <= 16 * 1024 * 1024, let data = args.request.data(using: .utf8) else { invoke.reject("Invalid host request"); return }
            let identity = try JSONDecoder().decode(NativeRequestIdentity.self, from: data)
            guard !identity.id.isEmpty, identity.id.count <= 128, pending[identity.id] == nil, pending.count < 128,
                  pendingSizes.values.reduce(0, +) + data.count <= 32 * 1024 * 1024 else { invoke.reject("Host request limit reached; wait for the current transfer"); return }
            let application = try ready()
            pending[identity.id] = invoke
            pendingSizes[identity.id] = data.count
            // Enrollment/activation have a bounded 180-second JS deadline.
            // Keep the generic transport alive through that application result.
            DispatchQueue.main.asyncAfter(deadline: .now() + 210) { [weak self, weak invoke] in
                guard let self = self, let invoke = invoke, self.pending[identity.id] === invoke else { return }
                self.pending.removeValue(forKey: identity.id)
                self.pendingSizes.removeValue(forKey: identity.id)
                invoke.reject("Native request timed out; its result is uncertain. Refresh before retrying.")
            }
            do { try application.dispatch(args.request) }
            catch { pending.removeValue(forKey: identity.id); pendingSizes.removeValue(forKey: identity.id); throw error }
        } catch { invoke.reject("Native request failed: " + error.localizedDescription) }
    }
}

@_cdecl("init_plugin_rez_native")
func initPlugin() -> Plugin { RezNativePlugin() }
