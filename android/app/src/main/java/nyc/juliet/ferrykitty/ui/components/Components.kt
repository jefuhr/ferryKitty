package nyc.juliet.ferrykitty.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import nyc.juliet.ferrykitty.R
import nyc.juliet.ferrykitty.core.FerryRoute
import nyc.juliet.ferrykitty.ui.board.BoardFormat
import nyc.juliet.ferrykitty.ui.theme.ColorMath
import nyc.juliet.ferrykitty.ui.theme.FerryText
import nyc.juliet.ferrykitty.ui.theme.ferryColors

/** Material's minimum touch target, used for every row and control. */
val TouchTarget = 48.dp

fun hexColor(hex: String?, fallback: Long): Color = Color(ColorMath.parseHex(hex) ?: fallback)

@Composable
fun toneColor(tone: BoardFormat.Tone): Color = when (tone) {
	BoardFormat.Tone.POSITIVE -> ferryColors.positive
	BoardFormat.Tone.WARNING -> ferryColors.warning
	BoardFormat.Tone.DANGER -> ferryColors.danger
	BoardFormat.Tone.NEUTRAL -> ferryColors.muted
}

/** A small capsule such as ON TIME, SCHED, LAST or FINAL. Text keeps its color; the tint only groups it. */
@Composable
fun StatusPill(text: String, tone: BoardFormat.Tone, modifier: Modifier = Modifier) {
	val color = toneColor(tone)
	Text(
		text = text,
		style = FerryText.pill,
		color = color,
		maxLines = 1,
		softWrap = false,
		modifier = modifier
			.background(color.copy(alpha = 0.12f), CircleShape)
			.padding(horizontal = 6.dp, vertical = 2.dp),
	)
}

/**
 * A small neutral clock for a departure that runs to the timetable, in a capsule the height of [StatusPill] so rows keep
 * their rhythm. The glyph scales with text size. It says nothing to TalkBack: the row's sentence already says "scheduled".
 */
@Composable
fun ScheduledClock(modifier: Modifier = Modifier) {
	val color = toneColor(BoardFormat.Tone.NEUTRAL)
	val glyph = with(LocalDensity.current) { 14.sp.toDp() }
	Box(contentAlignment = Alignment.Center, modifier = modifier.background(color.copy(alpha = 0.12f), CircleShape).padding(horizontal = 6.dp, vertical = 2.dp)) {
		Icon(Icons.Outlined.Schedule, contentDescription = null, tint = color, modifier = Modifier.size(glyph).testTag("scheduledClock"))
	}
}

/** Partner operators are shown by their own marks, as on iOS and the web board. */
fun partnerMark(partner: BoardFormat.Partner): Int = when (partner) {
	BoardFormat.Partner.WATERWAY -> R.drawable.partner_waterway
	BoardFormat.Partner.SEASTREAK -> R.drawable.partner_seastreak
	BoardFormat.Partner.NYU -> R.drawable.partner_nyu
	BoardFormat.Partner.CITY_FERRY -> R.drawable.partner_cityferry
	BoardFormat.Partner.GOVERNORS_ISLAND -> R.drawable.partner_governors_island
}

/** The route letter in its own colors, or a partner operator's mark on white. */
@Composable
fun RouteBadge(routeId: String, variant: String?, route: FerryRoute?, operatorName: String?, modifier: Modifier = Modifier) {
	val partner = BoardFormat.partner(routeId)
	if (partner != null) {
		Image(
			painter = painterResource(partnerMark(partner)),
			contentDescription = operatorName ?: partner.code,
			contentScale = ContentScale.Fit,
			modifier = modifier
				.size(width = 44.dp, height = 22.dp)
				.background(Color.White, RoundedCornerShape(4.dp))
				.border(0.5.dp, ferryColors.line, RoundedCornerShape(4.dp))
				.padding(2.dp),
		)
	} else {
		val short = route?.shortName ?: routeId
		Box(
			contentAlignment = Alignment.Center,
			modifier = modifier
				.heightIn(min = 22.dp)
				.widthIn(min = 30.dp)
				.background(hexColor(route?.color, 0xFF0078A8), RoundedCornerShape(4.dp))
				.padding(horizontal = 5.dp, vertical = 3.dp),
		) {
			Text(
				text = short + (variant?.let { " $it" } ?: ""),
				style = FerryText.pill.copy(fontWeight = FontWeight.ExtraBold, fontSize = 12.sp),
				color = hexColor(route?.textColor, 0xFFFFFFFF),
				maxLines = 1,
				softWrap = false,
			)
		}
	}
}

/** An empty, offline or error state with a clear next step. */
@Composable
fun MessageCard(title: String, message: String, icon: ImageVector, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
	Column(
		horizontalAlignment = Alignment.CenterHorizontally,
		verticalArrangement = Arrangement.spacedBy(8.dp),
		modifier = modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 28.dp),
	) {
		Icon(icon, contentDescription = null, tint = ferryColors.muted, modifier = Modifier.size(36.dp))
		Text(title, style = MaterialTheme.typography.titleMedium, color = ferryColors.heading, textAlign = TextAlign.Center,
			modifier = Modifier.semantics { heading() })
		Text(message, style = MaterialTheme.typography.bodyMedium, color = ferryColors.muted, textAlign = TextAlign.Center)
		if (action != null) {
			Spacer(Modifier.size(4.dp))
			action()
		}
	}
}

@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier) {
	Text(
		text = text.uppercase(),
		style = FerryText.overline,
		color = ferryColors.muted,
		modifier = modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 6.dp).semantics { heading() },
	)
}

@Composable
fun Footnote(text: String, modifier: Modifier = Modifier) {
	Text(text, style = MaterialTheme.typography.bodySmall, color = ferryColors.muted, modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp))
}

/** A whole-row switch: the row is the touch target and carries the on/off state for TalkBack and tests. */
@Composable
fun SwitchRow(
	title: String,
	checked: Boolean,
	onCheckedChange: (Boolean) -> Unit,
	modifier: Modifier = Modifier,
	subtitle: String? = null,
	enabled: Boolean = true,
	tag: String? = null,
	indent: Int = 0,
	leading: (@Composable RowScope.() -> Unit)? = null,
) {
	Row(
		verticalAlignment = Alignment.CenterVertically,
		modifier = modifier
			.fillMaxWidth()
			.then(if (tag != null) Modifier.testTag(tag) else Modifier)
			.toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange)
			.heightIn(min = TouchTarget)
			.padding(start = 16.dp + (indent * 28).dp, end = 16.dp, top = 4.dp, bottom = 4.dp),
	) {
		leading?.invoke(this)
		Column(Modifier.weight(1f).padding(end = 12.dp)) {
			Text(title, style = MaterialTheme.typography.bodyLarge, color = if (enabled) ferryColors.ink else ferryColors.muted)
			if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = ferryColors.muted)
		}
		Switch(checked = checked, onCheckedChange = null, enabled = enabled)
	}
}

/** A setting with a few fixed choices, shown as its current value and opened as a menu. */
@Composable
fun <T> ChoiceRow(
	title: String,
	options: List<Pair<T, String>>,
	selected: T,
	onSelect: (T) -> Unit,
	modifier: Modifier = Modifier,
	tag: String? = null,
	enabled: Boolean = true,
) {
	var open by remember { mutableStateOf(false) }
	val current = options.firstOrNull { it.first == selected }?.second ?: options.firstOrNull()?.second.orEmpty()
	Box(modifier.fillMaxWidth()) {
		Row(
			verticalAlignment = Alignment.CenterVertically,
			modifier = Modifier
				.fillMaxWidth()
				.then(if (tag != null) Modifier.testTag(tag) else Modifier)
				.clickable(enabled = enabled, role = Role.DropdownList, onClickLabel = "Change $title") { open = true }
				.heightIn(min = TouchTarget)
				.padding(horizontal = 16.dp, vertical = 6.dp)
				.semantics { stateDescription = current },
		) {
			Text(title, style = MaterialTheme.typography.bodyLarge, color = ferryColors.ink, modifier = Modifier.weight(1f).padding(end = 12.dp))
			Text(current, style = MaterialTheme.typography.bodyMedium, color = ferryColors.accent, textAlign = TextAlign.End,
				modifier = Modifier.widthIn(max = 220.dp))
		}
		DropdownMenu(expanded = open, onDismissRequest = { open = false }, modifier = Modifier.align(Alignment.TopEnd)) {
			for ((value, label) in options) {
				DropdownMenuItem(
					text = { Text(label) },
					onClick = { open = false; onSelect(value) },
					leadingIcon = {
						if (value == selected) Icon(Icons.Filled.Check, contentDescription = "Selected") else Spacer(Modifier.width(24.dp))
					},
					modifier = if (tag != null) Modifier.testTag("$tag-$value") else Modifier,
				)
			}
		}
	}
}

/** A row that opens another page or performs one action. */
@Composable
fun NavigationRow(
	title: String,
	modifier: Modifier = Modifier,
	value: String? = null,
	icon: ImageVector? = null,
	tag: String? = null,
	enabled: Boolean = true,
	chevron: Boolean = true,
	tint: Color = Color.Unspecified,
	onClick: () -> Unit,
) {
	val color = if (tint == Color.Unspecified) ferryColors.ink else tint
	Row(
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(12.dp),
		modifier = modifier
			.fillMaxWidth()
			.then(if (tag != null) Modifier.testTag(tag) else Modifier)
			.clickable(enabled = enabled, role = Role.Button, onClick = onClick)
			.heightIn(min = TouchTarget)
			.padding(horizontal = 16.dp, vertical = 6.dp),
	) {
		if (icon != null) Icon(icon, contentDescription = null, tint = if (enabled) color else ferryColors.muted, modifier = Modifier.size(20.dp))
		Text(title, style = MaterialTheme.typography.bodyLarge, color = if (enabled) color else ferryColors.muted, modifier = Modifier.weight(1f))
		if (value != null) Text(value, style = MaterialTheme.typography.bodyMedium, color = ferryColors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
			modifier = Modifier.widthIn(max = 200.dp))
		if (chevron) Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = ferryColors.muted, modifier = Modifier.size(20.dp))
	}
}

@Composable
fun RowDivider(modifier: Modifier = Modifier, start: Int = 16) {
	HorizontalDivider(modifier.padding(start = start.dp), thickness = 0.5.dp, color = ferryColors.line)
}

/** A compact search box with a clear button; IME search hides the keyboard. */
@Composable
fun SearchField(
	value: String,
	onValueChange: (String) -> Unit,
	placeholder: String,
	modifier: Modifier = Modifier,
	tag: String? = null,
	focusManager: FocusManager = LocalFocusManager.current,
) {
	OutlinedTextField(
		value = value,
		onValueChange = onValueChange,
		singleLine = true,
		placeholder = { Text(placeholder, maxLines = 1, overflow = TextOverflow.Ellipsis) },
		leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
		trailingIcon = {
			if (value.isNotEmpty()) IconButton(onClick = { onValueChange("") }) { Icon(Icons.Filled.Clear, contentDescription = "Clear search") }
		},
		keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
		keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
		shape = RoundedCornerShape(12.dp),
		colors = OutlinedTextFieldDefaults.colors(
			focusedContainerColor = ferryColors.card,
			unfocusedContainerColor = ferryColors.card,
			unfocusedBorderColor = ferryColors.line,
		),
		modifier = modifier.fillMaxWidth().then(if (tag != null) Modifier.testTag(tag) else Modifier),
	)
}

/** A one-line board notice with an icon, such as saved data or a location problem. */
@Composable
fun Notice(text: String, icon: ImageVector, modifier: Modifier = Modifier, color: Color = Color.Unspecified) {
	val tint = if (color == Color.Unspecified) ferryColors.muted else color
	Row(
		verticalAlignment = Alignment.Top,
		horizontalArrangement = Arrangement.spacedBy(6.dp),
		modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 3.dp),
	) {
		Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.padding(top = 1.dp).size(14.dp))
		CompositionLocalProvider(LocalContentColor provides tint) {
			Text(text, style = FerryText.caption, color = tint)
		}
	}
}
