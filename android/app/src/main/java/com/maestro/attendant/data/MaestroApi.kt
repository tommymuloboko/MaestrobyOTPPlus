package com.maestro.attendant.data

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

interface MaestroApi {
    @POST("auth/login")
    suspend fun login(@Body body: LoginRequest): LoginResponse

    @POST("dispense/validate")
    suspend fun validate(@Body body: ValidateRequest): Authorization

    @POST("dispense/complete")
    suspend fun complete(@Body body: CompleteRequest): FuelTransaction

    @GET("dispense/transactions")
    suspend fun transactions(): List<FuelTransaction>

    @GET("dispense/transactions/{id}/receipt")
    suspend fun receipt(@Path("id") id: String): ServerReceipt
}
