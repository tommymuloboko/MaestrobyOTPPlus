package com.maestro.attendant.data

import kotlinx.serialization.Serializable

@Serializable
data class LoginRequest(val email: String, val password: String)

@Serializable
data class LoginResponse(
    val token: String,
    val email: String = "",
    val name: String = "",
    val role: String = "",
    val organization: String = "",
    val expiresAt: String = "",
)

@Serializable
data class ValidateRequest(val otp: String, val driverPin: String)

@Serializable
data class Authorization(
    val authorizationId: String,
    val orderNumber: String = "",
    val driverName: String = "",
    val vehicleReg: String = "",
    val siteName: String = "",
    val fuelProduct: String = "",
    val maxVolumeLitres: Double = 0.0,
    val expiresAt: String = "",
)

@Serializable
data class CompleteRequest(val otp: String, val driverPin: String, val volumeLitres: Double)

@Serializable
data class FuelTransaction(
    val id: String,
    val orderId: String = "",
    val siteName: String = "",
    val vehicleReg: String = "",
    val driverName: String = "",
    val attendantName: String = "",
    val volumeLitres: Double = 0.0,
    val unitPrice: Double = 0.0,
    val amount: Double = 0.0,
    val dispensedAt: String = "",
)

@Serializable
data class ServerReceipt(
    val receiptNo: String = "",
    val orderNumber: String = "",
    val siteName: String = "",
    val vehicleReg: String = "",
    val driverName: String = "",
    val attendantName: String = "",
    val litres: Double = 0.0,
    val unitPrice: Double = 0.0,
    val amount: Double = 0.0,
    val at: String = "",
)

/** Receipt shown after a dispense; [receiptNo] is blank when built from the local fallback. */
data class Receipt(
    val receiptNo: String,
    val orderNumber: String,
    val product: String,
    val siteName: String,
    val vehicleReg: String,
    val driverName: String,
    val attendantName: String,
    val litres: Double,
    val unitPrice: Double,
    val amount: Double,
    val at: String,
) {
    companion object {
        fun fromServer(r: ServerReceipt, product: String) = Receipt(
            r.receiptNo, r.orderNumber, product, r.siteName, r.vehicleReg, r.driverName,
            r.attendantName, r.litres, r.unitPrice, r.amount, r.at,
        )

        /** Fallback used when the server receipt cannot be fetched. */
        fun fromTransaction(orderNumber: String, product: String, t: FuelTransaction) = Receipt(
            "", orderNumber, product, t.siteName, t.vehicleReg, t.driverName,
            t.attendantName, t.volumeLitres, t.unitPrice, t.amount, t.dispensedAt,
        )
    }
}
