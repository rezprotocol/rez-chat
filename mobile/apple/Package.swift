// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "RezNative",
    platforms: [.iOS(.v17), .macOS(.v12)],
    products: [.library(name: "RezNative", targets: ["RezNative"])],
    targets: [.target(name: "RezNative", path: ".", exclude: ["probe", "simulator.entitlements"],
        sources: ["NativeCrypto.swift", "NativeKeychain.swift", "NativeStorage.swift", "NativeNetwork.swift", "NativeEngine.swift"],
        linkerSettings: [.linkedLibrary("sqlite3")])]
)
