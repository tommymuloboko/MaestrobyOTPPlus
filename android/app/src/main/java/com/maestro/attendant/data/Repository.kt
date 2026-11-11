package com.maestro.attendant.data

import com.maestro.attendant.BuildConfig
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.io.IOException
import java.util.concurrent.TimeUnit

class Repository(private val store: SessionStore, baseUrl: String = BuildConfig.API_BASE_URL) {

    private val json = Json { ignoreUnknownKeys = true }

    private val api: MaestroApi = Retrofit.Builder()
        .baseUrl(baseUrl)
        .client(
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .addInterceptor { chain ->
                    val token = store.token
                    val isLogin = chain.request().url.encodedPath.endsWith("/auth/login")
                    val request = if (token != null && !isLogin) {
                        chain.request().newBuilder().header("Authorization", "Bearer $token").build()
                    } else chain.request()
                    val response = chain.proceed(request)
                    // A 401 on an authenticated call means the session expired.
                    if (response.code == 401 && token != null && !isLogin) store.clear()
                    response
                }
                .build(),
        )
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()
        .create(MaestroApi::class.java)

    suspend fun login(email: String, password: String): Result<Session> = call {
        val r = api.login(LoginRequest(email.trim(), password))
        Session(r.token, r.name.ifBlank { r.email }, r.email, r.expiresAt).also { store.save(it) }
    }

    suspend fun validate(otp: String, pin: String): Result<Authorization> =
        call { api.validate(ValidateRequest(otp, pin)) }

    suspend fun complete(otp: String, pin: String, litres: Double): Result<FuelTransaction> =
        call { api.complete(CompleteRequest(otp, pin, litres)) }

    suspend fun receipt(transactionId: String): Result<ServerReceipt> = call { api.receipt(transactionId) }

    suspend fun transactions(): Result<List<FuelTransaction>> = call { api.transactions() }

    val session get() = store.session

    fun logout() = store.clear()

    private suspend fun <T> call(block: suspend () -> T): Result<T> = try {
        Result.success(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: HttpException) {
        Result.failure(ApiException(ErrorParser.message(e.code(), e.response()?.errorBody()?.string()), e.code()))
    } catch (e: IOException) {
        Result.failure(ApiException("Cannot reach the server. Check the connection and try again."))
    } catch (e: Exception) {
        Result.failure(ApiException("Unexpected error: ${e.message ?: e.javaClass.simpleName}"))
    }
}
