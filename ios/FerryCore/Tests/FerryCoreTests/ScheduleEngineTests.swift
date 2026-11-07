import XCTest
@testable import FerryCore

private struct Fixture: Decodable {
    struct Expected: Decodable, Equatable {
        var tripId: String
        var serviceDate: String
        var delay: Double
        var hasLiveTiming: Bool
        var boatName: String?
        var predictedBoatName: String?
        var isLastOfDay: Bool
        init(_ row: ScheduledDeparture) {
            tripId = row.departure.tripId; serviceDate = row.serviceDate; delay = row.delay
            hasLiveTiming = row.hasLiveTiming; boatName = row.boatName
            predictedBoatName = row.predictedBoatName; isLastOfDay = row.isLastOfDay
        }
    }
    struct Scenario: Decodable {
        var id: String; var now: String; var viewDate: String?; var realtime: Realtime; var expected: [Expected]
    }
    struct ClockCase: Decodable { var now: String; var dateKey: String; var seconds: Double }
    var schedule: DisplayData
    var cases: [Scenario]
    var timezones: [ClockCase]
}

final class ScheduleEngineTests: XCTestCase {
    // Read the canonical web/native fixture directly, rather than maintaining a drifting copy.
    private func fixture() throws -> Fixture {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: root.appendingPathComponent("test/fixtures/schedule-contract.json")))
    }

    func testAllSharedScheduleCases() throws {
        let fixture = try fixture()
        for scenario in fixture.cases {
            let result = ScheduleEngine.timeline(data: fixture.schedule, realtime: scenario.realtime,
                viewDate: scenario.viewDate, now: try XCTUnwrap(ServiceClock.instant(scenario.now)))
            XCTAssertEqual(result.map(Fixture.Expected.init), scenario.expected, scenario.id)
        }
    }

    func testBothDaylightSavingTransitions() throws {
        for scenario in try fixture().timezones {
            let result = ServiceClock.parts(try XCTUnwrap(ServiceClock.instant(scenario.now)))
            XCTAssertEqual(result.dateKey, scenario.dateKey)
            XCTAssertEqual(result.seconds, scenario.seconds)
        }
    }

    func testHolidayOnlyDepartureNeverInheritsLiveData() throws {
        var f = try fixture()
        f.schedule.departures[0].scheduleOnly = true
        let realtime = try JSONDecoder().decode(Realtime.self, from: Data(#"{"available":true,"stale":false,"updates":[{"tripId":"nine","stopId":"1","delaySeconds":600,"canceled":true}],"vehicles":[{"tripId":"nine","boat":"ER1","boatName":"Wrong boat"}]}"#.utf8))
        let row = try XCTUnwrap(ScheduleEngine.timeline(data: f.schedule, realtime: realtime,
            now: ServiceClock.instant(f.cases[0].now)!).first { $0.departure.tripId == "nine" })
        XCTAssertEqual(row.delay, 0)
        XCTAssertFalse(row.hasLiveTiming)
        XCTAssertNil(row.boatName)
        XCTAssertNil(row.predictedBoatName)
    }

    func testFerryRTSlipRidesOnTheDepartureOnlyWhileFresh() throws {
        let f = try fixture()
        var realtime = try JSONDecoder().decode(Realtime.self, from: Data(#"{"stale":false,"updates":[{"tripId":"nine","stopId":"1","delaySeconds":0,"slip":{"id":"NYCF_1_SLIP_2","name":"Slip 2"}}]}"#.utf8))
        let now = ServiceClock.instant(f.cases[0].now)!
        let row = { try XCTUnwrap(ScheduleEngine.timeline(data: f.schedule, realtime: realtime, now: now).first { $0.departure.tripId == "nine" }) }
        XCTAssertEqual(try row().slipName, "Slip 2")
        realtime.stale = true
        XCTAssertNil(try row().slipName)
    }

    func testVerifiedHolidayLiveAliasSuppliesTimingVesselAndCancellation() throws {
        var data = try fixture().schedule
        data.departures[0].scheduleOnly = true
        data.departures[0].liveTripId = "live-nine"
        var realtime = try JSONDecoder().decode(Realtime.self, from: Data(#"{"stale":false,"updates":[{"tripId":"nine","stopId":"1","delaySeconds":999,"canceled":true},{"tripId":"live-nine","stopId":"1","delaySeconds":180}],"vehicles":[{"tripId":"live-nine","boat":"ER1","boatName":"Verified vessel"}]}"#.utf8))
        let now = ServiceClock.instant("2026-09-04T12:50:00Z")!
        let row = try XCTUnwrap(ScheduleEngine.timeline(data: data, realtime: realtime, now: now).first { $0.departure.tripId == "nine" })
        XCTAssertEqual(row.delay, 180)
        XCTAssertTrue(row.hasLiveTiming)
        XCTAssertEqual(row.boatName, "Verified vessel")
        XCTAssertNil(row.predictedBoatName)
        realtime.updates?[1].canceled = true
        XCTAssertFalse(ScheduleEngine.timeline(data: data, realtime: realtime, now: now).contains { $0.departure.tripId == "nine" })
    }

    func testDatedLiveIdentitySuppliesTimingAndVessel() throws {
        var data = try fixture().schedule
        data.departures[0].liveTripId = "nyc:unmapped:nine"
        data.departures[0].liveTripIdsByDate = ["2026-09-04": "friday-nine", "2026-09-07": "monday-nine"]
        let realtime = try JSONDecoder().decode(Realtime.self, from: Data(#"{"stale":false,"updates":[{"tripId":"monday-nine","stopId":"1","delaySeconds":999},{"tripId":"friday-nine","stopId":"1","delaySeconds":180}],"vehicles":[{"tripId":"friday-nine","boatName":"Friday vessel"}]}"#.utf8))
        let row = try XCTUnwrap(ScheduleEngine.timeline(data: data, realtime: realtime,
            now: ServiceClock.instant("2026-09-04T12:50:00Z")!).first { $0.departure.tripId == "nine" })
        XCTAssertEqual(row.departure.liveTripId, "friday-nine")
        XCTAssertEqual(row.delay, 180)
        XCTAssertEqual(row.boatName, "Friday vessel")
    }

    func testReviewedNovemberWeekdaysPreserveHistoricalAndWeekendBoundaries() throws {
        var data = try fixture().schedule
        data.meta.crewScheduleStatus = try JSONDecoder().decode(CrewStatus.self, from: Data(#"{"status":"unconfirmed","confirmedWeekdays":{"startDate":"2026-09-14","endDate":"2026-11-01"},"reviewedWeekdays":{"startDate":"2026-11-02","endDate":"2027-12-31","excludedDates":["2026-11-26"],"message":"6 boundaries unconfirmed"}}"#.utf8))
        XCTAssertNil(ScheduleEngine.crewCoverage(data, date: "2026-10-26")?.message)
        XCTAssertEqual(ScheduleEngine.crewCoverage(data, date: "2026-11-02")?.message, "6 boundaries unconfirmed")
        XCTAssertNil(ScheduleEngine.crewCoverage(data, date: "2026-11-07"))
        XCTAssertNil(ScheduleEngine.crewCoverage(data, date: "2026-11-26"))
    }

    func testConfirmedHolidayOverridesOrdinaryWeekdayExclusion() throws {
        var data = try fixture().schedule
        data.meta.crewScheduleStatus = try JSONDecoder().decode(CrewStatus.self, from: Data(#"{"status":"unconfirmed","confirmedWeekdays":{"startDate":"2026-09-14","endDate":"2026-11-01","excludedDates":["2026-09-28","2026-09-29"]},"confirmedHolidays":{"dates":["2026-09-28"]}}"#.utf8))
        data.departures[0].endsShift = "certain"
        let confirmed = ScheduleEngine.timeline(data: data, now: ServiceClock.instant("2026-09-28T12:50:00Z")!).first { $0.departure.tripId == "nine" }
        XCTAssertNotNil(ScheduleEngine.crewCoverage(data, date: "2026-09-28"))
        XCTAssertEqual(confirmed?.departure.endsShift, "certain")
        XCTAssertNil(ScheduleEngine.crewCoverage(data, date: "2026-09-29"))
    }

    func testReviewedWinterWeekendsKeepTheirOwnDatesAndWarnings() throws {
        var data = try fixture().schedule
        data.meta.crewScheduleStatus = try JSONDecoder().decode(CrewStatus.self, from: Data(#"{"status":"unconfirmed","reviewedWeekdays":{"startDate":"2026-11-02","endDate":"2027-12-31","message":"weekday review"},"reviewedWeekends":{"startDate":"2026-11-07","endDate":"2027-12-31","excludedDates":["2026-11-15"],"message":"weekend review"}}"#.utf8))
        XCTAssertEqual(ScheduleEngine.crewCoverage(data, date: "2026-11-09")?.message, "weekday review")
        for date in ["2026-11-07", "2026-11-08", "2026-11-14"] {
            XCTAssertEqual(ScheduleEngine.crewCoverage(data, date: date)?.message, "weekend review", date)
        }
        for date in ["2026-10-31", "2026-11-15", "2028-01-01"] {
            XCTAssertNil(ScheduleEngine.crewCoverage(data, date: date), date)
        }
    }

    func testCrewConfirmationHonorsSeasonAndExcludedDates() throws {
        var f = try fixture()
        f.schedule.meta.crewScheduleStatus = try JSONDecoder().decode(CrewStatus.self, from: Data(#"{"status":"unconfirmed","confirmedWeekdays":{"startDate":"2026-09-14","endDate":"2026-11-01","excludedDates":["2026-09-28"]},"confirmedWeekends":{"startDate":"2026-09-19","endDate":"2026-11-01","excludedDates":[]}}"#.utf8))
        f.schedule.departures[0].endsShift = "confirmed"
        for (date, expected) in [("2026-09-13", false), ("2026-09-14", true), ("2026-09-19", true), ("2026-09-28", false), ("2026-11-02", false)] {
            XCTAssertEqual(ScheduleEngine.crewCoverage(f.schedule, date: date) != nil, expected, date)
            let row = try XCTUnwrap(ScheduleEngine.timeline(data: f.schedule, now: ServiceClock.instant(date + "T12:50:00Z")!).first { $0.departure.tripId == "nine" })
            XCTAssertEqual(row.departure.endsShift, expected ? "confirmed" : nil, date)
        }
    }

    func testExceptionOnlyCoverageAndAfterMidnightClock() throws {
        var f = try fixture()
        f.schedule.calendars = []
        XCTAssertEqual(ScheduleEngine.range(f.schedule), "2026-09-07"..."2026-09-07")
        XCTAssertEqual(ServiceClock.time(seconds: 90600), "01:10")
        XCTAssertEqual(ServiceClock.time(seconds: 90600, twelveHour: true), "1:10 AM")
    }

    func testUnsupportedScheduleAndWrongLandingAreRejected() throws {
        var data = try fixture().schedule
        XCTAssertNoThrow(try data.validate(landingID: 16))
        XCTAssertThrowsError(try data.validate(landingID: 2))
        data.meta.schemaVersion = 12
        XCTAssertThrowsError(try data.validate())
    }

    func testSavedRideTimesRemoveDelayWithoutMixingArrivalAndDeparture() throws {
        let stop = try JSONDecoder().decode(RideStop.self, from: Data(#"{"stopId":"87","sequence":2,"name":"Pier 11","arrivalSeconds":36000,"departureSeconds":36600,"estimatedArrivalSeconds":36300,"estimatedDepartureSeconds":37200,"arrivalAt":1000000,"departureAt":1900000,"skipped":false,"current":true,"past":false}"#.utf8))
        XCTAssertEqual(stop.instant(arrival: true, stale: false)?.timeIntervalSince1970, 1000)
        XCTAssertEqual(stop.instant(arrival: true, stale: true)?.timeIntervalSince1970, 700)
        XCTAssertEqual(stop.instant(arrival: false, stale: true)?.timeIntervalSince1970, 1300)
    }

    private func pauseFixture() throws -> (DisplayData, ScheduledDeparture, Realtime) {
        var data = try fixture().schedule
        data.meta.showDwellTimes = true
        data.meta.showLayoverTimes = true
        data.tripSchedules["nine"] = try JSONDecoder().decode(TripSchedule.self, from: Data(#"{"stops":[{"stopId":"1","sequence":1,"arrivalSeconds":32280,"departureSeconds":32400},{"stopId":"2","sequence":2,"arrivalSeconds":33300,"departureSeconds":33300}],"turnaround":{"stopId":"2","nextTripId":"return","scheduledLayoverSeconds":300}}"#.utf8))
        let realtime = try JSONDecoder().decode(Realtime.self, from: Data(#"{"stale":false,"updates":[{"tripId":"nine","stopId":"1","delaySeconds":60},{"tripId":"nine","stopId":"2","delaySeconds":480},{"tripId":"return","stopId":"2","delaySeconds":120}]}"#.utf8))
        let row = try XCTUnwrap(ScheduleEngine.timeline(data: data, realtime: realtime,
            now: ServiceClock.instant("2026-09-04T12:50:00Z")!).first { $0.departure.tripId == "nine" })
        return (data, row, realtime)
    }

    func testDwellAndLayoverVisibilitySettingsAreIndependent() throws {
        let (originalData, row, realtime) = try pauseFixture()
        var data = originalData
        for dwell in [false, true] {
            for layover in [false, true] {
                data.meta.showDwellTimes = dwell
                data.meta.showLayoverTimes = layover
                let result = ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime)
                XCTAssertEqual(result.dwellSeconds, dwell ? 120 : nil)
                XCTAssertEqual(result.layover?.scheduledSeconds, layover ? 300 : nil)
                let terminal = try XCTUnwrap(data.tripSchedules["nine"]?.stops.last)
                XCTAssertEqual(ScheduleEngine.tripLayover(data: data, tripID: "nine", call: terminal)?.seconds,
                    layover ? 300 : nil)
            }
        }
        data.meta.showDwellTimes = nil
        data.meta.showLayoverTimes = nil
        let defaults = ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime)
        XCTAssertNil(defaults.dwellSeconds)
        XCTAssertEqual(defaults.layover?.scheduledSeconds, 300, "Layover remains visible unless explicitly disabled")
        data.meta.showDwellTimes = true
        data.tripSchedules["nine"]?.stops[0].arrivalSeconds = 32500
        XCTAssertNil(ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime).dwellSeconds,
            "An invalid negative dwell must not be shown")
    }

    func testTerminalLayoverUsesBothTripsAndPreservesOverruns() throws {
        let (data, row, originalRealtime) = try pauseFixture()
        var realtime = originalRealtime
        let result = ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime)
        XCTAssertEqual(result.dwellMinutes, 2)
        XCTAssertEqual(result.layover?.seconds, -60, "Use the terminal's 480-second delay, not this landing's 60-second delay")
        XCTAssertEqual(result.layover?.minutes, -1)
        XCTAssertEqual(result.layover?.hasLiveTiming, true)

        realtime.updates?[2].delaySeconds = nil
        XCTAssertEqual(ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime).layover?.seconds, -180)
        realtime.updates?[1].delaySeconds = nil
        realtime.updates?[2].delaySeconds = 120
        XCTAssertEqual(ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime).layover?.seconds, 420)
        realtime.updates?[1].delaySeconds = -60
        realtime.updates?[2].delaySeconds = -120
        XCTAssertEqual(ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime).layover?.seconds, 300,
            "Neither side of the turn may depart early")

        realtime.updates?[1].delaySeconds = 330
        realtime.updates?[2].delaySeconds = nil
        XCTAssertEqual(ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime).layover?.minutes, 0,
            "Round a negative half-minute as the web app does")
    }

    func testTerminalLayoverUsesArrivalDelayWithoutChangingDepartureDelay() throws {
        let (data, row, _) = try pauseFixture()
        let realtime = try JSONDecoder().decode(Realtime.self, from: Data(#"{"stale":false,"updates":[{"tripId":"nine","stopId":"2","delaySeconds":0,"arrivalDelaySeconds":480},{"tripId":"return","stopId":"2","delaySeconds":120,"arrivalDelaySeconds":900}]}"#.utf8))
        let pauses = ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime)
        XCTAssertEqual(pauses.layover?.seconds, -60, "Arrival consumes the turn; the next departure delay lengthens it")
        XCTAssertEqual(pauses.layover?.hasLiveTiming, true)
        XCTAssertEqual(realtime.updates?.first?.delaySeconds, 0, "The boat's on-time departure is still independently available")
    }

    func testCanceledStaleAndBrowsedLayoversFallBackToSchedule() throws {
        let (data, originalRow, originalRealtime) = try pauseFixture()
        var row = originalRow
        var realtime = originalRealtime
        for canceledIndex in [1, 2] {
            realtime.updates?[canceledIndex].canceled = true
            let value = ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime)
            XCTAssertEqual(value.layover?.seconds, 300)
            XCTAssertEqual(value.layover?.hasLiveTiming, false)
            realtime.updates?[canceledIndex].canceled = false
        }
        realtime.stale = true
        XCTAssertNil(ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime).layover?.estimatedSeconds)
        realtime.stale = false
        row.live = false
        XCTAssertNil(ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime).layover?.estimatedSeconds)
        row.live = true
        row.departure.scheduleOnly = true
        XCTAssertNil(ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime).layover?.estimatedSeconds)
    }

    func testNonPassengerAndFinalShiftRowsHideBothPauses() throws {
        let (data, originalRow, realtime) = try pauseFixture()
        var row = originalRow
        row.departure.outOfService = true
        XCTAssertEqual(ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime), DeparturePauses())
        row.departure.outOfService = false
        row.departure.crewShuttle = true
        XCTAssertEqual(ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime), DeparturePauses())
        row.departure.crewShuttle = false
        row.departure.endsShift = "certain"
        XCTAssertEqual(ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime), DeparturePauses())
    }

    func testTripLayoverRequiresMatchingTerminalAndFreshTiming() throws {
        var (data, _, _) = try pauseFixture()
        let origin = try XCTUnwrap(data.tripSchedules["nine"]?.stops.first)
        let terminal = try XCTUnwrap(data.tripSchedules["nine"]?.stops.last)
        XCTAssertNil(ScheduleEngine.tripLayover(data: data, tripID: "nine", call: origin))
        XCTAssertEqual(ScheduleEngine.tripLayover(data: data, tripID: "nine", call: terminal)?.seconds, 300)
        data.tripSchedules["nine"]?.turnaround?.stopId = "1"
        XCTAssertNil(ScheduleEngine.tripLayover(data: data, tripID: "nine", call: terminal),
            "The final sequence alone does not establish a terminal turn")
        XCTAssertNil(ScheduleEngine.tripLayover(data: data, tripID: "nine", call: origin),
            "A repeated stop ID before the final sequence does not own the turn")

        let enriched = try JSONDecoder().decode(Turnaround.self, from: Data(#"{"scheduledSeconds":300,"estimatedSeconds":-180,"hasLiveTiming":true}"#.utf8))
        let live = try XCTUnwrap(ScheduleEngine.tripLayover(data: data, tripID: "nine", call: terminal,
            connectionTurnaround: enriched, live: true))
        XCTAssertEqual(live.scheduledMinutes, 5)
        XCTAssertEqual(live.estimatedMinutes, -3)
        let saved = ScheduleEngine.tripLayover(data: data, tripID: "nine", call: terminal, connectionTurnaround: enriched)
        XCTAssertEqual(saved?.seconds, 300)
        XCTAssertNil(saved?.estimatedSeconds)
        data.meta.showLayoverTimes = false
        XCTAssertNil(ScheduleEngine.tripLayover(data: data, tripID: "nine", call: terminal,
            connectionTurnaround: enriched, live: true))
    }

    func testDisplayTripKeepsDwellWhileMappedLiveTripsSupplyTerminalDelays() throws {
        let (originalData, originalRow, _) = try pauseFixture()
        var data = originalData
        var row = originalRow
        row.departure.liveTripId = "live-nine"
        row.departure.scheduleOnly = true
        data.tripSchedules["nine"]?.liveTripId = "live-nine"
        data.tripSchedules["nine"]?.turnaround?.nextTripId = "nyc:sukkot:trip:return"
        data.tripSchedules["nine"]?.turnaround?.nextLiveTripId = "live-return"
        data.tripSchedules["live-nine"] = try JSONDecoder().decode(TripSchedule.self, from: Data(#"{"stops":[{"stopId":"1","sequence":1,"arrivalSeconds":30000,"departureSeconds":32400}]}"#.utf8))
        let realtime = try JSONDecoder().decode(Realtime.self, from: Data(#"{"stale":false,"updates":[{"tripId":"live-nine","stopId":"2","delaySeconds":480},{"tripId":"live-return","stopId":"2","delaySeconds":120}]}"#.utf8))
        let pauses = ScheduleEngine.departurePauses(data: data, row: row, realtime: realtime)
        XCTAssertEqual(pauses.dwellSeconds, 120, "Use the display trip's own verified schedule before trying a feed-ID key")
        XCTAssertEqual(pauses.layover?.seconds, -60, "Use the distinct verified feed IDs on both sides of the turn")
        XCTAssertEqual(pauses.layover?.hasLiveTiming, true)
    }
}
