package com.maestro.attendant

import android.app.Application
import com.maestro.attendant.data.Repository
import com.maestro.attendant.data.SessionStore

class MaestroApp : Application() {
    val sessionStore by lazy { SessionStore(this) }
    val repository by lazy { Repository(sessionStore) }
}
