package nyc.juliet.ferrykitty.ui.board

import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.roundToInt
import nyc.juliet.ferrykitty.core.Departure
import nyc.juliet.ferrykitty.core.DeparturePauses
import nyc.juliet.ferrykitty.core.ScheduledDeparture
import nyc.juliet.ferrykitty.core.ServiceClock

/** Wording and layout rules for the departure board, kept apart from composables so they can be unit tested. */
object BoardFormat {
	/** A second column once each can hold time, route, destination and status at about 300 dp. */
	const val TWO_COLUMN_WIDTH = 600f
	const val WIDE_MAX_WIDTH = 1200f
	const val NARROW_MAX_WIDTH = 900f

	fun columns(widthDp: Float, accessibilityText: Boolean): Int =
		if (!accessibilityText && widthDp >= TWO_COLUMN_WIDTH) 2 else 1

	/** Row-major, so the next two sailings share the first row. */
	fun <T> rows(items: List<T>, columns: Int): List<List<T>> = items.chunked(columns.coerceAtLeast(1))

	/** The countdown in the time column's width. Minutes round up, as on the web board. */
	fun countdown(delta: Double, live: Boolean, dueLabel: String): String {
		if (!live) return ""
		if (delta <= 90) return dueLabel
		if (delta >= 86400) return "Tomorrow"
		val minutes = ceil(delta / 60).toInt()
		if (minutes < 60) return "$minutes min"
		return if (minutes % 60 == 0) "${minutes / 60}h" else "${minutes / 60}h ${minutes % 60}m"
	}

	fun spokenCountdown(delta: Double, live: Boolean, dueLabel: String): String? {
		if (!live) return null
		if (delta <= 90) return dueLabel
		if (delta >= 86400) return "tomorrow"
		val minutes = ceil(delta / 60).toInt()
		val hours = minutes / 60
		val remainder = minutes % 60
		return "in " + listOfNotNull(
			if (hours > 0) "$hours hour${if (hours == 1) "" else "s"}" else null,
			if (remainder > 0) "$remainder minute${if (remainder == 1) "" else "s"}" else null,
		).joinToString(" ")
	}

	private val shortDate = DateTimeFormatter.ofPattern("EEE MMM d", Locale.US)
	private val longDate = DateTimeFormatter.ofPattern("EEEE, MMMM d, yyyy", Locale.US)

	/** Browsed dates name their weekday: weekday and weekend timetables differ. */
	fun dateLabel(key: String): String = try { LocalDate.parse(key).format(shortDate) } catch (_: Exception) { key }

	fun spokenDate(key: String): String = try { LocalDate.parse(key).format(longDate) } catch (_: Exception) { key }

	enum class Tone { POSITIVE, WARNING, DANGER, NEUTRAL }

	data class Status(val text: String, val tone: Tone)

	fun noPickup(departure: Departure): Boolean =
		departure.arrival == true || departure.outOfService == true || departure.crewShuttle == true

	fun dueLabel(departure: Departure): String = if (noPickup(departure)) "Due" else "Boarding"

	fun status(row: ScheduledDeparture): Status {
		val departure = row.departure
		return when {
			departure.arrival == true -> Status("DROP OFF ONLY", Tone.WARNING)
			departure.crewShuttle == true || departure.outOfService == true -> Status("NO PICKUP", Tone.WARNING)
			row.hasLiveTiming && row.delay >= 60 -> Status("+${(row.delay / 60).roundToInt()}m", Tone.WARNING)
			row.hasLiveTiming -> Status("ON TIME", Tone.POSITIVE)
			else -> Status("SCHED", Tone.NEUTRAL)
		}
	}

	/** A passenger trip that ends the boat's shift. Movements without passengers never say FINAL. */
	fun finalLabel(departure: Departure): String? {
		val end = departure.endsShift
		if (end.isNullOrEmpty() || departure.outOfService == true || departure.crewShuttle == true) return null
		return if (end == "unsure") "FINAL?" else "FINAL"
	}

	fun timeLabel(row: ScheduledDeparture, twelveHour: Boolean): String =
		ServiceClock.time(row.departure.seconds + row.delay, twelveHour) + if (row.departure.approximate == true) "*" else ""

	/** The published time, with its end for a window such as a home-port departure. */
	fun publishedTime(departure: Departure, twelveHour: Boolean): String {
		val start = ServiceClock.time(departure.seconds, twelveHour) + if (departure.approximate == true) "*" else ""
		return departure.secondsEnd?.let { start + "–" + ServiceClock.time(it, twelveHour) } ?: start
	}

	/** The working number crews use, such as ER1, from the route's short name. */
	fun working(departure: Departure, shortName: String?): String? =
		departure.boatAssignment?.let { "${shortName ?: departure.routeId}$it" }

	fun until(departure: Departure, twelveHour: Boolean): String? =
		departure.secondsEnd?.let { "until " + ServiceClock.time(it, twelveHour) }

	/** Partner operators are shown by their own marks rather than a route letter. */
	enum class Partner(val code: String, val prefixes: List<String>) {
		WATERWAY("NYW", listOf("wtr:", "wbf:")),
		SEASTREAK("SEA", listOf("sea:")),
		NYU("NYU", listOf("nyu:")),
		CITY_FERRY("CITY", listOf("lib:")),
		GOVERNORS_ISLAND("GI", listOf("gi:")),
	}

	fun partner(routeId: String): Partner? = Partner.entries.firstOrNull { partner -> partner.prefixes.any { routeId.startsWith(it) } }

	/** Named only for operators without a partner mark in the route badge. */
	fun otherOperator(routeId: String, operatorName: String): String? =
		if (partner(routeId) == null && !routeId.startsWith("nyc:") && operatorName != "NYC Ferry") operatorName else null

	/** Everything after the vessel on a row's second line, in the iOS order. */
	fun details(row: ScheduledDeparture, pauses: DeparturePauses?, twelveHour: Boolean, otherOperator: String?): List<String> {
		val departure = row.departure
		val parts = mutableListOf<String>()
		val until = until(departure, twelveHour)
		when {
			departure.crewShuttle == true -> parts += listOfNotNull("Crew shuttle", until).joinToString(" ")
			departure.outOfService == true -> parts += listOfNotNull("Out of service", until).joinToString(" ")
			else -> {
				until?.let { parts += it }
				otherOperator?.let { parts += it }
			}
		}
		via(departure)?.let { parts += it }
		// Most feeds repeat the arrival time as the departure time; a zero dwell says nothing.
		pauses?.dwellMinutes?.takeIf { it > 0 }?.let { parts += "Dwell ${it}m" }
		pauses?.layover?.let { parts += "Layover ${it.minutes}m ${if (it.hasLiveTiming) "est" else "sched"}" }
		if (departure.approximate == true && departure.fromHomePort == true) parts += "Approx. · first pickup at destination"
		return parts
	}

	fun via(departure: Departure): String? {
		val terminals = departure.viaTerminals.orEmpty()
		if (terminals.isNotEmpty()) return terminals.joinToString(" · ") { "VIA " + it.code }
		val via = departure.via.orEmpty()
		return if (via.isNotEmpty()) "via " + via.joinToString(", ") else null
	}

	/** TalkBack reads the row as one sentence rather than its abbreviations. */
	fun spoken(row: ScheduledDeparture, pauses: DeparturePauses?, twelveHour: Boolean, showRoute: Boolean, shortName: String?, operator: String?): String {
		val departure = row.departure
		val parts = mutableListOf(ServiceClock.time(departure.seconds + row.delay, twelveHour) + if (departure.approximate == true) ", approximate" else "")
		spokenCountdown(row.delta, row.live, dueLabel(departure))?.let { parts += it }
		if (showRoute) {
			parts += "${shortName ?: departure.routeId} to ${departure.destination}"
			operator?.let { parts += it }
		}
		val status = status(row).text
		parts += if (status == "SCHED") "scheduled" else status.lowercase(Locale.US)
		if (row.isLastOfDay) parts += "last departure" else if (row.isLastGovernorsIsland) parts += "last to Governors Island"
		finalLabel(departure)?.let { parts += if (it == "FINAL") "final, no return trip" else "final, return trip unconfirmed" }
		working(departure, shortName)?.let { parts += "working $it" }
		when {
			row.boatName != null -> parts += "vessel ${row.boatName}"
			row.predictedBoatName != null -> parts += "predicted vessel ${row.predictedBoatName}, unconfirmed"
			!departure.crewBoats.isNullOrEmpty() -> parts += departure.crewBoats.orEmpty().joinToString(", ")
		}
		if (departure.crewShuttle == true) parts += "crew shuttle" else if (departure.outOfService == true) parts += "out of service"
		until(departure, twelveHour)?.let { parts += it }
		val terminals = departure.viaTerminals.orEmpty()
		if (terminals.isNotEmpty()) parts += "via " + terminals.joinToString(", ") { it.name ?: it.code }
		else if (!departure.via.isNullOrEmpty()) parts += "via " + departure.via.orEmpty().joinToString(", ")
		pauses?.dwellMinutes?.takeIf { it > 0 }?.let { parts += "dwell $it minutes" }
		pauses?.layover?.let { parts += "layover ${it.minutes} minutes ${if (it.hasLiveTiming) "estimated" else "scheduled"}" }
		if (departure.approximate == true && departure.fromHomePort == true) parts += "first pickup time at destination"
		return parts.joinToString(", ")
	}
}
