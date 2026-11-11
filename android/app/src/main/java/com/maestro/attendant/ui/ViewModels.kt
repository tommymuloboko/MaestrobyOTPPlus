package com.maestro.attendant.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.maestro.attendant.data.ApiException
import com.maestro.attendant.data.Authorization
import com.maestro.attendant.data.FuelTransaction
import com.maestro.attendant.data.Receipt
import com.maestro.attendant.data.Repository
import com.maestro.attendant.util.Litres
import com.maestro.attendant.util.Otp
import com.maestro.attendant.util.Pin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class LoginUiState(
    val email: String = "",
    val password: String = "",
    val loading: Boolean = false,
    val error: String? = null,
) {
    val canSubmit get() = email.isNotBlank() && password.isNotEmpty() && !loading
}

class LoginViewModel(private val repo: Repository) : ViewModel() {
    private val _state = MutableStateFlow(LoginUiState())
    val state: StateFlow<LoginUiState> = _state

    fun onEmail(v: String) = _state.update { it.copy(email = v, error = null) }
    fun onPassword(v: String) = _state.update { it.copy(password = v, error = null) }

    fun submit() {
        val s = _state.value
        if (!s.canSubmit) return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            repo.login(s.email, s.password)
                .onSuccess { _state.update { it.copy(loading = false, password = "") } }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.message) } }
        }
    }
}

enum class DispenseStep { ENTER_OTP, DETAILS, RECEIPT }

data class DispenseUiState(
    val step: DispenseStep = DispenseStep.ENTER_OTP,
    val otp: String = "",
    val pin: String = "",
    val locked: Boolean = false,
    val authorization: Authorization? = null,
    val litresText: String = "",
    val loading: Boolean = false,
    val error: String? = null,
    val receipt: Receipt? = null,
) {
    val canValidate get() = Otp.isComplete(otp) && Pin.isValid(pin) && !loading && !locked
    val litres get() = Litres.parse(litresText)
    val canComplete: Boolean
        get() {
            val max = authorization?.maxVolumeLitres ?: return false
            val l = litres ?: return false
            return Litres.isWithinMax(l, max) && Pin.isValid(pin) && !loading
        }
}

/** Codes where the server rejected the code or PIN: the PIN is wiped and never auto-retried. */
private val REJECTION_CODES = setOf(403, 404, 409, 429)

class DispenseViewModel(private val repo: Repository) : ViewModel() {
    private val _state = MutableStateFlow(DispenseUiState())
    val state: StateFlow<DispenseUiState> = _state

    init {
        // The PIN lives in memory only; drop everything when the session ends (sign-out or expiry).
        viewModelScope.launch {
            repo.session.collect { if (it == null) _state.value = DispenseUiState() }
        }
    }

    fun onOtp(v: String) = _state.update { it.copy(otp = Otp.sanitize(v), error = null, locked = false) }

    fun onPin(v: String) = _state.update { it.copy(pin = Pin.sanitize(v), error = null) }

    fun validate() {
        val s = _state.value
        if (!s.canValidate) return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            repo.validate(s.otp, s.pin)
                .onSuccess { a ->
                    _state.update {
                        it.copy(
                            loading = false, step = DispenseStep.DETAILS, authorization = a,
                            litresText = Litres.format(a.maxVolumeLitres),
                        )
                    }
                }
                .onFailure { e ->
                    val code = (e as? ApiException)?.code
                    _state.update {
                        it.copy(
                            loading = false, error = e.message,
                            pin = if (code in REJECTION_CODES) "" else it.pin,
                            otp = if (code == 429) "" else it.otp,
                            locked = code == 429,
                        )
                    }
                }
        }
    }

    /** Blocks entering more than the authorized maximum by capping the field at the max. */
    fun onLitres(v: String) {
        val max = _state.value.authorization?.maxVolumeLitres ?: return
        var text = Litres.sanitize(v)
        val parsed = text.toDoubleOrNull()
        if (parsed != null && parsed > max) text = Litres.format(max)
        _state.update { it.copy(litresText = text, error = null) }
    }

    fun complete() {
        val s = _state.value
        val auth = s.authorization ?: return
        val litres = s.litres ?: return
        if (!s.canComplete) return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            repo.complete(s.otp, s.pin, Litres.clamp(litres, auth.maxVolumeLitres))
                .onSuccess { tx: FuelTransaction ->
                    // Prefer the server receipt (receipt and order numbers); fall back to the local data.
                    val receipt = repo.receipt(tx.id).fold(
                        onSuccess = { Receipt.fromServer(it, auth.fuelProduct) },
                        onFailure = { Receipt.fromTransaction(auth.orderNumber, auth.fuelProduct, tx) },
                    )
                    _state.value = DispenseUiState(step = DispenseStep.RECEIPT, receipt = receipt)
                }
                .onFailure { e ->
                    val code = (e as? ApiException)?.code
                    _state.update {
                        when (code) {
                            // Wrong PIN or lockout: back to the first screen, PIN wiped, no automatic retry.
                            403, 429 -> DispenseUiState(
                                otp = if (code == 429) "" else it.otp, error = e.message, locked = code == 429,
                            )
                            else -> it.copy(loading = false, error = e.message)
                        }
                    }
                }
        }
    }

    /** Back from the details screen to OTP entry. */
    fun cancelAuthorization() = _state.update { DispenseUiState() }

    fun newDispense() = _state.update { DispenseUiState() }
}

data class HistoryUiState(
    val items: List<FuelTransaction> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
)

class HistoryViewModel(private val repo: Repository) : ViewModel() {
    private val _state = MutableStateFlow(HistoryUiState())
    val state: StateFlow<HistoryUiState> = _state

    fun load() {
        if (_state.value.loading) return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            repo.transactions()
                .onSuccess { list ->
                    _state.update { HistoryUiState(items = list.sortedByDescending { t -> t.dispensedAt }) }
                }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.message) } }
        }
    }
}
