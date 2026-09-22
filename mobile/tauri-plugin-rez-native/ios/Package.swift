// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-rez-native",
    platforms: [.iOS(.v17), .macOS(.v12)],
    products: [.library(name: "tauri-plugin-rez-native", type: .static, targets: ["RezNativePlugin"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api"), .package(path: "../../apple")],
    targets: [.target(name: "RezNativePlugin", dependencies: [.product(name: "Tauri", package: "Tauri"), .product(name: "RezNative", package: "apple")], path: "Sources")]
)
