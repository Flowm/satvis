import SatvisCore
import SwiftUI

/// The web app's Bookmarks panel (BookmarkPanel.vue): the demos, the saved
/// bookmarks and the opened links as cards, the way back to the default view, and
/// saving the scene. A sheet, as the other long lists are.
struct BookmarksView: View {
    let session: Session
    /// Opens on Saved for a user who has saved something.
    @State private var tab: Bookmark.Kind
    /// The bookmark whose name is being edited, and the name as typed so far.
    @State private var renaming: Bookmark?
    @State private var draft = ""
    /// A picture is being taken, which a second tap must not repeat.
    @State private var saving = false
    /// The bookmarks deleted in the last five seconds, newest last, each with its
    /// own undo.
    @State private var deleted: [Bookmark] = []
    /// Where the share button and each card are in the window, for a share sheet's
    /// popover to point at on iPad.
    @State private var frames: [String: CGRect] = [:]
    /// The share button's key among `frames`, beside the cards' ids.
    private static let shareButton = "share"
    @Environment(\.dismiss) private var dismiss

    init(session: Session) {
        self.session = session
        _tab = State(initialValue: session.bookmarks.saved.isEmpty ? .demo : .saved)
    }

    private var bookmarks: BookmarkModel { session.bookmarks }

    private var shown: [Bookmark] {
        switch tab {
        case .demo: Bookmarks.demos
        case .saved: bookmarks.saved
        case .opened: bookmarks.opened
        }
    }

    var body: some View {
        let here = session.here
        // Save opens this rather than saving the scene twice.
        let savedHere = bookmarks.saved.first { $0.scene == here }
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    Picker("Bookmarks", selection: $tab) {
                        Text("Demos").tag(Bookmark.Kind.demo)
                        Text(count("Saved", bookmarks.saved.count)).tag(Bookmark.Kind.saved)
                        Text(count("Recent", bookmarks.opened.count)).tag(Bookmark.Kind.opened)
                    }
                    .pickerStyle(.segmented)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
                        ForEach(shown) { bookmark in
                            card(bookmark, isCurrent: bookmark.scene == here)
                        }
                    }
                    if shown.isEmpty {
                        Text(tab == .saved ? "Save this view to come back to it." : "Links you open show up here.")
                            .foregroundStyle(.secondary)
                            .padding(.top, 24)
                    }
                }
                .padding()
            }
            .navigationTitle("Bookmarks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // The view on screen, where the corner's Share button was; made when
                // tapped, so that a clock off the present gives its minute then.
                ToolbarItem(placement: .cancellationAction) {
                    Button("Share this view", systemImage: "square.and.arrow.up") {
                        ShareSheet.present(session.link(sharing: true).url(site: session.source.site), from: frames[Self.shareButton] ?? .zero)
                    }
                    .reportsFrame { frames[Self.shareButton] = $0 }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            // Under the cards with their names, as the web app's footer: the bottom
            // bar's glass shows icons alone.
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    ForEach(deleted) { bookmark in
                        undo(bookmark)
                    }
                    HStack {
                        Button("Default view", systemImage: "arrow.counterclockwise") {
                            session.openDefaultView()
                            dismiss()
                        }
                        .disabled(here.query.isEmpty)
                        Spacer()
                        if let savedHere {
                            Button("Saved", systemImage: "bookmark.fill") {
                                tab = .saved
                                startRename(savedHere)
                            }
                        } else {
                            Button("Save this view", systemImage: "bookmark") {
                                Task {
                                    saving = true
                                    defer { saving = false }
                                    let bookmark = await session.saveHere()
                                    tab = .saved
                                    startRename(bookmark)
                                }
                            }
                            .disabled(here.query.isEmpty || saving)
                        }
                    }
                    .buttonStyle(.glass)
                    .controlSize(.large)
                }
                .padding(.horizontal)
                .padding(.bottom, 8)
                .animation(.snappy, value: deleted)
            }
            .alert(
                "Name",
                isPresented: Binding {
                    renaming != nil
                } set: {
                    if !$0 { renaming = nil }
                }
            ) {
                TextField("Name", text: $draft)
                Button("Save") {
                    if let renaming {
                        bookmarks.rename(renaming.id, to: draft)
                    }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
        // Closed, the sheet's undos go with it.
        .onDisappear {
            for bookmark in deleted {
                bookmarks.release(bookmark.id)
            }
        }
    }

    private func count(_ title: String, _ count: Int) -> String {
        count > 0 ? "\(title) (\(count))" : title
    }

    private func card(_ bookmark: Bookmark, isCurrent: Bool) -> some View {
        let summary = session.summary(bookmark.scene)
        return Button {
            session.open(bookmark.scene)
            dismiss()
        } label: {
            BookmarkCard(bookmark: bookmark, summary: summary, picture: picture(bookmark), isCurrent: isCurrent)
        }
        .buttonStyle(.plain)
        .reportsFrame { frames[bookmark.id] = $0 }
        // The name first: read in order, the card starts with its picture's time.
        .accessibilityLabel([bookmark.name, summary.what, summary.where, summary.time ?? "Live"].joined(separator: ", "))
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
        .contextMenu { actions(bookmark) }
        // The long press's actions in sight.
        .overlay(alignment: .topTrailing) {
            Menu {
                actions(bookmark)
            } label: {
                Image(systemName: "ellipsis")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(.black.opacity(0.73), in: .circle)
                    .padding(4)
                    .contentShape(.rect)
            }
            .accessibilityLabel("Actions for \(bookmark.name)")
        }
    }

    @ViewBuilder private func actions(_ bookmark: Bookmark) -> some View {
        // Its own link, as it opens: live unless it was saved with a time.
        Button("Share", systemImage: "square.and.arrow.up") {
            ShareSheet.present(bookmark.scene.link().url(site: session.source.site), from: frames[bookmark.id] ?? .zero)
        }
        switch bookmark.kind {
        case .saved:
            Button("Rename", systemImage: "pencil") { startRename(bookmark) }
            Button("Delete", systemImage: "trash", role: .destructive) { delete(bookmark) }
        case .opened:
            Button("Save", systemImage: "bookmark") {
                if let kept = bookmarks.keep(bookmark.id, name: bookmark.name) {
                    tab = .saved
                    startRename(kept)
                }
            }
            Button("Forget", systemImage: "xmark") { bookmarks.forget(bookmark.id) }
        case .demo:
            EmptyView()
        }
    }

    /// A demo's picture is the site's, kept once fetched; the others' are the device's.
    private func picture(_ bookmark: Bookmark) -> UIImage? {
        let data = bookmark.kind == .demo ? bookmark.thumbnail.flatMap { session.demoPictures[$0] } : bookmarks.pictures[bookmark.id]
        return data.flatMap(UIImage.init(data:))
    }

    private func startRename(_ bookmark: Bookmark) {
        draft = bookmark.name
        renaming = bookmark
    }

    private func undo(_ bookmark: Bookmark) -> some View {
        HStack {
            Text("Deleted “\(bookmark.name)”")
                .lineLimit(1)
            Spacer()
            Button("Undo") {
                bookmarks.restore(bookmark)
                deleted.removeAll { $0.id == bookmark.id }
            }
            .fontWeight(.semibold)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .glassEffect()
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    /// Can be undone for five seconds.
    private func delete(_ bookmark: Bookmark) {
        bookmarks.remove(bookmark.id)
        deleted.append(bookmark)
        Task {
            try? await Task.sleep(for: .seconds(5))
            if deleted.contains(where: { $0.id == bookmark.id }) {
                deleted.removeAll { $0.id == bookmark.id }
                bookmarks.release(bookmark.id)
            }
        }
    }
}

/// One bookmark (BookmarkCard.vue): its picture with the time on it, its name, its
/// satellites and where the camera is; outlined while it is the scene on screen.
struct BookmarkCard: View {
    let bookmark: Bookmark
    let summary: BookmarkSummary
    let picture: UIImage?
    let isCurrent: Bool

    private static let accent = Color(red: 127 / 255, green: 210 / 255, blue: 234 / 255)
    private static let live = Color(red: 0x8F / 255, green: 0xE3 / 255, blue: 0x9B / 255)

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Color(red: 0x0B / 255, green: 0x0F / 255, blue: 0x14 / 255)
                .aspectRatio(16 / 10, contentMode: .fit)
                .overlay { image }
                .clipped()
                .overlay(alignment: .bottomLeading) {
                    badge(summary.time ?? "● Live", color: summary.time == nil ? Self.live : .white)
                }
                .overlay(alignment: .topLeading) {
                    if bookmark.kind == .opened {
                        TimelineView(.periodic(from: .now, by: 60)) { context in
                            badge(Bookmarks.timeAgo(bookmark.at, now: context.date.timeIntervalSince1970 * 1000), color: .white)
                        }
                    }
                }
            Text(bookmark.name)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
                .padding(.horizontal, 8)
            Group {
                Label {
                    Text(summary.what)
                } icon: {
                    Image(.lucideOrbit).resizable().frame(width: 12, height: 12)
                }
                Label {
                    Text(summary.where)
                } icon: {
                    Image(whereIcon).resizable().frame(width: 12, height: 12)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal, 8)
        }
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(red: 0x1F / 255, green: 0x22 / 255, blue: 0x25 / 255), in: .rect(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8).strokeBorder(Self.accent, lineWidth: isCurrent ? 2 : 0)
        }
        .contentShape(.rect(cornerRadius: 8))
    }

    @ViewBuilder private var image: some View {
        if let picture {
            Image(uiImage: picture).resizable().scaledToFill()
        } else {
            Image(systemName: "photo").foregroundStyle(.tertiary)
        }
    }

    /// The icon of the Sky, Globe or tracking camera.
    private var whereIcon: ImageResource {
        summary.where.hasPrefix("Sky") ? .lucideTelescope : summary.where.hasPrefix("Following") ? .lucideCrosshair : .lucideGlobe
    }

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.black.opacity(0.73), in: .rect(cornerRadius: 6))
            .padding(5)
    }
}

/// The system's share sheet with the link itself, not an item provider's promise of
/// it, over the Bookmarks sheet; on iPad a popover pointing at `rect`, in the
/// sheet's coordinates: SwiftUI's global space inside a sheet starts at the
/// sheet's corner, not the window's, where the popover pointed at first.
private enum ShareSheet {
    /// Over whatever is presented, the Bookmarks sheet itself.
    static func present(_ url: URL, from rect: CGRect) {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
        guard var top = scene?.keyWindow?.rootViewController else {
            return
        }
        while let presented = top.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = top.view
            popover.sourceRect = rect
        }
        top.present(sheet, animated: true)
    }
}

extension View {
    /// Where the view is, for a share sheet's popover to point at.
    fileprivate func reportsFrame(_ action: @escaping (CGRect) -> Void) -> some View {
        onGeometryChange(for: CGRect.self) {
            $0.frame(in: .global)
        } action: {
            action($0)
        }
    }
}
