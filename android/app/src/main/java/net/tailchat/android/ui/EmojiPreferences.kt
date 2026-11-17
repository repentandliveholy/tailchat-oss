package net.tailchat.android.ui

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray

/** Device-local, shared by composer, reactions and quick-slot settings. */
internal class EmojiPreferences(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("tailchat", Context.MODE_PRIVATE)
    val revision = MutableStateFlow(0)
    private fun read(key: String): List<String> = runCatching {
        val rows = JSONArray(prefs.getString(key, "[]"))
        List(rows.length()) { rows.getString(it) }
    }.getOrDefault(emptyList())
    fun quick(table: EmojiTable) = EmojiChoices.normalize(read("quickReactions"), table)
    fun recent(table: EmojiTable) = read("emojiRecent").filter { table.entry(it) != null && EmojiChoices.allowed(it) }.distinct().take(24)
    fun remember(glyph: String, table: EmojiTable) {
        if (table.entry(glyph) == null || !EmojiChoices.allowed(glyph)) return
        prefs.edit().putString("emojiRecent", JSONArray((listOf(glyph) + recent(table).filter { it != glyph }).take(24)).toString()).apply()
        revision.value++
    }
    fun setQuick(slot: Int, glyph: String, table: EmojiTable) {
        if (slot !in EmojiChoices.defaults.indices || table.entry(glyph) == null || !EmojiChoices.allowed(glyph)) return
        val next = quick(table).toMutableList()
        val existing = next.indexOf(glyph)
        if (existing >= 0) next[existing] = next[slot]
        next[slot] = glyph
        prefs.edit().putString("quickReactions", JSONArray(next).toString()).apply()
        revision.value++
    }
    companion object {
        @Volatile private var instance: EmojiPreferences? = null
        fun get(context: Context): EmojiPreferences = instance ?: synchronized(this) {
            instance ?: EmojiPreferences(context).also { instance = it }
        }
    }
}
