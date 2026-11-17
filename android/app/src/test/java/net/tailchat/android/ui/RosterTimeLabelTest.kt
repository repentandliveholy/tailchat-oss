package net.tailchat.android.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.util.Date
import java.util.Locale

/**
 * The roster's right-hand stamp is a *distance* rather than a clock: a
 * conversation last touched weeks ago has no useful time of day, and the row
 * has room for one short line. This pins the ladder — the clock today,
 * «вчера», the weekday while it is still a day somebody remembers, then a
 * short date, with the year only once it is a different one — and the calendar
 * arithmetic underneath it, which counts local dates rather than elapsed hours.
 *
 * Plain JUnit: both functions are pure, and the four strings are handed in
 * already formatted, so no device locale, clock or Compose is involved.
 */
class RosterTimeLabelTest {
    private val stamp = RosterStamp(
        time = "14:05",
        weekday = "пт",
        date = "28 февр.",
        yesterday = "вчера",
    )

    private fun label(daysAgo: Int, sameYear: Boolean = true, yearSuffix: String = "26") =
        rosterTimeLabel(daysAgo, sameYear, yearSuffix, stamp)

    @Test
    fun `today is the clock, and so is a timestamp from a clock running ahead`() {
        assertEquals("14:05", label(0))
        assertEquals("14:05", label(-1))
    }

    @Test
    fun `yesterday is the word, not a time of day nobody thinks in`() {
        assertEquals("вчера", label(1))
    }

    @Test
    fun `inside the last week the day has a name`() {
        assertEquals("пт", label(2))
        assertEquals("пт", label(6))
    }

    @Test
    fun `a week back is a date, and another year says which one`() {
        assertEquals("28 февр.", label(7))
        assertEquals("28 февр. '25", label(400, sameYear = false, yearSuffix = "25"))
    }

    @Test
    fun `a short weekday and a short date, in the locale asked for`() {
        val date = Date(LocalDate.of(2026, 2, 28).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli())

        val (ruWeekday, ruDate) = dayFormats(Locale.forLanguageTag("ru"))
        val (enWeekday, enDate) = dayFormats(Locale.ENGLISH)
        val (frWeekday, frDate) = dayFormats(Locale.FRENCH)

        // Short, not spelled out: a roster row is one line beside a name, and
        // `EEEE`/`MMMM` are exactly what the walk back from that looks like.
        assertEquals("сб", ruWeekday.format(date))
        assertEquals("28 февр.", ruDate.format(date))
        assertEquals("Sat", enWeekday.format(date))
        // English puts the month first, the way the web client's
        // `Intl.DateTimeFormat` does for the same three languages.
        assertEquals("Feb 28", enDate.format(date))
        assertEquals("sam.", frWeekday.format(date))
        assertEquals("28 févr.", frDate.format(date))
    }

    @Test
    fun `an hour before midnight is still yesterday, three days later`() {
        val zone = ZoneId.systemDefault()
        fun at(month: Int, day: Int, hour: Int, minute: Int) = LocalDate.of(2026, month, day)
            .atTime(hour, minute)
            .atZone(zone)
            .toInstant()
            .toEpochMilli()

        // Half past midnight: a message from 23:50 three calendar days ago is
        // three days ago, even though barely sixty hours have passed — which is
        // exactly what a millisecond division would get wrong.
        assertEquals(3, calendarDaysBetween(at(9, 25, 23, 50), at(9, 28, 0, 30)))
        assertEquals(1, calendarDaysBetween(at(9, 27, 0, 10), at(9, 28, 0, 30)))
        assertEquals(0, calendarDaysBetween(at(9, 28, 0, 1), at(9, 28, 23, 59)))
    }
}
