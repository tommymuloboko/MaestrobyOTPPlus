package com.maestro.attendant.ui

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.maestro.attendant.data.Authorization
import com.maestro.attendant.data.Receipt
import com.maestro.attendant.util.Litres
import com.maestro.attendant.util.OTP_LENGTH
import com.maestro.attendant.util.Otp
import com.maestro.attendant.util.PIN_LENGTH
import com.maestro.attendant.util.ReceiptText
import com.maestro.attendant.util.formatDateTime
import com.maestro.attendant.util.formatMoney

@Composable
fun DispenseScreen(vm: DispenseViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        when (state.step) {
            DispenseStep.ENTER_OTP -> OtpStep(state, vm)
            DispenseStep.DETAILS -> DetailsStep(state, vm)
            DispenseStep.RECEIPT -> state.receipt?.let { ReceiptStep(it, vm::newDispense) }
        }
    }
}

@Composable
private fun OtpStep(state: DispenseUiState, vm: DispenseViewModel) {
    val focusManager = LocalFocusManager.current
    ScreenTitle("Validate fuel code", "Enter the 6-digit code and the driver's 4-digit PIN.")
    Text("Fuel code (OTP)", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Spacer(Modifier.height(6.dp))
    DigitField(
        value = state.otp,
        length = OTP_LENGTH,
        onChange = {
            vm.onOtp(it)
            if (Otp.isComplete(Otp.sanitize(it))) focusManager.moveFocus(FocusDirection.Next)
        },
        enabled = !state.loading,
        autoFocus = true,
    )
    Spacer(Modifier.height(16.dp))
    Text("Driver PIN", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Spacer(Modifier.height(6.dp))
    DigitField(
        value = state.pin,
        length = PIN_LENGTH,
        onChange = vm::onPin,
        enabled = !state.loading,
        masked = true,
        modifier = Modifier.fillMaxWidth(0.67f),
    )
    if (state.error != null) {
        Spacer(Modifier.height(12.dp))
        ErrorText(state.error)
    }
    Spacer(Modifier.height(24.dp))
    PrimaryButton("Validate", enabled = state.canValidate, loading = state.loading, onClick = vm::validate)
}

@Composable
private fun DetailsStep(state: DispenseUiState, vm: DispenseViewModel) {
    val auth = state.authorization ?: return
    BackHandler(enabled = !state.loading) { vm.cancelAuthorization() }
    ScreenTitle("Authorized dispense", "Confirm the details, then dispense up to the approved limit.")
    AuthorizationCard(auth)
    Spacer(Modifier.height(16.dp))

    val over = state.litres?.let { it > auth.maxVolumeLitres } == true
    OutlinedTextField(
        value = state.litresText,
        onValueChange = vm::onLitres,
        label = { Text("Litres dispensed") },
        supportingText = { Text("Maximum ${Litres.format(auth.maxVolumeLitres)} L") },
        isError = over,
        singleLine = true,
        enabled = !state.loading,
        suffix = { Text("L") },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { vm.complete() }),
        modifier = Modifier.fillMaxWidth(),
    )
    if (state.error != null) {
        Spacer(Modifier.height(8.dp))
        ErrorText(state.error)
    }
    Spacer(Modifier.height(20.dp))
    PrimaryButton("Complete dispense", enabled = state.canComplete, loading = state.loading, onClick = vm::complete)
    TextButton(onClick = vm::cancelAuthorization, enabled = !state.loading, modifier = Modifier.fillMaxWidth()) {
        Text("Cancel")
    }
}

@Composable
private fun AuthorizationCard(a: Authorization) {
    SectionCard {
        DetailRow("Order", a.orderNumber)
        DetailRow("Driver", a.driverName)
        DetailRow("Vehicle", a.vehicleReg)
        DetailRow("Product", a.fuelProduct)
        DetailRow("Site", a.siteName)
        DetailRow("Max litres", "${Litres.format(a.maxVolumeLitres)} L", bold = true)
        DetailRow("Expires", formatDateTime(a.expiresAt))
    }
}

@Composable
private fun ReceiptStep(receipt: Receipt, onNew: () -> Unit) {
    val context = LocalContext.current
    ScreenTitle("Dispense complete", "Hand the receipt to the driver.")
    SectionCard {
        Text("RECEIPT", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        if (receipt.receiptNo.isNotBlank()) DetailRow("Receipt no.", receipt.receiptNo, bold = true)
        DetailRow("Order", receipt.orderNumber)
        DetailRow("Site", receipt.siteName)
        DetailRow("Vehicle", receipt.vehicleReg)
        DetailRow("Driver", receipt.driverName)
        if (receipt.product.isNotBlank()) DetailRow("Product", receipt.product)
        HorizontalDivider(Modifier.padding(vertical = 6.dp))
        DetailRow("Litres", "${Litres.format(receipt.litres)} L", bold = true)
        DetailRow("Unit price", formatMoney(receipt.unitPrice))
        DetailRow("Amount", formatMoney(receipt.amount), bold = true)
        HorizontalDivider(Modifier.padding(vertical = 6.dp))
        DetailRow("Attendant", receipt.attendantName)
        DetailRow("Time", formatDateTime(receipt.at))
    }
    Spacer(Modifier.height(20.dp))
    PrimaryButton("New dispense", enabled = true, loading = false, onClick = onNew)
    Spacer(Modifier.height(8.dp))
    OutlinedButton(
        onClick = {
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, ReceiptText.build(receipt))
            }
            context.startActivity(Intent.createChooser(send, "Share receipt"))
        },
        modifier = Modifier.fillMaxWidth().height(52.dp),
        shape = MaterialTheme.shapes.medium,
    ) {
        Icon(Icons.Default.Share, contentDescription = null)
        Text("  Share receipt")
    }
}

@Composable
fun SectionCard(content: @Composable () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = Color.White),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) {
        Column(Modifier.padding(horizontal = 18.dp, vertical = 14.dp)) { content() }
    }
}
