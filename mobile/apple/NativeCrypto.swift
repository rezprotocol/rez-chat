import Foundation
import CryptoKit
import Security
import CommonCrypto

enum NativeFailure: Error, LocalizedError {
    case invalid(String)
    var errorDescription: String? { switch self { case .invalid(let message): return message } }
}

// Only standard primitives and encodings live here. The existing JS SDK owns
// every protocol object, key purpose, ratchet and receive-commit decision.
final class NativeCrypto {
    private func data(_ value: Any) throws -> Data {
        guard let string = value as? String, let result = Data(base64Encoded: string) else { throw NativeFailure.invalid("Invalid base64 bytes") }
        return result
    }
    private func string(_ args: [Any], _ index: Int) throws -> String {
        guard index < args.count, let value = args[index] as? String else { throw NativeFailure.invalid("Missing string argument") }
        return value
    }
    private func integer(_ args: [Any], _ index: Int, _ range: ClosedRange<Int>) throws -> Int {
        guard index < args.count, let number = args[index] as? NSNumber else { throw NativeFailure.invalid("Missing integer argument") }
        let value = number.intValue
        guard number.doubleValue == Double(value), range.contains(value) else { throw NativeFailure.invalid("Integer out of range") }
        return value
    }
    private func prefix(_ algorithm: String, _ format: String) throws -> Data {
        guard algorithm == "Ed25519" || algorithm == "X25519" else { throw NativeFailure.invalid("Unsupported curve") }
        let oid: UInt8 = algorithm == "Ed25519" ? 0x70 : 0x6e
        if format == "spki" { return Data([0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,oid,0x03,0x21,0x00]) }
        if format == "pkcs8" { return Data([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,oid,0x04,0x22,0x04,0x20]) }
        throw NativeFailure.invalid("Unsupported curve encoding")
    }
    private func rawKey(_ algorithm: String, _ format: String, _ encoded: Data) throws -> Data {
        let header = try prefix(algorithm, format)
        guard encoded.count == header.count + 32, encoded.starts(with: header) else { throw NativeFailure.invalid("Invalid curve key encoding") }
        return encoded.suffix(32)
    }
    private func encodeKey(_ algorithm: String, _ format: String, _ raw: Data) throws -> String {
        return (try prefix(algorithm, format) + raw).base64EncodedString()
    }
    private func publicRaw(_ algorithm: String, _ format: String, _ encoded: Data) throws -> Data {
        let raw = try rawKey(algorithm, format, encoded)
        if format == "spki" { return raw }
        if algorithm == "Ed25519" { return try Curve25519.Signing.PrivateKey(rawRepresentation: raw).publicKey.rawRepresentation }
        return try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw).publicKey.rawRepresentation
    }
    func invoke(_ method: String, _ args: [Any]) throws -> [Any] {
        switch method {
        case "crypto.random":
            let count = try integer(args, 0, 0...65536)
            if count == 0 { return [""] }
            var result = Data(count: count)
            let status = result.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
            guard status == errSecSuccess else { throw NativeFailure.invalid("Secure random failed") }
            return [result.base64EncodedString()]
        case "crypto.digest":
            let algorithm = try string(args, 0), input = try data(string(args, 1))
            if algorithm == "SHA-256" { return [Data(SHA256.hash(data: input)).base64EncodedString()] }
            if algorithm == "SHA-512" { return [Data(SHA512.hash(data: input)).base64EncodedString()] }
            throw NativeFailure.invalid("Unsupported digest")
        case "crypto.validateKey":
            let algorithm = try string(args, 0), format = try string(args, 1), encoded = try data(string(args, 2))
            if algorithm == "Ed25519" || algorithm == "X25519" { _ = try rawKey(algorithm, format, encoded) }
            else if algorithm == "AES-GCM" { guard format == "raw", encoded.count == 32 else { throw NativeFailure.invalid("AES requires 32 raw bytes") } }
            else if algorithm == "HKDF" || algorithm == "PBKDF2" { guard format == "raw" else { throw NativeFailure.invalid("KDF requires raw bytes") } }
            else { throw NativeFailure.invalid("Unsupported key algorithm") }
            return []
        case "crypto.generate":
            let algorithm = try string(args, 0)
            if algorithm == "Ed25519" {
                let key = Curve25519.Signing.PrivateKey()
                return [try encodeKey(algorithm, "spki", key.publicKey.rawRepresentation), try encodeKey(algorithm, "pkcs8", key.rawRepresentation)]
            }
            if algorithm == "X25519" {
                let key = Curve25519.KeyAgreement.PrivateKey()
                return [try encodeKey(algorithm, "spki", key.publicKey.rawRepresentation), try encodeKey(algorithm, "pkcs8", key.rawRepresentation)]
            }
            throw NativeFailure.invalid("Unsupported generated key")
        case "crypto.sign":
            guard try string(args, 0) == "Ed25519" else { throw NativeFailure.invalid("Unsupported signature") }
            let raw = try rawKey("Ed25519", "pkcs8", data(string(args, 1)))
            let key = try Curve25519.Signing.PrivateKey(rawRepresentation: raw)
            return [try key.signature(for: data(string(args, 2))).base64EncodedString()]
        case "crypto.verify":
            guard try string(args, 0) == "Ed25519" else { throw NativeFailure.invalid("Unsupported signature") }
            let raw = try rawKey("Ed25519", "spki", data(string(args, 1)))
            let key = try Curve25519.Signing.PublicKey(rawRepresentation: raw)
            return [try key.isValidSignature(data(string(args, 2)), for: data(string(args, 3)))]
        case "crypto.dh":
            let privateKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: rawKey("X25519", "pkcs8", data(string(args, 0))))
            let publicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: rawKey("X25519", "spki", data(string(args, 1))))
            let secret = try privateKey.sharedSecretFromKeyAgreement(with: publicKey)
            return [secret.withUnsafeBytes { Data($0).base64EncodedString() }]
        case "crypto.hkdf":
            guard try string(args, 0) == "SHA-256" else { throw NativeFailure.invalid("Unsupported HKDF hash") }
            let key = SymmetricKey(data: try data(string(args, 1)))
            let salt = try data(string(args, 2)), info = try data(string(args, 3))
            let count = try integer(args, 4, 1...8160)
            let derived = HKDF<SHA256>.deriveKey(inputKeyMaterial: key, salt: salt, info: info, outputByteCount: count)
            return [derived.withUnsafeBytes { Data($0).base64EncodedString() }]
        case "crypto.pbkdf":
            let algorithm = try string(args, 0)
            guard algorithm == "SHA-256" || algorithm == "SHA-512" else { throw NativeFailure.invalid("Unsupported PBKDF hash") }
            let password = try data(string(args, 1)), salt = try data(string(args, 2))
            let rounds = try integer(args, 3, 1...10_000_000), count = try integer(args, 4, 1...4096)
            var output = Data(count: count)
            let status = output.withUnsafeMutableBytes { destination in password.withUnsafeBytes { source in salt.withUnsafeBytes { saltBytes in
                CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), source.bindMemory(to: Int8.self).baseAddress, password.count, saltBytes.bindMemory(to: UInt8.self).baseAddress, salt.count, CCPseudoRandomAlgorithm(algorithm == "SHA-256" ? kCCPRFHmacAlgSHA256 : kCCPRFHmacAlgSHA512), UInt32(rounds), destination.bindMemory(to: UInt8.self).baseAddress, count)
            } } }
            guard status == kCCSuccess else { throw NativeFailure.invalid("PBKDF derivation failed") }
            return [output.base64EncodedString()]
        case "crypto.encrypt", "crypto.decrypt":
            let keyBytes = try data(string(args, 0)), nonceBytes = try data(string(args, 1))
            guard keyBytes.count == 32, nonceBytes.count == 12 else { throw NativeFailure.invalid("Invalid AES-GCM key/nonce") }
            let key = SymmetricKey(data: keyBytes), nonce = try AES.GCM.Nonce(data: nonceBytes)
            let input = try data(string(args, 2)), aad = try data(string(args, 3))
            if method == "crypto.encrypt" {
                let box = try AES.GCM.seal(input, using: key, nonce: nonce, authenticating: aad)
                return [(box.ciphertext + box.tag).base64EncodedString()]
            }
            guard input.count >= 16 else { throw NativeFailure.invalid("Truncated AES-GCM ciphertext") }
            let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: input.dropLast(16), tag: input.suffix(16))
            return [try AES.GCM.open(box, using: key, authenticating: aad).base64EncodedString()]
        case "crypto.exportJwk":
            let raw = try publicRaw(string(args, 0), string(args, 1), data(string(args, 2)))
            return [raw.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")]
        case "crypto.publicJwk":
            let value = try string(args, 1).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            let padded = value + String(repeating: "=", count: (4 - value.count % 4) % 4)
            guard let raw = Data(base64Encoded: padded), raw.count == 32 else { throw NativeFailure.invalid("Invalid JWK public key") }
            return [try encodeKey(string(args, 0), "spki", raw)]
        default: throw NativeFailure.invalid("Unknown crypto primitive")
        }
    }
}
