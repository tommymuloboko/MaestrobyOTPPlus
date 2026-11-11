package com.maestro.attendant

import com.maestro.attendant.data.CompleteRequest
import com.maestro.attendant.data.ErrorParser
import com.maestro.attendant.data.FuelTransaction
import com.maestro.attendant.data.Receipt
import com.maestro.attendant.data.ServerReceipt
import com.maestro.attendant.data.ValidateRequest
import com.maestro.attendant.util.Litres
import com.maestro.attendant.util.Otp
import com.maestro.attendant.util.Pin
import com.maestro.attendant.util.ReceiptText
import com.maestro.attendant.util.isExpired
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class OtpTest {
    @Test fun sanitizeKeepsDigitsAndCapsAtSix() {
        assertEquals("123456", Otp.sanitize("12a3-45 6789"))
        assertEquals("", Otp.sanitize("abc"))
    }

    @Test fun completeOnlyForSixDigits() {
        assertTrue(Otp.isComplete("123456"))
        assertFalse(Otp.isComplete("12345"))
        assertFalse(Otp.isComplete("12345a"))
    }
}

class LitresTest {
    @Test fun parseAcceptsCommaAndRejectsInvalid() {
        assertEquals(45.5, Litres.parse("45,5")!!, 0.0)
        assertNull(Litres.parse(""))
        assertNull(Litres.parse("0"))
        assertNull(Litres.parse("-3"))
        assertNull(Litres.parse("abc"))
    }

    @Test fun sanitizeLimitsDecimals() {
        assertEquals("12.34", Litres.sanitize("12,345"))
        assertEquals("1.5", Litres.sanitize("1..5x"))
    }

    @Test fun clampNeverExceedsMax() {
        assertEquals(50.0, Litres.clamp(80.0, 50.0), 0.0)
        assertEquals(12.34, Litres.clamp(12.349, 50.0), 0.0)
        assertTrue(Litres.isWithinMax(50.0, 50.0))
        assertFalse(Litres.isWithinMax(50.01, 50.0))
        assertFalse(Litres.isWithinMax(0.0, 50.0))
    }

    @Test fun formatTrimsTrailingZeros() {
        assertEquals("50", Litres.format(50.0))
        assertEquals("45.5", Litres.format(45.5))
    }
}

class PinTest {
    @Test fun sanitizeKeepsFourDigitsOnly() {
        assertEquals("1234", Pin.sanitize("12a3-45"))
        assertEquals("", Pin.sanitize("abcd"))
    }

    @Test fun validOnlyForExactlyFourDigits() {
        assertTrue(Pin.isValid("0123"))
        assertFalse(Pin.isValid("123"))
        assertFalse(Pin.isValid("12345"))
        assertFalse(Pin.isValid("12a4"))
        assertFalse(Pin.isValid(""))
    }
}

class ErrorParserTest {
    @Test fun usesProblemJsonDetail() {
        val body = """{"type":"about:blank","title":"Conflict","status":409,"detail":"OTP already redeemed"}"""
        assertEquals("OTP already redeemed", ErrorParser.message(409, body))
    }

    @Test fun showsPinAttemptsAndRevocationDetails() {
        assertEquals(
            "Driver PIN is incorrect (2 attempts left)",
            ErrorParser.message(403, """{"detail":"Driver PIN is incorrect (2 attempts left)"}"""),
        )
        assertEquals(
            "PIN wrong 3 times. This fuel code has been revoked.",
            ErrorParser.message(403, """{"detail":"PIN wrong 3 times. This fuel code has been revoked."}"""),
        )
        assertEquals(
            "Too many wrong codes. Try again later.",
            ErrorParser.message(429, """{"detail":"Too many wrong codes. Try again later."}"""),
        )
    }

    @Test fun fallsBackWhenBodyMissingOrNotJson() {
        assertEquals("Session expired. Please sign in again.", ErrorParser.message(401, null))
        assertEquals("Too many attempts. Please wait and try again.", ErrorParser.message(429, "<html>"))
        assertEquals("Request failed (418).", ErrorParser.message(418, ""))
    }
}

class SessionAndReceiptTest {
    @Test fun expiryComparesAgainstNow() {
        val now = Instant.parse("2026-01-01T12:00:00Z")
        assertTrue(isExpired("2026-01-01T11:59:59Z", now))
        assertFalse(isExpired("2026-01-01T12:00:01+00:00", now))
        assertFalse(isExpired("not a date", now))
    }

    @Test fun receiptTextContainsKeyFields() {
        val tx = FuelTransaction(
            id = "1", siteName = "Mainline", vehicleReg = "ABC 123", driverName = "Sam",
            attendantName = "Alex", volumeLitres = 45.5, unitPrice = 1.5, amount = 68.25,
        )
        val text = ReceiptText.build(Receipt.fromTransaction("ORD-1", "Diesel", tx))
        assertTrue(text.contains("Order: ORD-1"))
        assertTrue(text.contains("Volume: 45.5 L"))
        assertTrue(text.contains("Amount: 68.25"))
        assertFalse(text.contains("Receipt:"))
    }

    @Test fun serverReceiptCarriesReceiptAndOrderNumbers() {
        val server = ServerReceipt(receiptNo = "RCP-0001", orderNumber = "FO-77", litres = 10.0, attendantName = "Alex")
        val r = Receipt.fromServer(server, "Diesel")
        assertEquals("RCP-0001", r.receiptNo)
        assertEquals("FO-77", r.orderNumber)
        assertEquals("Diesel", r.product)
        assertTrue(ReceiptText.build(r).contains("Receipt: RCP-0001"))
    }

    @Test fun requestsSerializeWithPinAndNoAttendantName() {
        val json = Json.encodeToString(CompleteRequest("123456", "1234", 20.0))
        assertTrue(json.contains("\"driverPin\":\"1234\""))
        assertFalse(json.contains("attendantName"))
        assertTrue(Json.encodeToString(ValidateRequest("123456", "1234")).contains("\"driverPin\":\"1234\""))
    }
}
