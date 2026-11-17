package net.tailchat.android

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SettingsAppearanceTest {
    private val context get() = ApplicationProvider.getApplicationContext<Application>()
    private val prefs get() = context.getSharedPreferences("tailchat", Context.MODE_PRIVATE)
    @Before @After fun clearAppearanceKeys() {
        prefs.edit().remove("bubbleOutline").remove("depthDesign").remove("linkPreviews").commit()
    }
    @Test fun legacyExplicitOutlineChoiceSurvivesWithoutChangingDepth() {
        prefs.edit().putBoolean("bubbleOutline", true).putBoolean("depthDesign", false).commit()
        val settings = Settings(context)
        assertTrue(settings.outlines)
        assertFalse(settings.depthDesign)
        settings.depthDesign = true
        assertTrue(Settings(context).outlines)
        assertTrue(Settings(context).depthDesign)
        settings.outlines = false
        assertTrue(Settings(context).depthDesign)
        assertFalse(Settings(context).outlines)
    }
    @Test fun untouchedInstallationGetsWebAppearanceWithoutWritingAChoice() {
        val settings = Settings(context)
        assertFalse(settings.outlines)
        assertTrue(settings.depthDesign)
        assertFalse(prefs.contains("bubbleOutline"))
        assertFalse(prefs.contains("depthDesign"))
    }
    @Test fun disabledPreviewsStayDisabledAcrossAppearanceChanges() {
        val settings = Settings(context)
        settings.linkPreviews = false
        settings.depthDesign = false
        settings.outlines = true
        val reloaded = Settings(context)
        assertFalse(reloaded.linkPreviews)
        assertFalse(reloaded.depthDesign)
        assertTrue(reloaded.outlines)
    }
}
