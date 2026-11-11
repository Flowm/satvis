import MetalKit
import SatvisCore
import SatvisRender
import SwiftUI
import os

private let log = Logger(subsystem: "org.frcy.app.satvis", category: "globe")

/// The Metal globe, steered by drag, pinch and twist; what a tap, a double tap or
/// a finger held still means is the caller's. The gestures are SwiftUI's, so that
/// the controls laid over the globe, the clock deck's timeline among them, take
/// the touches that land on them first. On a Mac the view takes the mouse, the
/// trackpad and the keys itself (`GlobePointer`), as AppKit hands them to it.
struct GlobeView: View {
    /// Called once the renderer exists, so the satellites can be handed to it.
    let onRenderer: (GlobeRenderer) -> Void
    /// Called as each tap lifts, a double tap's first included.
    var onEveryTap: () -> Void = {}
    /// Where on the view, and the view's size; called once no double tap can follow.
    let onTap: (CGPoint, CGSize) -> Void
    let onDoubleTap: (CGPoint, CGSize) -> Void
    /// Where one finger was held still, and the view's size; true if that opened
    /// something, and the finger then lifts as no tap and drags nothing.
    var onHold: (CGPoint, CGSize) -> Bool = { _, _ in false }
    /// Asked with a drag's translation so far, and the most fingers down during
    /// it, whether it may move the view.
    var mayDrag: (CGSize, Int) -> Bool = { _, _ in true }
    /// Offered a pinch's step before the view; true where it took it, and the
    /// view is left as it is.
    var takePinch: (Double) -> Bool = { _ in false }
    /// Clear where the scene leaves the sky, over the camera's picture.
    var isTransparent = false
    /// The web app's `pixelratio`: a number, or `native` for the screen's own.
    var pixelRatio = "native"
    /// Frames a second at most, the Graphics panel's.
    let frameRate: Int
    /// The Escape key, pressed while the globe has the keyboard: on a Mac.
    var onEscape: () -> Void = {}
    /// The space bar, pressed while the globe has the keyboard: on a Mac.
    var onSpace: () -> Void = {}

    @State private var renderer: GlobeRenderer?
    @State private var lastTranslation = CGSize.zero
    @State private var lastMagnification = 1.0
    @State private var lastRotation = Angle.zero
    /// The most fingers down at once since the first of them touched, counted by
    /// the touches themselves rather than by when a pinch is recognised, which
    /// comes after its fingers have drifted. Back to 0 once the last lifts, or the
    /// system takes the touches.
    @GestureState private var mostFingers = 0
    /// Where the touch now down began; nil between touches. Not keyed by the
    /// events' ids, which SwiftUI gives every touch alike.
    @GestureState private var touchedAt: CGPoint?
    /// Whether the touch now down, or else the last one, opened something on hold.
    /// Kept past the lift for the tap reported once no double tap can follow.
    @State private var wasHeld = false

    /// iOS's long press, as on the web (`TOUCH_HOLD_MS`).
    private static let holdDuration = 0.5

    var body: some View {
        GeometryReader { proxy in
            #if os(macOS)
                MetalView(pixelRatio: pixelRatio, frameRate: frameRate, isTransparent: isTransparent, pointer: pointer, onRenderer: attach)
            #else
                let size = proxy.size
                MetalView(pixelRatio: pixelRatio, frameRate: frameRate, isTransparent: isTransparent, onRenderer: attach)
                    .gesture(
                        SpatialTapGesture(count: 2)
                            .onEnded { onDoubleTap($0.location, size) }
                            .exclusively(
                                before: SpatialTapGesture().onEnded {
                                    if !wasHeld {
                                        onTap($0.location, size)
                                    }
                                })
                    )
                    .simultaneousGesture(
                        SpatialTapGesture().onEnded { _ in
                            if !wasHeld {
                                onEveryTap()
                            }
                        }
                    )
                    .simultaneousGesture(
                        DragGesture(minimumDistance: 1)
                            .onChanged { value in
                                let delta = SIMD2(Double(value.translation.width - lastTranslation.width), Double(value.translation.height - lastTranslation.height))
                                lastTranslation = value.translation
                                if !wasHeld, mayDrag(value.translation, mostFingers) {
                                    renderer?.drag(by: delta, viewSize: size)
                                }
                            }
                            .onEnded { _ in lastTranslation = .zero }
                    )
                    .simultaneousGesture(
                        SpatialEventGesture()
                            .updating($mostFingers) { events, most, _ in
                                most = max(most, events.filter { $0.phase == .active }.count)
                            }
                            .updating($touchedAt) { events, at, _ in
                                at = at ?? events.first { $0.phase == .active }?.location
                            }
                    )
                    .simultaneousGesture(
                        // Within LongPressGesture's 10 pt of where it began, so a drag never opens it.
                        LongPressGesture(minimumDuration: Self.holdDuration)
                            .onEnded { _ in
                                guard mostFingers <= 1, let touchedAt else {
                                    return
                                }
                                wasHeld = onHold(touchedAt, size)
                            }
                    )
                    .onChange(of: touchedAt == nil) { _, lifted in
                        if !lifted {
                            wasHeld = false
                        }
                    }
                    .simultaneousGesture(
                        MagnifyGesture()
                            .onChanged { value in
                                let scale = value.magnification / lastMagnification
                                lastMagnification = value.magnification
                                if !takePinch(scale) {
                                    renderer?.zoom(by: scale)
                                }
                            }
                            .onEnded { _ in lastMagnification = 1 }
                    )
                    .simultaneousGesture(
                        RotateGesture()
                            .onChanged { value in
                                let radians = (value.rotation - lastRotation).radians
                                lastRotation = value.rotation
                                renderer?.rotate(by: radians)
                            }
                            .onEnded { _ in lastRotation = .zero }
                    )
            #endif
        }
    }

    private func attach(_ renderer: GlobeRenderer) {
        self.renderer = renderer
        onRenderer(renderer)
    }

    #if os(macOS)
        /// The mouse, the trackpad and the keys on the globe, as the touches are on
        /// an iPhone: a right click is the held finger, a scroll the pinch.
        private var pointer: GlobePointer {
            GlobePointer(
                click: onTap,
                everyClick: onEveryTap,
                doubleClick: onDoubleTap,
                secondaryClick: { _ = onHold($0, $1) },
                drag: { delta, translation, size in
                    if mayDrag(translation, 1) {
                        renderer?.drag(by: delta, viewSize: size)
                    }
                },
                zoom: { scale in
                    if !takePinch(scale) {
                        renderer?.zoom(by: scale)
                    }
                },
                rotate: { renderer?.rotate(by: $0) },
                escape: onEscape,
                space: onSpace
            )
        }
    #endif
}

#if os(macOS)
    /// What the mouse, the trackpad and the keys do on the globe; each point is in
    /// the view's points from its top-left corner, with the view's size.
    struct GlobePointer {
        /// A click, once no double click can follow.
        let click: (CGPoint, CGSize) -> Void
        /// As each click lifts, a double click's first included.
        let everyClick: () -> Void
        /// The second click of two, the iPhone's double tap.
        let doubleClick: (CGPoint, CGSize) -> Void
        /// A right click, a click with Control held or a force click: the iPhone's
        /// finger held still.
        let secondaryClick: (CGPoint, CGSize) -> Void
        /// A step of a drag, then its translation so far, and the view's size.
        let drag: (_ step: SIMD2<Double>, _ translation: CGSize, _ size: CGSize) -> Void
        /// Nearer for a scale above 1.
        let zoom: (Double) -> Void
        /// Clockwise, in radians.
        let rotate: (Double) -> Void
        /// The Escape key.
        let escape: () -> Void
        /// The space bar.
        let space: () -> Void
    }
#endif

/// The MTKView the renderer draws into, and nothing else.
private struct MetalView {
    let pixelRatio: String
    let frameRate: Int
    /// Clear where the scene leaves the sky, over the camera's picture.
    let isTransparent: Bool
    #if os(macOS)
        let pointer: GlobePointer
    #endif
    let onRenderer: (GlobeRenderer) -> Void

    func makeView() -> ScaledMTKView {
        let view = ScaledMTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        view.pixelRatio = pixelRatio
        // Over 60 on an iPhone only with CADisableMinimumFrameDurationOnPhone in Info.plist.
        view.preferredFramesPerSecond = frameRate
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        Task {
            do {
                // The web app's level 2, copied in by the app target's "Copy Natural
                // Earth" phase from data/imagery rather than kept a second time.
                onRenderer(try await GlobeRenderer.make(view: view, naturalEarth: Bundle.main.url(forResource: "NaturalEarthII", withExtension: nil)))
            } catch {
                log.error("No globe: \(error, privacy: .public)")
            }
        }
        return view
    }

    func update(_ view: ScaledMTKView) {
        view.pixelRatio = pixelRatio
        #if os(macOS)
            view.pointer = pointer
        #endif
        // Opaque otherwise, which spares the compositor blending the globe.
        (view.layer as? CAMetalLayer)?.isOpaque = !isTransparent
        if view.preferredFramesPerSecond != frameRate {
            view.preferredFramesPerSecond = frameRate
        }
    }
}

#if os(macOS)
    extension MetalView: NSViewRepresentable {
        func makeNSView(context: Context) -> ScaledMTKView { makeView() }
        func updateNSView(_ view: ScaledMTKView, context: Context) { update(view) }
    }
#else
    extension MetalView: UIViewRepresentable {
        func makeUIView(context: Context) -> ScaledMTKView { makeView() }
        func updateUIView(_ view: ScaledMTKView, context: Context) { update(view) }
    }
#endif

/// Drawn at the pixel ratio asked for: fewer pixels a point than the screen's,
/// which the system scales up to it, for frames the GPU can finish in time.
/// UIKit sets a view's scale to the screen's when it joins a window, so the
/// ratio is set again then; AppKit sizes the drawable by the window's scale, which
/// changes as the window moves to another display, so it is sized here instead.
private final class ScaledMTKView: MTKView {
    /// The web app's `pixelratio`, read against the screen's scale (`PixelRatioLadder`).
    var pixelRatio = "native" {
        didSet {
            if pixelRatio != oldValue {
                applyPixelRatio()
            }
        }
    }

    #if os(macOS)
        /// What the mouse, the trackpad and the keys do on the globe, set on every
        /// update of the view.
        var pointer: GlobePointer?
        /// Where the mouse went down, and where the drag last was; nil between clicks.
        private var downAt: CGPoint?
        private var lastAt = CGPoint.zero
        private var dragged = false
        /// The click now down was pressed through to a force click, and lifts as
        /// no click.
        private var forced = false
        /// The click waiting out the double-click interval.
        private var pendingClick: Task<Void, Never>?
        private var windowObservers: [NSObjectProtocol] = []
        /// The window's first responder, watched for a field letting go of the keyboard.
        private var responderObservation: NSKeyValueObservation?

        /// Points a click may wander and stay a click.
        private static let clickSlop = 3.0
        /// Points an arrow key moves the globe, as a drag would.
        private static let keyStep = 40.0
        /// How much nearer + brings it, and - takes it back.
        private static let keyZoom = 1.25

        override var acceptsFirstResponder: Bool { true }

        /// A click on the globe of a window in the back acts at once, as the web
        /// app's canvas does.
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            applyPixelRatio()
            watchWindow()
            if window == nil {
                pendingClick?.cancel()
            }
            GlobeRenderer.window = window
            takeKeys()
        }

        /// Takes the keyboard where nothing else in the window has it, so the keys
        /// work on the globe from the start, as on the web, without a click first.
        private func takeKeys() {
            guard let window, window.firstResponder == nil || window.firstResponder === window else {
                return
            }
            window.makeFirstResponder(self)
        }

        /// Follows the window as it is covered and as it comes to the front, and
        /// lets go of the one it left.
        private func watchWindow() {
            for observer in windowObservers {
                NotificationCenter.default.removeObserver(observer)
            }
            windowObservers = []
            responderObservation = nil
            guard let window else {
                return
            }
            let center = NotificationCenter.default
            windowObservers = [
                center.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.pauseWhileHidden() }
                },
                // The panel that had the keyboard closed while another window was in front.
                center.addObserver(forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.takeKeys() }
                },
            ]
            // A panel's field that closes leaves the keyboard with the window.
            responderObservation = window.observe(\.firstResponder) { @Sendable [weak self] _, _ in
                Task { @MainActor in self?.takeKeys() }
            }
            pauseWhileHidden()
        }

        /// Draws nothing while the window is hidden, minimised or covered: AppKit
        /// keeps the view's display link running behind other windows, and the
        /// moving satellites would keep the GPU busy for no one.
        private func pauseWhileHidden() {
            isPaused = !(window?.occlusionState.contains(.visible) ?? false)
        }

        /// In the view's points from its top-left corner, as SwiftUI places them.
        private func point(of event: NSEvent) -> CGPoint {
            let point = convert(event.locationInWindow, from: nil)
            return CGPoint(x: point.x, y: isFlipped ? point.y : bounds.height - point.y)
        }

        override func mouseDown(with event: NSEvent) {
            // The hidden title bar's strip, which the globe is drawn under and is
            // handed the clicks of: it moves the window, as the title bar would.
            if let window, event.locationInWindow.y > window.contentLayoutRect.maxY {
                return event.clickCount == 2 ? Self.titleBarDoubleClick(window) : window.performDrag(with: event)
            }
            if event.modifierFlags.contains(.control) {
                return rightMouseDown(with: event)
            }
            window?.makeFirstResponder(self)
            let at = point(of: event)
            downAt = at
            lastAt = at
            dragged = false
            forced = false
            if event.clickCount > 1 {
                pendingClick?.cancel()
            }
        }

        /// What a double click on a title bar does, as the user set it in the
        /// Desktop & Dock settings: fill the screen, minimise, or nothing.
        private static func titleBarDoubleClick(_ window: NSWindow) {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window.miniaturize(nil)
            case "None": break
            default: window.zoom(nil)
            }
        }

        override func mouseDragged(with event: NSEvent) {
            guard let downAt, let pointer else {
                return
            }
            let at = point(of: event)
            let translation = CGSize(width: at.x - downAt.x, height: at.y - downAt.y)
            guard !forced, dragged || hypot(translation.width, translation.height) > Self.clickSlop else {
                return
            }
            dragged = true
            pointer.drag(SIMD2(at.x - lastAt.x, at.y - lastAt.y), translation, bounds.size)
            lastAt = at
        }

        override func mouseUp(with event: NSEvent) {
            defer { downAt = nil }
            guard downAt != nil, !dragged, !forced, let pointer else {
                return
            }
            let at = point(of: event)
            let size = bounds.size
            pointer.everyClick()
            // A third click starts over, as a third tap does on an iPhone.
            if event.clickCount.isMultiple(of: 2) {
                pointer.doubleClick(at, size)
            } else {
                pendingClick?.cancel()
                pendingClick = Task {
                    try? await Task.sleep(for: .seconds(NSEvent.doubleClickInterval))
                    if !Task.isCancelled {
                        pointer.click(at, size)
                    }
                }
            }
        }

        override func rightMouseDown(with event: NSEvent) {
            window?.makeFirstResponder(self)
            pendingClick?.cancel()
            pointer?.secondaryClick(point(of: event), bounds.size)
        }

        /// A trackpad pressed through to its second stage, where the iPhone's finger
        /// is held still: the click goes no further.
        override func pressureChange(with event: NSEvent) {
            guard event.stage == 2, !forced, !dragged, let downAt else {
                return
            }
            forced = true
            pendingClick?.cancel()
            pointer?.secondaryClick(downAt, bounds.size)
        }

        override func scrollWheel(with event: NSEvent) {
            pointer?.zoom(ScrollZoom.scale(deltaY: Double(event.scrollingDeltaY), precise: event.hasPreciseScrollingDeltas))
        }

        override func magnify(with event: NSEvent) {
            pointer?.zoom(exp(Double(event.magnification)))
        }

        /// AppKit turns counter-clockwise for a positive rotation, SwiftUI clockwise.
        override func rotate(with event: NSEvent) {
            pointer?.rotate(-Double(event.rotation) * .pi / 180)
        }

        /// The arrows move the globe as a drag by `keyStep` would, + and - zoom, and
        /// Escape and the space bar are the caller's.
        override func keyDown(with event: NSEvent) {
            guard let pointer else {
                return super.keyDown(with: event)
            }
            let step = Self.keyStep
            let move: SIMD2<Double>? =
                switch event.specialKey {
                case .leftArrow: SIMD2(step, 0)
                case .rightArrow: SIMD2(-step, 0)
                case .upArrow: SIMD2(0, step)
                case .downArrow: SIMD2(0, -step)
                default: nil
                }
            if let move {
                return pointer.drag(move, CGSize(width: move.x, height: move.y), bounds.size)
            }
            switch event.charactersIgnoringModifiers {
            case "\u{1B}": pointer.escape()
            case " ": pointer.space()
            case "+", "=": pointer.zoom(Self.keyZoom)
            case "-": pointer.zoom(1 / Self.keyZoom)
            default: super.keyDown(with: event)
            }
        }

        override func viewDidChangeBackingProperties() {
            super.viewDidChangeBackingProperties()
            applyPixelRatio()
        }

        override func setFrameSize(_ size: NSSize) {
            super.setFrameSize(size)
            applyPixelRatio()
        }

        private func applyPixelRatio() {
            guard let window else {
                return
            }
            let scale = PixelRatioLadder.value(pixelRatio, screen: window.backingScaleFactor)
            autoResizeDrawable = false
            layer?.contentsScale = scale
            let size = CGSize(width: (bounds.width * scale).rounded(), height: (bounds.height * scale).rounded())
            if size.width > 0, size.height > 0, size != drawableSize {
                drawableSize = size
            }
        }
    #else
        override func didMoveToWindow() {
            super.didMoveToWindow()
            applyPixelRatio()
        }

        private func applyPixelRatio() {
            guard window != nil else {
                return
            }
            contentScaleFactor = PixelRatioLadder.value(pixelRatio, screen: traitCollection.displayScale)
        }
    #endif
}
