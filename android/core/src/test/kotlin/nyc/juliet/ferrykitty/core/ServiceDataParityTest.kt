package nyc.juliet.ferrykitty.core

import java.io.File
import java.time.Instant
import kotlinx.serialization.Serializable
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

class ServiceDataParityTest {
	@Serializable private data class HolidaySource(val dates: List<String>)
	@Serializable private data class HolidayMapping(val matches: Map<String, Match>) {
		@Serializable data class Match(val tripId: String, val boatAssignment: Int? = null)
	}
	@Serializable private data class Manifest(val holidayDates: List<String>, val schedules: List<String>, val cases: Int, val departures: Int)
	@Serializable private data class ActualSchedule(val schedule: DisplayData, val realtime: Realtime, val cases: List<Scenario>) {
		@Serializable data class Scenario(val name: String, val date: String, val now: String, val viewDate: String? = null, val stale: Boolean, val crewConfirmed: Boolean, val expected: List<Projection>)
	}
	@Serializable private data class Projection(
		val tripId: String, val routeId: String, val stopId: String, val serviceDate: String,
		val seconds: Double, val delay: Double, val hasLiveTiming: Boolean,
		val boatAssignment: Int? = null, val boatName: String? = null, val predictedBoatName: String? = null,
		val endsShift: String? = null, val endsDay: Boolean? = null, val fromHomePort: Boolean? = null, val outOfService: Boolean? = null,
		val crewShuttle: Boolean? = null, val arrival: Boolean? = null, val approximate: Boolean? = null, val scheduleOnly: Boolean? = null, val timetableOnly: Boolean? = null,
		val liveTripId: String? = null, val predictTripId: String? = null, val secondsEnd: Double? = null, val crewBoats: List<String>? = null,
		val dwellMinutes: Int? = null, val layoverMinutes: Int? = null, val layoverLive: Boolean? = null,
	) {
		constructor(row: ScheduledDeparture, pauses: DeparturePauses) : this(
			row.departure.tripId, row.departure.routeId, row.departure.stopId, row.serviceDate, row.departure.seconds, row.delay, row.hasLiveTiming,
			row.departure.boatAssignment, row.boatName, row.predictedBoatName, row.departure.endsShift, row.departure.endsDay,
			row.departure.fromHomePort, row.departure.outOfService, row.departure.crewShuttle, row.departure.arrival,
			row.departure.approximate, row.departure.scheduleOnly, row.departure.timetableOnly, row.departure.liveTripId, row.departure.predictTripId,
			row.departure.secondsEnd, row.departure.crewBoats, pauses.dwellMinutes, pauses.layover?.minutes, pauses.layover?.hasLiveTiming,
		)
	}

	@Test fun bundledHolidayRowsUseVerifiedWorkingsWithoutInventingTimetablePauses() {
		val source: HolidaySource = decode(File(repoRoot, "schedules/sukkot-2026.json").readText())
		val mappings: HolidayMapping = decode(File(repoRoot, "schedules/sukkot-2026-live.json").readText())
		val schedule: DisplayData = decode(File(repoRoot, "public/data/display-data.json").readText())
		schedule.validate()
		val data = schedule.copy(meta = schedule.meta.copy(showDwellTimes = true, showLayoverTimes = true))
		assertEquals(listOf("2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"), source.dates)
		for (date in source.dates) {
			val rows = ScheduleEngine.timeline(data, now = Instant.parse(date + "T04:00:00Z")).filter { it.departure.scheduleOnly == true }
			assertFalse(date, rows.isEmpty())
			assertNotNull(ScheduleEngine.crewCoverage(data, date))
			assertTrue(rows.any { it.departure.liveTripId != null && it.departure.boatAssignment != null })
			for (row in rows) {
				val departure = row.departure
				if (departure.liveTripId != null) {
					assertEquals(row.id, mappings.matches[departure.tripId]?.tripId, departure.liveTripId)
					assertEquals(row.id, mappings.matches[departure.tripId]?.boatAssignment, departure.boatAssignment)
				} else {
					assertNull(row.id, departure.boatAssignment)
					assertFalse(row.id, row.hasLiveTiming)
				}
				val trip = requireNotNull(data.tripSchedules[departure.tripId])
				if (trip.timetableOnly == true) {
					val pauses = ScheduleEngine.departurePauses(data, row, Realtime.empty)
					if (trip.stops.firstOrNull { it.stopId == departure.stopId }?.arrivalSeconds == null) assertNull(row.id, pauses.dwellSeconds)
					assertNull(row.id, pauses.layover)
				}
			}
		}
	}

	@Test fun everyGeneratedLandingAndServiceDateMatchesWebEngine() {
		val directory = System.getenv("FERRY_SERVICE_CONTRACT")?.let { File(it) } ?: File(repoRoot, "ios/DerivedData/ServiceParity")
		assumeTrue("Generate parity fixtures with node scripts/build-ios-service-contract.mjs <output>; set FERRY_SERVICE_CONTRACT", File(directory, "manifest.json").isFile)
		val manifest: Manifest = decode(File(directory, "manifest.json").readText())
		assertEquals(31, manifest.schedules.size)
		assertEquals(5, manifest.holidayDates.size)
		var caseCount = 0
		var departureCount = 0
		for (filename in manifest.schedules) {
			val contract: ActualSchedule = decode(File(directory, filename).readText())
			contract.schedule.validate()
			for (case in contract.cases) {
				val realtime = contract.realtime.copy(stale = case.stale)
				val rows = ScheduleEngine.timeline(contract.schedule, realtime, case.viewDate, Instant.parse(case.now))
				val actual = rows.map { Projection(it, ScheduleEngine.departurePauses(contract.schedule, it, realtime)) }
				assertEquals(case.name, case.expected.size, actual.size)
				assertEquals(case.name, case.crewConfirmed, ScheduleEngine.crewCoverage(contract.schedule, case.date) != null)
				for (index in actual.indices) assertEquals("${case.name}, departure $index", case.expected[index], actual[index])
				if (contract.schedule.meta.landingNumber == 27 && (case.date in manifest.holidayDates || case.viewDate != null)) {
					assertTrue(case.name, rows.any { it.departure.fromHomePort == true && it.departure.boatAssignment != null })
					if (case.date < "2026-11-02") {
						assertTrue(case.name, rows.any { it.departure.crewShuttle == true && !it.departure.crewBoats.isNullOrEmpty() })
					} else {
						assertFalse("Current relief notes do not establish endpoint departure times", rows.any { it.departure.crewShuttle == true })
					}
					if (case.date !in manifest.holidayDates) assertTrue(case.name, rows.filter { it.departure.fromHomePort == true }.all { it.departure.approximate == true })
				}
				caseCount++
				departureCount += rows.size
			}
		}
		assertEquals(manifest.cases, caseCount)
		assertEquals(manifest.departures, departureCount)
		println("Actual service parity: ${manifest.schedules.size} landings, $caseCount cases, $departureCount departure projections")
	}

	@Test fun allExistingNativePreviewResponsesDecodeWithoutInventedModels() {
		val directory = File(repoRoot, "ios/FerryKitty/PreviewData")
		fun bytes(name: String) = File(directory, "$name.json").readBytes()
		assertFalse(FerryJson.decode<LandingRoster>(bytes("landings")).landings.isEmpty())
		for (landing in listOf(16, 26)) FerryJson.decode<DisplayData>(bytes("schedule-$landing")).validate(landing)
		FerryJson.decode<Realtime>(bytes("realtime"))
		FerryJson.decode<Alerts>(bytes("alerts"))
		assertFalse(FerryJson.decode<Harbor>(bytes("map")).landings.isEmpty())
		FerryJson.decode<Boats>(bytes("boats"))
		FerryJson.decode<Connections>(bytes("connections"))
		FerryJson.decode<Vessels>(bytes("vessels"))
		FerryJson.decode<Ride>(bytes("ride-opportunity"))
		FerryJson.decode<Ride>(bytes("ride-bay-hopper"))
		FerryJson.decode<Changelog>(bytes("changelog"))
	}
}
