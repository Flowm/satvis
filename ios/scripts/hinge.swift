// Folds or opens an iPhone Duo simulator, which neither simctl nor XCTest can:
// sends the hinge angle DeviceHub's pose buttons send, as a vendor-defined HID
// event to the simulator's dtuhidd, from which locationd and SpringBoard take
// the fold. Private API, worked out from DeviceHub on Xcode 27.2
// (github.com/tosbaha/duo-fold-control); an Xcode update can break it.
//
//   swift scripts/hinge.swift <udid> closed|open|<degrees>
//
// The device has turned once SpringBoard has moved the scene, a second or two
// later; the angle stays until changed or the simulator is erased.
import Foundation

let service = "com.apple.coredevice.feature.remote.hid.vendordefined"

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("hinge: \(message)\n".utf8))
    exit(1)
}

let arguments = CommandLine.arguments.dropFirst()
guard arguments.count == 2, let udid = UUID(uuidString: arguments.first!) else {
    fail("usage: swift scripts/hinge.swift <udid> closed|open|<degrees>")
}
let degrees: Double
switch arguments.last! {
case "closed": degrees = 0
case "open": degrees = 180
case let angle:
    guard let value = Double(angle), (0...180).contains(value) else { fail("no angle \(angle), 0 to 180") }
    degrees = value
}

// The event's body: an IOKit binary property list (OSSerializeBinary) of four
// entries, the hinge slider's own.
var body = Data()
func put(_ word: UInt32) { withUnsafeBytes(of: word.littleEndian) { body.append(contentsOf: $0) } }
func put(_ bytes: [UInt8]) {
    body.append(contentsOf: bytes)
    body.append(contentsOf: [UInt8](repeating: 0, count: (4 - body.count % 4) % 4))
}
let end: UInt32 = 0x8000_0000
func key(_ name: String) {
    let bytes = Array(name.utf8) + [0]
    put(0x0800_0000 | UInt32(bytes.count))
    put(bytes)
}
func string(_ value: String, last: Bool = false) {
    let bytes = Array(value.utf8)
    put(0x0900_0000 | UInt32(bytes.count) | (last ? end : 0))
    put(bytes)
}
put(0xD3)
put(0x0100_0000 | end | 4)
key("type")
string("range")
key("value")
// 0x3F, not the 64 bits of an integer: DeviceHub's mark of a double.
put(0x0400_0000 | 0x3F)
put(withUnsafeBytes(of: degrees.bitPattern.littleEndian, Array.init))
key("source")
string("hinge-slider-control")
key("provider")
string("com.apple.Virtualization.VirtualMachines", last: true)

guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW) != nil,
    let libxpc = dlopen("/usr/lib/system/libxpc.dylib", RTLD_NOW)
else { fail("no CoreSimulator") }
func symbol<T>(_ name: String, as type: T.Type) -> T {
    guard let address = dlsym(libxpc, name) else { fail("no \(name) in libxpc") }
    return unsafeBitCast(address, to: type)
}
let endpointForPort = symbol("xpc_endpoint_create_mach_port_4sim", as: (@convention(c) (mach_port_t) -> xpc_endpoint_t).self)
let connectionToEndpoint = symbol("xpc_connection_create_from_endpoint", as: (@convention(c) (xpc_endpoint_t) -> xpc_connection_t).self)
let allowSimToHost = symbol("xpc_connection_enable_sim2host_4sim", as: (@convention(c) (xpc_connection_t) -> Void).self)

// CoreSimulator's SimServiceContext → SimDeviceSet → SimDevice, by name through
// the Objective-C runtime.
let developerDir = Process()
developerDir.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
developerDir.arguments = ["-p"]
let pipe = Pipe()
developerDir.standardOutput = pipe
try developerDir.run()
developerDir.waitUntilExit()
let developerPath = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    .trimmingCharacters(in: .whitespacesAndNewlines)

typealias ContextFunction = @convention(c) (AnyClass, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> NSObject?
typealias SetFunction = @convention(c) (NSObject, Selector, UnsafeMutablePointer<NSError?>?) -> NSObject?
typealias LookupFunction = @convention(c) (NSObject, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> mach_port_t
func method<T>(_ target: AnyObject, _ name: String, as type: T.Type) -> (Selector, T) {
    let selector = NSSelectorFromString(name)
    guard let object = target as? NSObject, object.responds(to: selector) else { fail("CoreSimulator has no \(name)") }
    return (selector, unsafeBitCast(object.method(for: selector), to: type))
}
var error: NSError?
guard let contextClass = NSClassFromString("SimServiceContext") else { fail("no SimServiceContext") }
let (contextSelector, sharedContext) = method(contextClass, "sharedServiceContextForDeveloperDir:error:", as: ContextFunction.self)
guard let context = sharedContext(contextClass, contextSelector, developerPath as NSString, &error) else {
    fail("no service context: \(error?.localizedDescription ?? "")")
}
let (setSelector, defaultSet) = method(context, "defaultDeviceSetWithError:", as: SetFunction.self)
guard let set = defaultSet(context, setSelector, &error), let devices = set.value(forKey: "devices") as? [NSObject] else {
    fail("no device set: \(error?.localizedDescription ?? "")")
}
guard let device = devices.first(where: { ($0.value(forKey: "UDID") as? UUID) == udid }) else { fail("no simulator \(udid)") }
// SimDeviceState.booted
guard (device.value(forKey: "state") as? UInt) == 3 else { fail("\(udid) is not booted") }
let (lookupSelector, lookup) = method(device, "lookup:error:", as: LookupFunction.self)
let port = lookup(device, lookupSelector, service as NSString, &error)
guard port != MACH_PORT_NULL else { fail("\(udid) has no hinge: \(error?.localizedDescription ?? "")") }

let connection = connectionToEndpoint(endpointForPort(port))
allowSimToHost(connection)
xpc_connection_set_event_handler(connection) { _ in }
xpc_connection_resume(connection)

let payload = xpc_dictionary_create(nil, nil, 0)
// The vendor page 0xFF61, usage 91: the hinge.
xpc_dictionary_set_uint64(payload, "usagePage", 0xFF61)
xpc_dictionary_set_uint64(payload, "usage", 91)
xpc_dictionary_set_uint64(payload, "version", 0)
body.withUnsafeBytes { xpc_dictionary_set_data(payload, "data", $0.baseAddress!, body.count) }
let message = xpc_dictionary_create(nil, nil, 0)
xpc_dictionary_set_string(message, "messageType", "IndigoVendorDefinedEvent")
xpc_dictionary_set_string(message, "featureIdentifier", service)
xpc_dictionary_set_value(message, "payload", payload)
xpc_connection_send_message(connection, message)

// dtuhidd answers a barrier once it has passed on everything before it.
let barrier = xpc_dictionary_create(nil, nil, 0)
xpc_dictionary_set_bool(barrier, "isBarrier", true)
let reply = xpc_connection_send_message_with_reply_sync(connection, barrier)
if xpc_get_type(reply) == XPC_TYPE_ERROR {
    fail(xpc_dictionary_get_string(reply, XPC_ERROR_KEY_DESCRIPTION).map { String(cString: $0) } ?? "the event was not delivered")
}
// dtuhidd drops the service the event came on once this connection closes, and
// locationd has to have read it by then.
Thread.sleep(forTimeInterval: 1)
