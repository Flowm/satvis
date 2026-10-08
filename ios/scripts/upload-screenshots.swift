// Replaces the App Store screenshots of the version being prepared with
// ios/screenshots/*.png, through the App Store Connect API: in the app's primary
// language, one screenshot set per display size, in the order of their names.
//
//   ASC_KEY_ID=… ASC_ISSUER_ID=… swift scripts/upload-screenshots.swift [--dry-run]
//
// The key is an App Store Connect API key with the App Manager role (Users and
// Access, Integrations): the .p8 file at ASC_KEY_PATH, or else, base64-encoded,
// the login keychain's password for the service "App Store Connect API" and the
// key's id as the account:
//
//   security add-generic-password -s "App Store Connect API" -a <key id> -w "$(base64 -i AuthKey_<key id>.p8)"
//
// --dry-run says what would be replaced and changes nothing.
import CryptoKit
import Foundation
import ImageIO

let bundleID = "org.frcy.app.satvis"
let directory = URL(fileURLWithPath: "screenshots")
let api = URL(string: "https://api.appstoreconnect.apple.com")!
/// The version states whose metadata can still be edited.
let editableStates = "PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,REJECTED,METADATA_REJECTED,INVALID_BINARY"

/// The API's display type for a screenshot's portrait width in pixels: the sizes
/// App Store Connect accepts for each (screenshot specifications).
func displayType(width: Int) -> String? {
    switch width {
    case 1179, 1206: "APP_IPHONE_61"  // 6.3", Dynamic Island (medium), the required one
    case 1260, 1290, 1320: "APP_IPHONE_67"  // 6.9", Dynamic Island (large)
    case 2048, 2064: "APP_IPAD_PRO_3GEN_129"  // 13" iPad
    default: nil
    }
}

struct Failure: Error, CustomStringConvertible {
    let description: String
}

// Line by line into a pipe or a log too, not when the script ends.
setvbuf(stdout, nil, _IOLBF, 0)
let environment = ProcessInfo.processInfo.environment
let dryRun = CommandLine.arguments.contains("--dry-run")
guard let keyID = environment["ASC_KEY_ID"], let issuerID = environment["ASC_ISSUER_ID"] else {
    FileHandle.standardError.write(Data("Set ASC_KEY_ID and ASC_ISSUER_ID, the App Store Connect API key's ids.\n".utf8))
    exit(2)
}
/// The key's PEM, from ASC_KEY_PATH or the keychain, which asks before letting
/// `security` read it. Base64 there, as `security` prints a password with line
/// breaks in hex.
func keyPEM() -> String? {
    if let path = environment["ASC_KEY_PATH"] {
        return try? String(contentsOfFile: path, encoding: .utf8)
    }
    let security = Process()
    let output = Pipe()
    security.executableURL = URL(fileURLWithPath: "/usr/bin/security")
    security.arguments = ["find-generic-password", "-s", "App Store Connect API", "-a", keyID, "-w"]
    security.standardOutput = output
    guard (try? security.run()) != nil else {
        return nil
    }
    let encoded = output.fileHandleForReading.readDataToEndOfFile()
    security.waitUntilExit()
    return security.terminationStatus == 0
        ? Data(base64Encoded: String(decoding: encoded, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)).map {
            String(decoding: $0, as: UTF8.self)
        } : nil
}
guard let pem = keyPEM(), let key = try? P256.Signing.PrivateKey(pemRepresentation: pem) else {
    FileHandle.standardError.write(
        Data("No App Store Connect API key \(keyID) at ASC_KEY_PATH or in the keychain (service \"App Store Connect API\")\n".utf8))
    exit(2)
}

/// A token for the next 10 minutes; the API takes none valid for longer than 20.
func token() throws -> String {
    func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
    let now = Int(Date().timeIntervalSince1970)
    let header = try JSONSerialization.data(withJSONObject: ["alg": "ES256", "kid": keyID, "typ": "JWT"])
    let claims = try JSONSerialization.data(withJSONObject: [
        "iss": issuerID, "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1",
    ])
    let signed = base64URL(header) + "." + base64URL(claims)
    return signed + "." + base64URL(try key.signature(for: Data(signed.utf8)).rawRepresentation)
}

/// Calls the API and returns its JSON document, or nothing for a 204.
@discardableResult
func call(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
    var request = URLRequest(url: URL(string: path, relativeTo: api)!)
    request.httpMethod = method
    request.setValue("Bearer \(try token())", forHTTPHeaderField: "Authorization")
    if let body {
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as! HTTPURLResponse).statusCode
    guard (200..<300).contains(status) else {
        throw Failure(description: "\(method) \(path): HTTP \(status)\n\(String(decoding: data, as: UTF8.self))")
    }
    return data.isEmpty ? [:] : try JSONSerialization.jsonObject(with: data) as! [String: Any]
}

/// The `data` array of a list.
func list(_ path: String) async throws -> [[String: Any]] {
    try await call("GET", path)["data"] as? [[String: Any]] ?? []
}

func attributes(_ resource: [String: Any]) -> [String: Any] { resource["attributes"] as? [String: Any] ?? [:] }
func id(_ resource: [String: Any]) -> String { resource["id"] as! String }

/// Uploads every set.
func main() async throws {
    // The screenshots, by display type, each set in the order of the file names.
    var sets: [String: [URL]] = [:]
    for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
    where file.pathExtension == "png" {
        guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
            let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int
        else { throw Failure(description: "Cannot read \(file.lastPathComponent)") }
        guard let type = displayType(width: min(width, height)) else {
            throw Failure(description: "\(file.lastPathComponent) is \(width) × \(height), no App Store size")
        }
        sets[type, default: []].append(file)
    }
    guard !sets.isEmpty else { throw Failure(description: "No screenshots in \(directory.path); run make screenshots") }

    guard let app = try await list("/v1/apps?filter%5BbundleId%5D=\(bundleID)").first else {
        throw Failure(description: "No app \(bundleID) for this key")
    }
    let primaryLocale = attributes(app)["primaryLocale"] as! String
    guard let version = try await list("/v1/apps/\(id(app))/appStoreVersions?filter%5Bplatform%5D=IOS&filter%5BappVersionState%5D=\(editableStates)").first
    else { throw Failure(description: "No iOS version of \(bundleID) whose screenshots can be edited") }
    guard
        let localization = try await list("/v1/appStoreVersions/\(id(version))/appStoreVersionLocalizations").first(where: {
            attributes($0)["locale"] as? String == primaryLocale
        })
    else { throw Failure(description: "Version \(attributes(version)["versionString"]!) has no \(primaryLocale) localization") }
    print("Version \(attributes(version)["versionString"]!), \(primaryLocale)\(dryRun ? ", dry run" : "")")

    let existing = try await list("/v1/appStoreVersionLocalizations/\(id(localization))/appScreenshotSets")
    // The uploaded screenshots App Store Connect has yet to accept.
    var pending: [(id: String, name: String)] = []
    for (type, files) in sets.sorted(by: { $0.key < $1.key }) {
        let files = files.sorted { $0.lastPathComponent < $1.lastPathComponent }
        let set = existing.first { attributes($0)["screenshotDisplayType"] as? String == type }
        var old: [[String: Any]] = []
        if let set {
            old = try await list("/v1/appScreenshotSets/\(id(set))/appScreenshots")
        }
        print("\(type): \(old.count) replaced by \(files.map(\.lastPathComponent).joined(separator: ", "))")
        if dryRun {
            continue
        }

        let setID: String
        if let set {
            setID = id(set)
        } else {
            setID = id(
                try await call(
                    "POST", "/v1/appScreenshotSets",
                    [
                        "data": [
                            "type": "appScreenshotSets", "attributes": ["screenshotDisplayType": type],
                            "relationships": ["appStoreVersionLocalization": ["data": ["type": "appStoreVersionLocalizations", "id": id(localization)]]],
                        ]
                    ])["data"] as! [String: Any])
        }
        for screenshot in old {
            try await call("DELETE", "/v1/appScreenshots/\(id(screenshot))")
        }

        var uploaded: [String] = []
        for file in files {
            let data = try Data(contentsOf: file)
            // Reserve, send the parts it asks for, then commit with the file's MD5.
            let reservation =
                try await call(
                    "POST", "/v1/appScreenshots",
                    [
                        "data": [
                            "type": "appScreenshots", "attributes": ["fileName": file.lastPathComponent, "fileSize": data.count],
                            "relationships": ["appScreenshotSet": ["data": ["type": "appScreenshotSets", "id": setID]]],
                        ]
                    ])["data"] as! [String: Any]
            for operation in attributes(reservation)["uploadOperations"] as! [[String: Any]] {
                var request = URLRequest(url: URL(string: operation["url"] as! String)!)
                request.httpMethod = operation["method"] as? String
                for header in operation["requestHeaders"] as? [[String: String]] ?? [] {
                    request.setValue(header["value"], forHTTPHeaderField: header["name"]!)
                }
                let offset = operation["offset"] as! Int
                let (_, response) = try await URLSession.shared.upload(for: request, from: data[offset..<offset + (operation["length"] as! Int)])
                guard (200..<300).contains((response as! HTTPURLResponse).statusCode) else {
                    throw Failure(description: "Uploading \(file.lastPathComponent): HTTP \((response as! HTTPURLResponse).statusCode)")
                }
            }
            let checksum = Insecure.MD5.hash(data: data).map { String(format: "%02x", $0) }.joined()
            try await call(
                "PATCH", "/v1/appScreenshots/\(id(reservation))",
                ["data": ["type": "appScreenshots", "id": id(reservation), "attributes": ["uploaded": true, "sourceFileChecksum": checksum]]])
            uploaded.append(id(reservation))
        }

        try await call(
            "PATCH", "/v1/appScreenshotSets/\(setID)/relationships/appScreenshots",
            ["data": uploaded.map { ["type": "appScreenshots", "id": $0] }])
        pending += zip(uploaded, files).map { ($0, $1.lastPathComponent) }
    }

    // App Store Connect checks each file after the commit, which a wrong size fails,
    // and can take minutes over one; a file it is still on stays uploaded.
    let deadline = Date.now.addingTimeInterval(10 * 60)
    var refused: [String] = []
    while !pending.isEmpty, Date.now < deadline {
        var processing: [(id: String, name: String)] = []
        for (screenshotID, name) in pending {
            let state =
                attributes(try await call("GET", "/v1/appScreenshots/\(screenshotID)")["data"] as! [String: Any])["assetDeliveryState"]
                as? [String: Any]
            switch state?["state"] as? String {
            case "COMPLETE": print("  \(name)")
            case "FAILED": refused.append("\(name): \(state?["errors"] ?? "no reason given")")
            default: processing.append((screenshotID, name))
            }
        }
        pending = processing
        if !pending.isEmpty {
            try await Task.sleep(for: .seconds(5))
        }
    }
    for name in pending.map(\.name) {
        print("  \(name): still processing, see App Store Connect")
    }
    if !refused.isEmpty {
        throw Failure(description: "Refused:\n" + refused.joined(separator: "\n"))
    }
}

do {
    try await main()
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
