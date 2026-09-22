import Foundation

final class NativeNetwork: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let queue: DispatchQueue
    private let allowLoopback: Bool
    private var session: URLSession!
    private var sockets: [String: URLSessionWebSocketTask] = [:]
    var onEvent: ((String, String, String, Int) -> Void)?
    init(queue: DispatchQueue, allowLoopback: Bool) {
        self.queue = queue
        self.allowLoopback = allowLoopback
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCache = nil
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }
    private func emit(_ id: String, _ event: String, _ value: String = "", _ code: Int = 0) {
        if let handler = onEvent { handler(id, event, value, code) }
    }
    private func fail(_ id: String) {
        guard let task = sockets.removeValue(forKey: id) else { return }
        task.cancel(with: .goingAway, reason: nil)
        emit(id, "error", "Network connection failed")
        emit(id, "close", "", 1006)
    }
    private func receive(_ id: String, _ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self = self else { return }
            self.queue.async {
                guard self.sockets[id] === task else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text): self.emit(id, "message", text)
                    case .data(let data): self.emit(id, "binary", data.base64EncodedString())
                    @unknown default: self.fail(id); return
                    }
                    self.receive(id, task)
                case .failure: self.fail(id)
                }
            }
        }
    }
    func invoke(_ method: String, _ args: [Any]) throws -> [Any] {
        guard let first = args.first as? String else { throw NativeFailure.invalid("Invalid network input") }
        if method == "network.open" {
            guard let url = URL(string: first), let scheme = url.scheme, url.user == nil, url.password == nil,
                  scheme == "wss" || (allowLoopback && scheme == "ws" && ["127.0.0.1", "localhost", "[::1]"].contains(url.host ?? "")) else { throw NativeFailure.invalid("Mobile uplink requires a secure WebSocket URL") }
            guard sockets.count < 32 else { throw NativeFailure.invalid("Native socket limit reached") }
            let id = UUID().uuidString
            let socket = session.webSocketTask(with: url)
            socket.maximumMessageSize = 1_000_000
            sockets[id] = socket
            socket.taskDescription = id
            socket.resume()
            return [id]
        }
        guard let socket = sockets[first] else { throw NativeFailure.invalid("Native socket is closed") }
        if method == "network.send" {
            guard args.count == 2, let text = args[1] as? String, text.utf8.count <= 1_000_000 else { throw NativeFailure.invalid("Invalid native socket frame") }
            socket.send(.string(text)) { [weak self] error in
                guard error != nil, let self = self else { return }
                self.queue.async { self.fail(first) }
            }
            return []
        }
        if method == "network.close" {
            sockets.removeValue(forKey: first)
            socket.cancel(with: .normalClosure, reason: nil)
            queue.async { self.emit(first, "close", "", 1000) }
            return []
        }
        throw NativeFailure.invalid("Unknown native network primitive")
    }
    func close() {
        for socket in sockets.values { socket.cancel(with: .goingAway, reason: nil) }
        sockets.removeAll()
        session.invalidateAndCancel()
        onEvent = nil
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        queue.async {
            guard let id = webSocketTask.taskDescription, self.sockets[id] === webSocketTask else { return }
            self.emit(id, "open")
            self.receive(id, webSocketTask)
        }
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        queue.async {
            guard let id = webSocketTask.taskDescription, self.sockets.removeValue(forKey: id) != nil else { return }
            self.emit(id, "close", "", closeCode.rawValue)
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard error != nil else { return }
        queue.async { if let id = task.taskDescription { self.fail(id) } }
    }
}
