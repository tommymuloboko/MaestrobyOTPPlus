package com.maestro.attendant.util

import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.floor

const val OTP_LENGTH = 6
const val PIN_LENGTH = 4

object Pin {
    /** Keeps digits only and caps the length at 4. */
    fun sanitize(input: String): String = input.filter { it in '0'..'9' }.take(PIN_LENGTH)

    fun isValid(pin: String): Boolean = pin.length == PIN_LENGTH && pin.all { it in '0'..'9' }
}

object Otp {
    /** Keeps digits only and caps the length, so pasted or typed input is always safe. */
    fun sanitize(input: String): String = input.filter { it in '0'..'9' }.take(OTP_LENGTH)

    fun isComplete(otp: String): Boolean = otp.length == OTP_LENGTH && otp.all { it in '0'..'9' }
}

object Litres {
    /** Parses a user-entered litres value ("45", "45.5" or "45,5"); null when not a positive number. */
    fun parse(text: String): Double? =
        text.trim().replace(',', '.').toDoubleOrNull()?.takeIf { it > 0 && it.isFinite() }

    /** Limits the typed text to digits with one decimal separator and at most two decimals. */
    fun sanitize(text: String): String {
        val cleaned = text.replace(',', '.').filter { it.isDigit() || it == '.' }
        val dot = cleaned.indexOf('.')
        if (dot < 0) return cleaned.take(7)
        val whole = cleaned.substring(0, dot).take(7)
        val frac = cleaned.substring(dot + 1).filter { it.isDigit() }.take(2)
        return "$whole.$frac"
    }

    fun isWithinMax(litres: Double, max: Double): Boolean = litres > 0 && litres <= max + 1e-9

    /** Clamps a litres value into [0, max], rounded down to 2 decimals so it never exceeds the limit. */
    fun clamp(litres: Double, max: Double): Double =
        floor(litres.coerceIn(0.0, max) * 100 + 1e-9) / 100

    fun format(value: Double): String = String.format(Locale.US, "%.2f", value).trimEnd('0').trimEnd('.')
}

private val displayFormat = DateTimeFormatter.ofPattern("dd MMM yyyy, HH:mm", Locale.getDefault())

private fun parseInstant(iso: String): Instant? {
    if (iso.isBlank()) return null
    return try {
        OffsetDateTime.parse(iso).toInstant()
    } catch (e: Exception) {
        try {
            LocalDateTime.parse(iso).atZone(ZoneId.of("UTC")).toInstant()
        } catch (e2: Exception) {
            null
        }
    }
}

fun isExpired(iso: String, now: Instant = Instant.now()): Boolean {
    val at = parseInstant(iso) ?: return false
    return !at.isAfter(now)
}

fun formatDateTime(iso: String): String =
    parseInstant(iso)?.let { displayFormat.format(it.atZone(ZoneId.systemDefault())) } ?: iso

fun formatMoney(value: Double): String = String.format(Locale.US, "%,.2f", value)
