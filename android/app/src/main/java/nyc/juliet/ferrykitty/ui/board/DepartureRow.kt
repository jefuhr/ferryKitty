package nyc.juliet.ferrykitty.ui.board

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import nyc.juliet.ferrykitty.contract.FerryUiState
import nyc.juliet.ferrykitty.core.DepartureGroup
import nyc.juliet.ferrykitty.core.DisplayData
import nyc.juliet.ferrykitty.core.Realtime
import nyc.juliet.ferrykitty.core.ScheduledDeparture
import nyc.juliet.ferrykitty.ui.FerryUi
import nyc.juliet.ferrykitty.ui.components.RouteBadge
import nyc.juliet.ferrykitty.ui.components.StatusPill
import nyc.juliet.ferrykitty.ui.components.TouchTarget
import nyc.juliet.ferrykitty.ui.sheets.FilterLogic
import nyc.juliet.ferrykitty.ui.theme.FerryText
import nyc.juliet.ferrykitty.ui.theme.ferryColors

/** What every row on the board needs, computed once per state rather than per row. */
@Immutable
internal class BoardContext(
	val schedule: DisplayData?,
	val display: DisplayData?,
	val realtime: Realtime,
	val twelveHour: Boolean,
	val accessibilityText: Boolean,
	val timeWidth: Dp,
	val countdownWidth: Dp,
)

@Composable
internal fun rememberBoardContext(state: FerryUiState, accessibilityText: Boolean): BoardContext {
	val measurer = rememberTextMeasurer()
	val density = LocalDensity.current
	val twelveHour = state.preferences.twelveHour
	// Sized by templates so times and countdowns line up down the board at any text size.
	val timeWidth = remember(measurer, density, twelveHour) {
		with(density) { measurer.measure(if (twelveHour) "00:00 PM*" else "00:00*", FerryText.clock).size.width.toDp() + 2.dp }
	}
	val countdownWidth = remember(measurer, density) {
		with(density) { measurer.measure("00h 00m", FerryText.countdown).size.width.toDp() + 2.dp }
	}
	val display = remember(state.schedule, state.preferences) { BoardModel.displaySchedule(state.schedule, state.preferences) }
	return remember(state.schedule, display, state.realtime, twelveHour, accessibilityText, timeWidth, countdownWidth) {
		BoardContext(state.schedule, display, state.realtime, twelveHour, accessibilityText, timeWidth, countdownWidth)
	}
}

/**
 * One sailing in two lines. By time: when, route and destination, status; then the countdown and who is working it.
 * By route the group already names the destination, so the first line names the boat.
 */
@Composable
internal fun DepartureRow(row: ScheduledDeparture, context: BoardContext, showRoute: Boolean, onOpen: (ScheduledDeparture) -> Unit, modifier: Modifier = Modifier) {
	val departure = row.departure
	val route = context.schedule?.routes?.get(departure.routeId)
	val pauses = remember(row, context.display, context.realtime) { BoardModel.pauses(context.display, row, context.realtime) }
	val canOpen = remember(row, context.schedule) { BoardModel.canOpen(context.schedule, row) }
	val operatorName = FilterLogic.operatorName(departure, context.schedule)
	val otherOperator = BoardFormat.otherOperator(departure.routeId, operatorName)
	val spokenOperator = otherOperator ?: if (BoardFormat.partner(departure.routeId) != null) operatorName else null
	val spoken = remember(row, pauses, context.twelveHour, showRoute, route) {
		BoardFormat.spoken(row, pauses, context.twelveHour, showRoute, route?.shortName, spokenOperator)
	}
	val countdown = BoardFormat.countdown(row.delta, row.live, BoardFormat.dueLabel(departure))
	val status = BoardFormat.status(row)
	val vessel = vesselText(row, route?.shortName)
	val details = BoardFormat.details(row, pauses, context.twelveHour, otherOperator)
	val detailLine = buildAnnotatedString {
		if (showRoute && vessel != null) {
			withStyle(SpanStyle(color = ferryColors.ink)) { append(vessel) }
			if (details.isNotEmpty()) append(" · ")
		}
		details.forEachIndexed { index, part ->
			if (index > 0) append(" · ")
			if (part.startsWith("VIA ")) withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(part) } else append(part)
		}
	}
	val last = row.isLastOfDay || row.isLastGovernorsIsland
	val final = BoardFormat.finalLabel(departure)
	val timeLabel = BoardFormat.timeLabel(row, context.twelveHour)

	Box(
		modifier = modifier
			.testTag("departure-${departure.tripId}")
			.then(if (canOpen) Modifier.clickable(role = Role.Button, onClickLabel = "Show trip details") { onOpen(row) } else Modifier)
			.clearAndSetSemantics {
				contentDescription = spoken + if (canOpen) "" else ". Published movement; no trip detail available"
				if (canOpen) role = Role.Button
			}
			.heightIn(min = TouchTarget)
			.padding(horizontal = 12.dp, vertical = 6.dp),
		contentAlignment = Alignment.CenterStart,
	) {
		if (context.accessibilityText) {
			Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
				Row(verticalAlignment = Alignment.CenterVertically) {
					Text(timeLabel, style = FerryText.clock, color = ferryColors.ink)
					Spacer(Modifier.weight(1f))
					Text(countdown, style = FerryText.countdown, color = ferryColors.accent)
				}
				if (showRoute) {
					Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
						RouteBadge(departure.routeId, departure.variant, route, operatorName)
						Text(departure.destination, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = ferryColors.heading)
					}
				} else if (vessel != null) Text(vessel, style = MaterialTheme.typography.bodyMedium, color = ferryColors.ink)
				Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
					StatusPill(status.text, status.tone)
					if (last) StatusPill("LAST", BoardFormat.Tone.DANGER)
					final?.let { StatusPill(it, BoardFormat.Tone.WARNING) }
				}
				if (detailLine.isNotEmpty()) Text(detailLine, style = FerryText.caption, color = ferryColors.muted)
			}
		} else {
			Row {
				Column(Modifier.width(context.timeWidth)) {
					Text(timeLabel, style = FerryText.clock, color = ferryColors.ink, maxLines = 1, softWrap = false)
					if (showRoute && countdown.isNotEmpty()) {
						Text(countdown, style = FerryText.countdown, color = ferryColors.accent, maxLines = 1, softWrap = false)
					}
				}
				Spacer(Modifier.width(8.dp))
				Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
					// Top-aligned so a two-line destination keeps its badge and status beside the first line, as on iOS.
					Row(verticalAlignment = Alignment.Top) {
						if (showRoute) {
							RouteBadge(departure.routeId, departure.variant, route, operatorName)
							Spacer(Modifier.width(6.dp))
							Text(departure.destination, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold,
								color = ferryColors.heading, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
						} else {
							Text(countdown, style = FerryText.countdown, color = ferryColors.accent, maxLines = 1, softWrap = false,
								modifier = Modifier.width(context.countdownWidth))
							Text(vessel ?: AnnotatedString(""), style = MaterialTheme.typography.bodyMedium, color = ferryColors.ink, maxLines = 1,
								overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
						}
						Spacer(Modifier.width(4.dp))
						StatusPill(status.text, status.tone)
					}
					if (last || final != null || detailLine.isNotEmpty()) {
						Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
							if (last) StatusPill("LAST", BoardFormat.Tone.DANGER)
							final?.let { StatusPill(it, BoardFormat.Tone.WARNING) }
							if (detailLine.isNotEmpty()) {
								Text(detailLine, style = FerryText.caption, color = ferryColors.muted, maxLines = 3, overflow = TextOverflow.Ellipsis,
									modifier = Modifier.weight(1f, fill = false))
							}
						}
					}
				}
			}
		}
	}
}

/** Working number and vessel: confirmed, predicted with a question mark, or the crew boats. */
@Composable
private fun vesselText(row: ScheduledDeparture, shortName: String?): AnnotatedString? {
	val departure = row.departure
	val working = BoardFormat.working(departure, shortName)
	val crew = departure.crewBoats.orEmpty()
	if (working == null && row.boatName == null && row.predictedBoatName == null && crew.isEmpty()) return null
	return buildAnnotatedString {
		working?.let { withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(it) } }
		val name = when {
			row.boatName != null -> AnnotatedString(row.boatName.orEmpty())
			row.predictedBoatName != null -> buildAnnotatedString { withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(row.predictedBoatName + "?") } }
			crew.isNotEmpty() -> AnnotatedString(crew.joinToString(" "))
			else -> null
		}
		if (name != null) {
			if (working != null) append(" ")
			append(name)
		}
	}
}

/** A route's next departures under one heading; a shorter group beside a longer one ends early. */
@Composable
internal fun RouteGroupCard(group: DepartureGroup, context: BoardContext, ui: FerryUi, modifier: Modifier = Modifier) {
	val route = context.schedule?.routes?.get(group.routeId)
	Column(modifier) {
		Row(
			verticalAlignment = Alignment.CenterVertically,
			horizontalArrangement = Arrangement.spacedBy(8.dp),
			modifier = Modifier
				.fillMaxWidth()
				.background(ferryColors.accent.copy(alpha = 0.1f))
				.semantics(mergeDescendants = true) { heading() }
				.padding(horizontal = 12.dp, vertical = 6.dp),
		) {
			RouteBadge(group.routeId, group.variant, route, FilterLogic.operatorName(group.routeId, context.schedule))
			Text(group.destination, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = ferryColors.heading, maxLines = 2,
				overflow = TextOverflow.Ellipsis)
		}
		group.departures.forEachIndexed { index, row ->
			DepartureRow(row, context, showRoute = false, onOpen = { ui.send(nyc.juliet.ferrykitty.contract.FerryAction.OpenTrip(it)) })
			if (index < group.departures.lastIndex) HorizontalDivider(Modifier.padding(start = 12.dp), thickness = 0.5.dp, color = ferryColors.line)
		}
	}
}
