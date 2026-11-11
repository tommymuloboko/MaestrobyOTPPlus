package com.maestro.attendant.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.maestro.attendant.data.FuelTransaction
import com.maestro.attendant.util.Litres
import com.maestro.attendant.util.formatDateTime
import com.maestro.attendant.util.formatMoney

@Composable
fun HistoryScreen(vm: HistoryViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.load() }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            ScreenTitle("Recent dispenses")
            TextButton(onClick = vm::load, enabled = !state.loading) { Text("Refresh") }
        }
        ErrorText(state.error, Modifier.padding(bottom = 8.dp))
        when {
            state.loading && state.items.isEmpty() ->
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            state.items.isEmpty() && state.error == null ->
                Text("No transactions yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(state.items, key = { it.id }) { TransactionRow(it) }
            }
        }
    }
}

@Composable
private fun TransactionRow(t: FuelTransaction) {
    SectionCard {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(t.vehicleReg, fontWeight = FontWeight.Bold)
            Text("${Litres.format(t.volumeLitres)} L", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
        }
        Text("${t.driverName} - ${t.siteName}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(formatDateTime(t.dispensedAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(formatMoney(t.amount), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
        }
    }
}
