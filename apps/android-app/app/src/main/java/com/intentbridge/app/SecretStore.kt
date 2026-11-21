package com.intentbridge.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** AES-GCM values wrapped by an Android Keystore key; only aliases leave. */
class SecretStore(context: Context) {
    private val preferences = context.getSharedPreferences("intentbridge-secrets", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    fun set(alias: String, value: String) {
        require(alias.matches(Regex("^[a-z][a-z0-9._-]{0,63}$"))) { "invalid alias" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(value.toByteArray())
        preferences.edit()
            .putString("$alias.iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString("$alias.ct", Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .apply()
    }

    fun get(alias: String): String? {
        val iv = preferences.getString("$alias.iv", null) ?: return null
        val cipherText = preferences.getString("$alias.ct", null) ?: return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                key(),
                GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)),
            )
            String(cipher.doFinal(Base64.decode(cipherText, Base64.NO_WRAP)))
        } catch (_: Exception) {
            null
        }
    }

    fun delete(alias: String) {
        preferences.edit().remove("$alias.iv").remove("$alias.ct").apply()
    }

    companion object {
        private const val KEY_ALIAS = "intentbridge-secrets-v1"
    }
}
