package com.maestro.attendant.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class ApiException(message: String, val code: Int? = null) : Exception(message)

object ErrorParser {
    /** Extracts the problem+json `detail`, falling back to a readable message for the status code. */
    fun message(code: Int, body: String?): String {
        val detail = try {
            if (body.isNullOrBlank()) null
            else Json.parseToJsonElement(body).jsonObject["detail"]?.jsonPrimitive?.contentOrNull
        } catch (e: Exception) {
            null
        }
        if (!detail.isNullOrBlank()) return detail
        return when (code) {
            401 -> "Session expired. Please sign in again."
            403 -> "You are not allowed to do this."
            404 -> "Not found."
            409 -> "This request conflicts with the current state."
            429 -> "Too many attempts. Please wait and try again."
            in 500..599 -> "Server error. Please try again later."
            else -> "Request failed ($code)."
        }
    }
}
