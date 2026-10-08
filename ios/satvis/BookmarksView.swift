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
    /// The last bookmark deleted, while it can be undone.
    @State private var deleted: Bookmark?
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
        // The saved bookmark of the scene on screen, which Save opens rather than saving it twice.
        let savedHere = bookmarks.saved.first { $0.opensTheSameScene(as: here) }
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    Picker("Bookmarks", selection: $tab) {
                        Text("Demos").tag(Bookmark.Kind.demo)
                        Text(count("Saved", bookmarks.saved.count)).tag(Bookmark.Kind.saved)
                        // "Recent": the links recent visits started with.
                        Text(count("Recent", bookmarks.opened.count)).tag(Bookmark.Kind.opened)
                    }
                    .pickerStyle(.segmented)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
                        ForEach(shown) { bookmark in
                            card(bookmark, isCurrent: bookmark.opensTheSameScene(as: here))
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
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            // Under the cards with their names, as the web app's footer: the bottom
            // bar's glass shows icons alone.
            .safeAreaInset(edge: .bottom) {
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
                .padding(.horizontal)
                .padding(.bottom, 8)
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
            .overlay(alignment: .bottom) {
                if let deleted {
                    HStack {
                        Text("Deleted “\(deleted.name)”")
                            .lineLimit(1)
                        Spacer()
                        Button("Undo") {
                            bookmarks.restore(deleted)
                            self.deleted = nil
                        }
                        .fontWeight(.semibold)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .glassEffect()
                    .padding()
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.snappy, value: deleted)
        }
    }

    private func count(_ title: String, _ count: Int) -> String {
        count > 0 ? "\(title) \(count)" : title
    }

    private func card(_ bookmark: Bookmark, isCurrent: Bool) -> some View {
        Button {
            session.open(bookmark)
            dismiss()
        } label: {
            BookmarkCard(
                bookmark: bookmark, summary: session.summary(bookmark), picture: picture(bookmark), isCurrent: isCurrent)
        }
        .buttonStyle(.plain)
        // The name first: read in order, the card starts with its picture's time.
        .accessibilityLabel(card(label: bookmark))
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
        .contextMenu {
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
    }

    private func card(label bookmark: Bookmark) -> String {
        let summary = session.summary(bookmark)
        return [bookmark.name, summary.what, summary.where, summary.time ?? "Live"].joined(separator: ", ")
    }

    /// A demo's picture is on the site; the others' are kept on the device.
    private func picture(_ bookmark: Bookmark) -> BookmarkCard.Picture {
        if bookmark.kind == .demo {
            return .remote { await session.picture(of: bookmark) }
        }
        return bookmarks.pictures[bookmark.id].flatMap(UIImage.init(data:)).map(BookmarkCard.Picture.kept) ?? .none
    }

    private func startRename(_ bookmark: Bookmark) {
        draft = bookmark.name
        renaming = bookmark
    }

    /// Can be undone for five seconds.
    private func delete(_ bookmark: Bookmark) {
        bookmarks.remove(bookmark.id)
        deleted = bookmark
        Task {
            try? await Task.sleep(for: .seconds(5))
            if deleted?.id == bookmark.id {
                deleted = nil
            }
        }
    }
}

/// One bookmark (BookmarkCard.vue): its picture with the time on it, its name, its
/// satellites and where the camera is; outlined while it is the scene on screen.
struct BookmarkCard: View {
    enum Picture {
        case none
        /// Fetched when the card shows.
        case remote(@MainActor () async -> Data?)
        case kept(UIImage)
    }

    let bookmark: Bookmark
    let summary: BookmarkSummary
    let picture: Picture
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
        switch picture {
        case .kept(let image):
            Image(uiImage: image).resizable().scaledToFill()
        case .remote(let fetch):
            RemotePicture(id: bookmark.id, fetch: fetch)
        case .none:
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

/// A picture fetched when its card shows.
private struct RemotePicture: View {
    let id: String
    let fetch: @MainActor () async -> Data?
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Color.clear
            }
        }
        .task(id: id) {
            image = await fetch().flatMap(UIImage.init(data:))
        }
    }
}
