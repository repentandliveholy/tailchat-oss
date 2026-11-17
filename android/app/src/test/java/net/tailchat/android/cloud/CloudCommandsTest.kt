package net.tailchat.android.cloud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The command table is shared by `/help`, the composer palette and the
 * dispatcher, which is the point of it: a command that the palette offers and
 * the dispatcher does not understand is a dead row on screen.
 */
class CloudCommandsTest {
    @Test
    fun namesAndAliasesAreUnique() {
        val names = CLOUD_COMMANDS.map(CloudCommand::name)
        assertEquals(names.size, names.toSet().size)

        val aliases = CLOUD_COMMANDS.mapNotNull(CloudCommand::alias)
        assertEquals(aliases.size, aliases.toSet().size)
        assertTrue(aliases.none { it in names })
    }

    @Test
    fun everyNameAndAliasResolves() {
        for (command in CLOUD_COMMANDS) {
            assertEquals(command, resolveCloudCommand(command.name))
            command.alias?.let { assertEquals(command, resolveCloudCommand(it)) }
        }
        assertEquals("/theme", resolveCloudCommand("/T")?.name)
        assertNull(resolveCloudCommand("/nope"))
    }

    /** `updateCommandPalette` in web/cloud/app.js:1454-1461: prefix match on the
     *  name or the alias, and nothing at all once an argument has been typed. */
    @Test
    fun paletteFiltersLikeTheWebClient() {
        assertEquals(CLOUD_COMMANDS.size, cloudCommandMatches("/").size)
        assertEquals(listOf("/theme", "/typing", "/time"), cloudCommandMatches("/t").map(CloudCommand::name))
        assertEquals(listOf("/ping"), cloudCommandMatches("/ping").map(CloudCommand::name))
        assertTrue(cloudCommandMatches("/theme amber").isEmpty())
        assertTrue(cloudCommandMatches("hello").isEmpty())
        assertTrue(cloudCommandMatches("/zzz").isEmpty())
    }

    @Test
    fun usageJoinsNameAndArguments() {
        assertEquals("/help", resolveCloudCommand("/help")?.usage)
        assertEquals("/nick <name>", resolveCloudCommand("/nick")?.usage)
    }

    /** `/t` is `/theme`'s alias on web; it must not be swallowed by `/time`. */
    @Test
    fun aliasBeatsPrefixOnResolve() {
        assertEquals("/theme", resolveCloudCommand("/t")?.name)
        assertEquals("/time", resolveCloudCommand("/time")?.name)
    }

    @Test
    fun asciiArtCoversTheAdvertisedKeys() {
        val advertised = resolveCloudCommand("/asc")?.args.orEmpty()
        for (key in CLOUD_ASCII_ART.keys) {
            assertTrue("$key should be listed in /asc's usage", advertised.contains(key))
        }
    }

    @Test
    fun logoRowsShareOneWidthAndOneCat() {
        assertEquals(1, CLOUD_LOGO_ROWS.map(String::length).toSet().size)
        assertEquals(CLOUD_LOGO_ROWS.size, CLOUD_LOGO_BLINK_ROWS.size)
        assertTrue(CLOUD_LOGO_ROWS[1].contains("( o.o )"))
        assertTrue(CLOUD_LOGO_BLINK_ROWS[1].contains("( -.- )"))
    }
}
