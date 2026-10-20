import SwiftUI
import XCTest
import FerryCore
@testable import FerryKitty

/// Failure modes this file guards: a scheduled row losing its spoken "scheduled" wording when the SCHED pill
/// becomes an icon; live, late, drop-off and no-pickup states being overridden by the scheduled clock;
/// estimated layovers becoming indistinguishable from scheduled ones; and rows with long vessel, destination
/// or layover text reserving vertical space they never draw.
final class BoardStatusTests: XCTestCase {
    func testScheduledIndicatorOnlyWhenNothingMoreSpecificApplies() {
        XCTAssertEqual(BoardLayout.status(arrival: false, noPickup: false, hasLiveTiming: false, delay: 0), .scheduled)
        XCTAssertEqual(BoardLayout.status(arrival: false, noPickup: false, hasLiveTiming: true, delay: 0), .onTime)
        XCTAssertEqual(BoardLayout.status(arrival: false, noPickup: false, hasLiveTiming: true, delay: 59), .onTime)
        XCTAssertEqual(BoardLayout.status(arrival: false, noPickup: false, hasLiveTiming: true, delay: 240), .late(minutes: 4))
        XCTAssertEqual(BoardLayout.status(arrival: true, noPickup: true, hasLiveTiming: false, delay: 0), .dropOff)
        XCTAssertEqual(BoardLayout.status(arrival: true, noPickup: true, hasLiveTiming: true, delay: 600), .dropOff, "Drop off outranks live timing")
        XCTAssertEqual(BoardLayout.status(arrival: false, noPickup: true, hasLiveTiming: false, delay: 0), .noPickup)
        XCTAssertEqual(BoardLayout.status(arrival: false, noPickup: true, hasLiveTiming: true, delay: 0), .noPickup)
    }

    func testStatusWordingIsUnchanged() {
        XCTAssertEqual(DepartureStatus.scheduled.spoken, "scheduled", "The icon replaces SCHED visually, not for VoiceOver")
        XCTAssertEqual(DepartureStatus.onTime.spoken, "on time")
        XCTAssertEqual(DepartureStatus.late(minutes: 4).spoken, "+4m")
        XCTAssertEqual(DepartureStatus.dropOff.spoken, "drop off only")
        XCTAssertEqual(DepartureStatus.noPickup.spoken, "no pickup")
        XCTAssertEqual(DepartureStatus.onTime.text, "ON TIME")
        XCTAssertNil(DepartureStatus.scheduled.text, "A scheduled departure shows an icon, not text")
    }

    func testScheduledLayoverGetsAnInlineClockAndEstimatesStayDistinct() {
        let scheduled = BoardLayout.layover(minutes: 5, estimated: false)
        XCTAssertEqual(scheduled.text, "Layover 5m")
        XCTAssertTrue(scheduled.showsClock)
        XCTAssertEqual(scheduled.spoken, "layover 5 minutes scheduled")
        let estimated = BoardLayout.layover(minutes: 6, estimated: true)
        XCTAssertEqual(estimated.text, "Layover 6m est")
        XCTAssertFalse(estimated.showsClock)
        XCTAssertEqual(estimated.spoken, "layover 6 minutes estimated")
        XCTAssertEqual(BoardLayout.layover(minutes: -2, estimated: true).text, "Layover -2m est", "Overruns stay visible")
    }
}

@MainActor
final class BoardRowSizingTests: XCTestCase {
    private var folder: URL!
    private var suite: String!
    private var defaults: UserDefaults!
    override func setUp() {
        suite = "BoardRowSizingTests-" + UUID().uuidString
        defaults = UserDefaults(suiteName: suite)!
        folder = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
    }
    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: folder)
    }

    private func loadedStore(offline: Bool = false, twelveHour: Bool? = nil) async throws -> FerryStore {
        let repository = FerryRepository(transport: PreviewTransport(offline: offline, fixture: "compact"),
                                         cache: SnapshotCache(directory: folder), namespace: "fixtures")
        let store = FerryStore(repository: repository, defaults: defaults, fixedNow: ServiceClock.instant("2026-09-04T12:50:00Z"))
        if let twelveHour { store.preferences.twelveHour = twelveHour }
        await store.refreshAll()
        XCTAssertNotNil(store.schedule, "The compact schedule did not load: \(store.boardError ?? "no error reported")")
        return store
    }

    /// Pixels of the row that differ from the white backdrop. Returns nil when nothing is drawn.
    private func ink(_ view: some View, width: CGFloat, textSize: DynamicTypeSize) throws -> (top: CGFloat, bottom: CGFloat, height: CGFloat)? {
        let renderer = ImageRenderer(content: view.frame(width: width).environment(\.dynamicTypeSize, textSize)
            .environment(\.colorScheme, .light).background(Color.white))
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        let (w, h) = (image.width, image.height)
        var pixels = [UInt8](repeating: 255, count: w * h * 4)
        let context = try XCTUnwrap(CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        var first: Int?, last: Int?
        for y in 0..<h {
            let drawn = (0..<w).contains { x in
                let i = (y * w + x) * 4
                return pixels[i] < 235 || pixels[i + 1] < 235 || pixels[i + 2] < 235
            }
            if drawn { first = first ?? y; last = y }
        }
        guard let first, let last else { return nil }
        return (CGFloat(first) / 2, CGFloat(h - 1 - last) / 2, CGFloat(h) / 2)
    }

    /// A row's drawn content should sit inside its 6-point padding; a larger bottom gap is reserved but unused space.
    private func assertRowsFillTheirHeight(_ store: FerryStore, widths: [CGFloat], textSize: DynamicTypeSize = .large,
                                           file: StaticString = #filePath, line: UInt = #line) throws {
        let ids = ["cl-er-live", "cl-rs-late", "cl-sg-sched", "cl-as-sched", "cl-rs-sched", "cl-er-plain", "cl-sg-via", "cl-drop", "cl-nopickup"]
        for id in ids {
            let row = try XCTUnwrap(store.rows.first { $0.departure.tripId == id }, "Missing fixture row \(id)", file: file, line: line)
            for width in widths {
                let measured = try XCTUnwrap(ink(DepartureButton(row: row).environmentObject(store), width: width, textSize: textSize),
                                             "\(id) drew nothing", file: file, line: line)
                XCTAssertLessThanOrEqual(measured.bottom, 14, "\(id) at \(width)pt reserves \(measured.bottom)pt of blank space below its text (row height \(measured.height))", file: file, line: line)
                XCTAssertLessThanOrEqual(measured.top, 14, "\(id) at \(width)pt has \(measured.top)pt blank above its text", file: file, line: line)
            }
        }
    }

    func testCompactFixtureIsAValidSchedule() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "compact-schedule-16", withExtension: "json"), "compact-schedule-16.json is not bundled")
        let schedule = try JSONDecoder().decode(DisplayData.self, from: Data(contentsOf: url))
        XCTAssertNoThrow(try schedule.validate(landingID: 16), "The repository rejects invalid schedules, which leaves the board empty")
    }

    func testRowsDoNotReserveBlankSpaceAtNarrowPhoneWidths() async throws {
        let store = try await loadedStore()
        XCTAssertEqual(store.rows.count, 9)
        try assertRowsFillTheirHeight(store, widths: [320, 375, 390, 430])
    }

    func testRowsDoNotReserveBlankSpaceInATabletColumn() async throws {
        let store = try await loadedStore()
        try assertRowsFillTheirHeight(store, widths: [372, 465, 600])
    }

    func testRowsDoNotReserveBlankSpaceOfflineAndIn24Hour() async throws {
        _ = try await loadedStore()
        let offline = try await loadedStore(offline: true, twelveHour: false)
        XCTAssertFalse(offline.rows.contains { $0.hasLiveTiming }, "Offline rows are all scheduled")
        try assertRowsFillTheirHeight(offline, widths: [320, 390])
    }

    func testRowsDoNotReserveBlankSpaceWithLargeText() async throws {
        let store = try await loadedStore()
        try assertRowsFillTheirHeight(store, widths: [390], textSize: .xxxLarge)
        try assertRowsFillTheirHeight(store, widths: [390], textSize: .accessibility3)
    }

    func testLongDetailsStillWrapInsteadOfTruncating() async throws {
        let store = try await loadedStore()
        let short = try XCTUnwrap(store.rows.first { $0.departure.tripId == "cl-er-plain" })
        let via = try XCTUnwrap(store.rows.first { $0.departure.tripId == "cl-sg-via" })
        let shortHeight = try XCTUnwrap(ink(DepartureButton(row: short).environmentObject(store), width: 320, textSize: .large)).height
        let viaHeight = try XCTUnwrap(ink(DepartureButton(row: via).environmentObject(store), width: 320, textSize: .large)).height
        XCTAssertGreaterThan(viaHeight, shortHeight + 14, "A long destination with via stops and a layover keeps its extra wrapped lines")
    }

    func testMixedLiveAndScheduledRowsKeepTheirPrecedence() async throws {
        let store = try await loadedStore()
        func status(_ id: String) throws -> DepartureStatus {
            let row = try XCTUnwrap(store.rows.first { $0.departure.tripId == id })
            return BoardLayout.status(arrival: row.departure.arrival == true,
                                      noPickup: row.departure.outOfService == true || row.departure.crewShuttle == true,
                                      hasLiveTiming: row.hasLiveTiming, delay: row.delay)
        }
        XCTAssertEqual(try status("cl-er-live"), .onTime)
        XCTAssertEqual(try status("cl-rs-late"), .late(minutes: 4))
        XCTAssertEqual(try status("cl-sg-sched"), .scheduled)
        XCTAssertEqual(try status("cl-drop"), .dropOff)
        XCTAssertEqual(try status("cl-nopickup"), .noPickup)
    }
}
