package com.maestro.attendant.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp

val MaestroGreen = Color(0xFF2DB94D)
val MaestroGreenDark = Color(0xFF1F8F39)
val MaestroGreenSoft = Color(0xFFE8F7EC)
val SurfaceGrey = Color(0xFFF5F7F6)
val InkDark = Color(0xFF14231A)
val InkMuted = Color(0xFF6B7A70)

private val colors = lightColorScheme(
    primary = MaestroGreen,
    onPrimary = Color.White,
    primaryContainer = MaestroGreenSoft,
    onPrimaryContainer = MaestroGreenDark,
    background = SurfaceGrey,
    onBackground = InkDark,
    surface = Color.White,
    onSurface = InkDark,
    onSurfaceVariant = InkMuted,
    surfaceVariant = MaestroGreenSoft,
    outline = Color(0xFFD5DDD8),
    error = Color(0xFFD93025),
)

private val shapes = Shapes(
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(20.dp),
)

@Composable
fun MaestroTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = colors, shapes = shapes, content = content)
}
