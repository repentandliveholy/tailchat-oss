package net.tailchat.android

import android.app.LocaleManager
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import android.os.LocaleList
import java.util.Locale

/**
 * The in-app language switch web carries under «Язык» (`data-lang`), on the two
 * mechanisms Android actually gives us.
 *
 * On API 33+ the platform owns per-app languages: handing the tag to
 * [LocaleManager] restarts the activity itself *and* — the reason it is worth
 * the branch — makes every other component of the process, notably
 * [ChatService]'s notification text, resolve in the chosen language too.
 *
 * Below 33 there is no such registry, so the choice can only be applied by
 * wrapping the activity's own resources ([wrap], called from
 * `attachBaseContext`). Notifications posted by the service keep following the
 * device language there; the alternative — mutating the process-wide default
 * `Locale` — leaks into every library and into date formatting the transcript
 * shares with the server, which is a worse trade than one honest gap.
 */
object AppLocale {
    /** BCP-47 tag, or null for "follow the device". */
    fun tag(lang: AppLang): String? = when (lang) {
        AppLang.System -> null
        AppLang.Ru -> "ru"
        AppLang.En -> "en"
    }

    /** The context an activity should render from. */
    fun wrap(base: Context): Context {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return base
        val tag = tag(Settings(base).language) ?: return base
        val locale = Locale.forLanguageTag(tag)
        val config = android.content.res.Configuration(base.resources.configuration)
        config.setLocales(LocaleList(locale))
        return ContextWrapper(base.createConfigurationContext(config))
    }

    /**
     * Persists the choice and puts it into effect. Returns true when the caller
     * still has to restart the activity itself — API 33+ does that for us, and
     * calling `recreate()` on top of the platform's own restart double-flashes
     * the screen.
     */
    fun apply(context: Context, lang: AppLang): Boolean {
        Settings(context).language = lang
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        val manager = context.getSystemService(LocaleManager::class.java) ?: return true
        val tag = tag(lang)
        manager.applicationLocales = if (tag == null) LocaleList.getEmptyLocaleList()
        else LocaleList.forLanguageTags(tag)
        return false
    }

    /**
     * What the settings sheet should show as selected. On API 33+ the platform
     * registry is the truth — a person can also change this from Android's own
     * app-language screen, and the sheet must not disagree with it.
     */
    fun current(context: Context): AppLang {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return Settings(context).language
        val manager = context.getSystemService(LocaleManager::class.java) ?: return AppLang.System
        val tag = manager.applicationLocales.takeIf { !it.isEmpty }?.get(0)?.language
        return when (tag) {
            "ru" -> AppLang.Ru
            "en" -> AppLang.En
            else -> AppLang.System
        }
    }
}
