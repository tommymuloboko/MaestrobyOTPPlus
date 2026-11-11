package com.maestro.attendant

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.maestro.attendant.ui.LoginScreen
import com.maestro.attendant.ui.LoginViewModel
import com.maestro.attendant.ui.MainScreen
import com.maestro.attendant.ui.theme.MaestroTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as MaestroApp
        setContent {
            MaestroTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    val session by app.sessionStore.session.collectAsStateWithLifecycle()
                    val current = session
                    if (current == null) {
                        val vm: LoginViewModel = viewModel(
                            factory = viewModelFactory { initializer { LoginViewModel(app.repository) } },
                        )
                        LoginScreen(vm)
                    } else {
                        // Keyed by token so a new sign-in always starts with fresh screen state.
                        MainScreen(app.repository, current, key = current.token)
                    }
                }
            }
        }
    }
}
