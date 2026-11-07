import XCTest
@testable import FerryCore

/// Actual bundled schedules, including every Sukkot date and nearby confirmed crew days.
/// Regenerate the optional exhaustive contract with scripts/build-ios-service-contract.mjs.
final class ServiceDataParityTests: XCTestCase {
    private var root: URL {
        var value = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { value.deleteLastPathComponent() }
        return value
    }

    private struct HolidaySource: Decodable { var dates: [String] }
    private struct HolidayMapping: Decodable {
        struct Match: Decodable { var tripId: String; var boatAssignment: Int? }
        var matches: [String: Match]
    }
    private struct Manifest: Decodable { var holidayDates: [String]; var schedules: [String]; var cases: Int; var departures: Int }
    private struct ActualSchedule: Decodable {
        struct Scenario: Decodable {
            var name: String; var date: String; var now: String; var viewDate: String?; var stale: Bool
            var crewConfirmed: Bool; var expected: [Projection]
        }
        var schedule: DisplayData; var realtime: Realtime; var cases: [Scenario]
    }
    private struct Projection: Decodable, Equatable {
        var tripId: String; var routeId: String; var stopId: String; var serviceDate: String
        var seconds: Double; var delay: Double; var hasLiveTiming: Bool
        var boatAssignment: Int?; var boatName: String?; var predictedBoatName: String?
        var endsShift: String?; var endsDay: Bool?; var fromHomePort: Bool?; var outOfService: Bool?
        var crewShuttle: Bool?; var arrival: Bool?; var approximate: Bool?; var scheduleOnly: Bool?; var timetableOnly: Bool?
        var liveTripId: String?; var predictTripId: String?; var secondsEnd: Double?; var crewBoats: [String]?
        var dwellMinutes: Int?; var layoverMinutes: Int?; var layoverLive: Bool?

        init(_ row: ScheduledDeparture, pauses: DeparturePauses) {
            let d = row.departure
            tripId = d.tripId; routeId = d.routeId; stopId = d.stopId; serviceDate = row.serviceDate
            seconds = d.seconds; delay = row.delay; hasLiveTiming = row.hasLiveTiming
            boatAssignment = d.boatAssignment; boatName = row.boatName; predictedBoatName = row.predictedBoatName
            endsShift = d.endsShift; endsDay = d.endsDay; fromHomePort = d.fromHomePort; outOfService = d.outOfService
            crewShuttle = d.crewShuttle; arrival = d.arrival; approximate = d.approximate
            scheduleOnly = d.scheduleOnly; timetableOnly = d.timetableOnly
            liveTripId = d.liveTripId; predictTripId = d.predictTripId; secondsEnd = d.secondsEnd; crewBoats = d.crewBoats
            dwellMinutes = pauses.dwellMinutes; layoverMinutes = pauses.layover?.minutes; layoverLive = pauses.layover?.hasLiveTiming
        }
    }

    func testBundledHolidayRowsUseVerifiedWorkingsAndTripSchedules() throws {
        let source = try JSONDecoder().decode(HolidaySource.self, from: Data(contentsOf: root.appendingPathComponent("schedules/sukkot-2026.json")))
        let mappings = try JSONDecoder().decode(HolidayMapping.self, from: Data(contentsOf: root.appendingPathComponent("schedules/sukkot-2026-live.json")))
        var data = try JSONDecoder().decode(DisplayData.self, from: Data(contentsOf: root.appendingPathComponent("public/data/display-data.json")))
        try data.validate()
        data.meta.showDwellTimes = true
        data.meta.showLayoverTimes = true
        XCTAssertEqual(source.dates, ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"])
        for date in source.dates {
            let rows = ScheduleEngine.timeline(data: data, now: ServiceClock.instant(date + "T04:00:00Z")!)
            let nyc = rows.filter { $0.departure.scheduleOnly == true }
            XCTAssertFalse(nyc.isEmpty, date)
            XCTAssertNotNil(ScheduleEngine.crewCoverage(data, date: date))
            XCTAssertTrue(nyc.contains { $0.departure.liveTripId != nil && $0.departure.boatAssignment != nil })
            for row in nyc {
                if let liveID = row.departure.liveTripId {
                    XCTAssertEqual(liveID, mappings.matches[row.departure.tripId]?.tripId, row.id)
                    XCTAssertEqual(row.departure.boatAssignment, mappings.matches[row.departure.tripId]?.boatAssignment, row.id)
                } else {
                    XCTAssertNil(row.departure.boatAssignment, row.id)
                    XCTAssertFalse(row.hasLiveTiming, row.id)
                }
                let trip = try XCTUnwrap(data.tripSchedules[row.departure.tripId])
                let pauses = ScheduleEngine.departurePauses(data: data, row: row, realtime: .empty)
                if trip.timetableOnly == true {
                    if trip.stops.first(where: { $0.stopId == row.departure.stopId })?.arrivalSeconds == nil {
                        XCTAssertNil(pauses.dwellSeconds, "Do not invent dwell where no arrival exists: " + row.id)
                    }
                    XCTAssertNil(pauses.layover)
                }
            }
        }
    }

    func testEveryGeneratedLandingAndServiceDateMatchesWebEngine() throws {
        let directory = ProcessInfo.processInfo.environment["FERRY_SERVICE_CONTRACT"].map { URL(fileURLWithPath: $0) }
            ?? root.appendingPathComponent("ios/DerivedData/ServiceParity")
        let manifestURL = directory.appendingPathComponent("manifest.json")
        guard FileManager.default.fileExists(atPath: manifestURL.path) else {
            throw XCTSkip("Generate actual-data parity fixtures with node scripts/build-ios-service-contract.mjs")
        }
        let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: manifestURL))
        XCTAssertEqual(manifest.schedules.count, 31)
        XCTAssertEqual(manifest.holidayDates.count, 5)
        var caseCount = 0, departureCount = 0
        for filename in manifest.schedules {
            let contract = try JSONDecoder().decode(ActualSchedule.self, from: Data(contentsOf: directory.appendingPathComponent(filename)))
            try contract.schedule.validate()
            for scenario in contract.cases {
                var realtime = contract.realtime
                realtime.stale = scenario.stale
                let rows = ScheduleEngine.timeline(data: contract.schedule, realtime: realtime,
                    viewDate: scenario.viewDate, now: try XCTUnwrap(ServiceClock.instant(scenario.now)))
                let actual = rows.map { Projection($0, pauses: ScheduleEngine.departurePauses(data: contract.schedule, row: $0, realtime: realtime)) }
                XCTAssertEqual(actual.count, scenario.expected.count, scenario.name)
                XCTAssertEqual(ScheduleEngine.crewCoverage(contract.schedule, date: scenario.date) != nil, scenario.crewConfirmed, scenario.name)
                for (index, pair) in zip(actual, scenario.expected).enumerated() where pair.0 != pair.1 {
                    XCTAssertEqual(pair.0, pair.1, "\(scenario.name), departure \(index)")
                    return // Report the first useful difference rather than flooding the test log.
                }
                if contract.schedule.meta.landingNumber == 27 {
                    if manifest.holidayDates.contains(scenario.date) {
                        XCTAssertTrue(rows.contains { $0.departure.fromHomePort == true && $0.departure.boatAssignment != nil })
                        XCTAssertTrue(rows.contains { $0.departure.crewShuttle == true && $0.departure.crewBoats?.isEmpty == false })
                    } else if scenario.viewDate != nil {
                        XCTAssertTrue(rows.contains { $0.departure.fromHomePort == true && $0.departure.boatAssignment != nil })
                        if scenario.date < "2026-11-02" {
                            XCTAssertTrue(rows.contains { $0.departure.crewShuttle == true && $0.departure.crewBoats?.isEmpty == false })
                        } else {
                            XCTAssertFalse(rows.contains { $0.departure.crewShuttle == true }, "Current relief notes do not establish endpoint departure times")
                        }
                        XCTAssertTrue(rows.filter { $0.departure.fromHomePort == true }.allSatisfy { $0.departure.approximate == true })
                    }
                }
                caseCount += 1
                departureCount += actual.count
            }
        }
        XCTAssertEqual(caseCount, manifest.cases)
        XCTAssertEqual(departureCount, manifest.departures)
        print("Actual service parity: \(manifest.schedules.count) landings, \(caseCount) cases, \(departureCount) departure projections")
    }
}
