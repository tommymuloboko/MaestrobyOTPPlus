package com.maestro.attendant.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.maestro.attendant.data.Repository
import com.maestro.attendant.data.Session
import com.maestro.attendant.ui.theme.MaestroGreenSoft

@Composable
fun MainScreen(repo: Repository, session: Session, key: String) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val dispenseVm: DispenseViewModel = viewModel(
        key = "dispense-$key",
        factory = viewModelFactory { initializer { DispenseViewModel(repo) } },
    )
    val historyVm: HistoryViewModel = viewModel(
        key = "history-$key",
        factory = viewModelFactory { initializer { HistoryViewModel(repo) } },
    )

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar(containerColor = Color.White) {
                val colors = NavigationBarItemDefaults.colors(indicatorColor = MaestroGreenSoft)
                NavigationBarItem(
                    selected = tab == 0, onClick = { tab = 0 }, colors = colors,
                    icon = { Icon(Icons.Default.Add, contentDescription = null) }, label = { Text("Dispense") },
                )
                NavigationBarItem(
                    selected = tab == 1, onClick = { tab = 1 }, colors = colors,
                    icon = { Icon(Icons.AutoMirrored.Filled.List, contentDescription = null) }, label = { Text("History") },
                )
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding)) {
            AppHeader(session.name, onSignOut = repo::logout)
            Column(Modifier.weight(1f).padding(horizontal = 20.dp, vertical = 12.dp)) {
                if (tab == 0) DispenseScreen(dispenseVm) else HistoryScreen(historyVm)
            }
        }
    }
}
