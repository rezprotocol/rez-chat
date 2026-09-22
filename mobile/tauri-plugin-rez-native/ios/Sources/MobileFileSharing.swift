import Foundation
import UIKit
import WebKit
import Tauri

private struct ShareArgs: Decodable { let request: String }
private struct ShareFile: Decodable { let fileName: String; let fileDataB64: String }

// Only user-selected bytes cross this OS boundary. Native never resolves
// message IDs, decrypts attachments, or chooses recipients.
final class MobileFileSharing {
    weak var webview: WKWebView?
    private var busy = false
    private let directory = FileManager.default.temporaryDirectory.appendingPathComponent("RezShare", isDirectory: true)

    func share(_ invoke: Invoke) {
        DispatchQueue.main.async { self.present(invoke) }
    }
    private func present(_ invoke: Invoke) {
        guard !busy else { invoke.reject("Finish sharing the current file first"); return }
        var temporary: URL?
        do {
            let args = try invoke.parseArgs(ShareArgs.self)
            guard args.request.utf8.count <= 16 * 1024 * 1024, let json = args.request.data(using: .utf8) else { throw failure("File is too large") }
            let file = try JSONDecoder().decode(ShareFile.self, from: json)
            guard !file.fileName.isEmpty, file.fileName.utf8.count <= 255,
                  file.fileName != ".", file.fileName != "..",
                  file.fileName.rangeOfCharacter(from: CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "/\\"))) == nil,
                  file.fileDataB64.count <= 14_000_000,
                  let bytes = Data(base64Encoded: file.fileDataB64), !bytes.isEmpty, bytes.count <= 10 * 1024 * 1024 else { throw failure("Invalid file") }
            guard let view = webview, let window = view.window, var presenter = window.rootViewController,
                  UIApplication.shared.applicationState == .active else { throw failure("Open Rez Chat to share this file") }
            while let presented = presenter.presentedViewController { presenter = presented }
            guard !presenter.isBeingDismissed else { throw failure("Wait for the current screen to close") }
            // Remove a previous process's abandoned export before staging another.
            if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
            temporary = directory
            let url = directory.appendingPathComponent(file.fileName, isDirectory: false)
            try bytes.write(to: url, options: [.atomic, .completeFileProtection])
            var attributes = URLResourceValues()
            attributes.isExcludedFromBackup = true
            var protectedDirectory = directory
            try protectedDirectory.setResourceValues(attributes)
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = view
                popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            }
            sheet.completionWithItemsHandler = { [self] _, completed, _, error in
                busy = false
                do { try FileManager.default.removeItem(at: directory) }
                catch { invoke.reject("Could not remove the temporary shared file"); return }
                if error != nil { invoke.reject("Could not share this file") }
                else { invoke.resolve(["canceled": !completed]) }
            }
            busy = true
            presenter.present(sheet, animated: true)
        } catch {
            if let temporary = temporary {
                do { try FileManager.default.removeItem(at: temporary) }
                catch { invoke.reject("Could not remove the temporary shared file"); return }
            }
            invoke.reject(error.localizedDescription)
        }
    }
    private func failure(_ message: String) -> NSError {
        NSError(domain: "RezShare", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
