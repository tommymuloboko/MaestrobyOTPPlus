package com.maestro.attendant.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.maestro.attendant.util.isExpired
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

data class Session(val token: String, val name: String, val email: String, val expiresAt: String)

/**
 * Holds the signed-in session in memory and persists it in EncryptedSharedPreferences
 * (Android Keystore-backed). If encrypted storage cannot be opened, the session stays in memory only.
 */
class SessionStore(context: Context) {
    private val prefs: SharedPreferences? = try {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context, "maestro_session", key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (e: Exception) {
        null
    }

    private val _session = MutableStateFlow(load())
    val session: StateFlow<Session?> = _session

    val token: String? get() = _session.value?.token

    fun save(s: Session) {
        _session.value = s
        prefs?.edit()
            ?.putString("token", s.token)?.putString("name", s.name)
            ?.putString("email", s.email)?.putString("expiresAt", s.expiresAt)?.apply()
    }

    fun clear() {
        _session.value = null
        prefs?.edit()?.clear()?.apply()
    }

    private fun load(): Session? {
        val p = prefs ?: return null
        val token = p.getString("token", null) ?: return null
        val expiresAt = p.getString("expiresAt", "") ?: ""
        if (isExpired(expiresAt)) {
            p.edit().clear().apply()
            return null
        }
        return Session(token, p.getString("name", "") ?: "", p.getString("email", "") ?: "", expiresAt)
    }
}
