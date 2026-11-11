package com.maestro.attendant.util

import com.maestro.attendant.data.Receipt

object ReceiptText {
    fun build(r: Receipt): String = buildString {
        appendLine("Maestro FuelOrder - Dispense receipt")
        if (r.receiptNo.isNotBlank()) appendLine("Receipt: ${r.receiptNo}")
        appendLine("Order: ${r.orderNumber}")
        appendLine("Site: ${r.siteName}")
        appendLine("Vehicle: ${r.vehicleReg}")
        appendLine("Driver: ${r.driverName}")
        if (r.product.isNotBlank()) appendLine("Product: ${r.product}")
        appendLine("Volume: ${Litres.format(r.litres)} L")
        appendLine("Unit price: ${formatMoney(r.unitPrice)}")
        appendLine("Amount: ${formatMoney(r.amount)}")
        appendLine("Attendant: ${r.attendantName}")
        append("Time: ${formatDateTime(r.at)}")
    }
}
