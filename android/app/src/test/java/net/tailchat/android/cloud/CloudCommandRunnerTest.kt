package net.tailchat.android.cloud

import android.content.Context
import androidx.core.content.pm.PackageInfoCompat
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import net.tailchat.android.R
import net.tailchat.android.Settings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The commands are checked against real string resources — a `/help` layout or
 * an "unknown command" line is exactly the resource it formats, and asserting
 * on a hand-copied Russian sentence would only pin the copy of the day.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CloudCommandRunnerTest {
    private class FakeHost(
        var selected: String? = "alice",
        var contacts: List<CloudUser> = listOf(CloudUser("alice", "Алиса", online = true)),
        var transcript: List<CloudMessage> = emptyList(),
        var link: CloudLink = CloudLink.Online,
        var subscribed: Boolean = true,
        var session: CloudSession? = CloudSession(
            server = "https://example.test",
            token = "t",
            user = CloudUser("self", "Я"),
        ),
    ) : CloudCommandRunner.Host {
        val notes = mutableListOf<Pair<String?, String>>()
        val sent = mutableListOf<String>()
        val selectedPeers = mutableListOf<String>()
        val pings = mutableListOf<String>()
        val wakes = mutableListOf<String>()
        val renames = mutableListOf<String>()
        val invitedLogins = mutableListOf<String?>()
        val acceptedCodes = mutableListOf<String>()
        var inviteResult: Result<String> = Result.success("code")
        var reconnects = 0
        var logouts = 0
        var clears = 0

        override fun selectedPeer(): String? = selected
        override fun session(): CloudSession? = session
        override fun contacts(): List<CloudUser> = contacts
        override fun transcript(): List<CloudMessage> = transcript
        override fun link(): CloudLink = link
        override fun subscribedToSelected(): Boolean = subscribed
        override fun queuedTotal(): Int = 0
        override fun pushSystemNote(peer: String?, text: String) {
            notes += peer to text
        }
        override fun sendMessage(text: String) {
            sent += text
        }
        override fun selectPeer(login: String) {
            selectedPeers += login
        }
        override fun renameSelf(name: String) {
            renames += name
        }
        override fun reconnect() {
            reconnects++
        }
        override fun logout() {
            logouts++
        }
        override fun clearTranscript() {
            clears++
        }
        override fun sendPing(peer: String, id: String, ts: Long): Boolean {
            pings += peer
            return true
        }
        override fun sendWake(peer: String): Boolean {
            wakes += peer
            return true
        }
        override fun notePingSent(peer: String, id: String, startedAt: Long) = Unit
        override suspend fun createInvite(session: CloudSession, login: String?): Result<String> {
            invitedLogins += login
            return inviteResult
        }
        override suspend fun acceptInvite(session: CloudSession, code: String): Result<CloudUser> {
            acceptedCodes += code
            return Result.success(CloudUser("bob", "Bob"))
        }
        override fun onInviteCreated(code: String) = Unit
        override fun onFriendAccepted(friend: CloudUser) = Unit
        override fun saveTranscript(filename: String, bytes: ByteArray): Result<String> = Result.success(filename)
    }

    private lateinit var context: Context
    private lateinit var host: FakeHost
    private lateinit var runner: CloudCommandRunner
    private val scope = CoroutineScope(Dispatchers.Unconfined)

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        host = FakeHost()
        runner = CloudCommandRunner(context, host)
    }

    @Test
    fun unknownCommandNamesItselfAndSendsNothing() {
        assertTrue(runner.run("/nope now", scope))
        assertEquals(
            listOf<Pair<String?, String>>("alice" to context.getString(R.string.cloud_cmd_unknown, "/nope")),
            host.notes,
        )
        assertEquals(emptyList<String>(), host.sent)
    }

    @Test
    fun helpListsEveryCommandOnceWithItsAliasAndDescription() {
        assertTrue(runner.run("/help", scope))
        val text = host.notes.single().second
        for (command in CLOUD_COMMANDS) {
            assertTrue(command.name, text.contains(command.name))
            command.alias?.let { assertTrue(it, text.contains("($it)")) }
            assertTrue(command.name, text.contains(context.getString(command.help)))
        }
        // Section bar, then a usage line and an indented description per command.
        assertEquals(1 + CLOUD_COMMANDS.size * 2, text.lines().size)
        assertEquals(emptyList<String>(), host.sent)
    }

    @Test
    fun plainTextIsNotACommand() {
        assertFalse(runner.run("help", scope))
        assertEquals(emptyList<Pair<String?, String>>(), host.notes)
        assertEquals(emptyList<String>(), host.sent)
    }

    /** What a phone asks of `/version`: the build it is actually running — the
     *  number the self-update compares this install against — reported in the
     *  open conversation and never sent as a message. The expected numbers are
     *  read off the package manager rather than written down here, since that is
     *  where the runner reads them from and a literal copy would pin the test
     *  manifest instead of the behaviour. */
    @Test
    fun versionReportsTheInstalledBuildInTheOpenConversation() {
        assertTrue(runner.run("/version", scope))
        val note = host.notes.single()
        assertEquals("alice", note.first)
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        assertTrue(
            note.second,
            note.second.contains(PackageInfoCompat.getLongVersionCode(info).toString()),
        )
        info.versionName?.let { assertTrue(note.second, note.second.contains(it)) }
        assertEquals(emptyList<String>(), host.sent)
    }

    @Test
    fun versionAliasReachesTheSameCommand() {
        assertTrue(runner.run("/version", scope))
        val canonical = host.notes.single().second

        host.notes.clear()
        assertTrue(runner.run("/v", scope))
        assertEquals(canonical, host.notes.single().second)
    }

    @Test
    fun ascSendsTheArtAsAMessage() {
        assertTrue(runner.run("/asc cat", scope))
        assertEquals(listOf(CLOUD_ASCII_ART.getValue("cat")), host.sent)
        assertEquals(emptyList<Pair<String?, String>>(), host.notes)
    }

    @Test
    fun peerSelectsAMatchingContactByName() {
        assertTrue(runner.run("/peer Алиса", scope))
        assertEquals(listOf("alice"), host.selectedPeers)
        assertEquals(emptyList<Pair<String?, String>>(), host.notes)
    }

    @Test
    fun peerReportsAnUnknownName() {
        assertTrue(runner.run("/peer борис", scope))
        assertEquals(emptyList<String>(), host.selectedPeers)
        assertEquals(
            context.getString(R.string.cloud_cmd_peer_not_found, "борис"),
            host.notes.single().second,
        )
    }

    /** A phone keyboard makes the decimal point a detour, so both spellings of
     *  the same size have to arrive at the same stored scale. */
    @Test
    fun scaleAcceptsPercentAndFraction() {
        assertTrue(runner.run("/scale 115", scope))
        val fromPercent = Settings(context).textScale
        val percentNote = host.notes.single().second

        host.notes.clear()
        assertTrue(runner.run("/scale 1.15", scope))
        assertEquals(fromPercent, Settings(context).textScale, 0f)
        assertEquals(percentNote, host.notes.single().second)
        assertEquals(1.15f, fromPercent, 0.0001f)
    }

    @Test
    fun pingWithNoOpenConversationNeverTouchesTheSocket() {
        host.selected = null
        assertTrue(runner.run("/ping", scope))
        assertEquals(
            listOf<Pair<String?, String>>(null to context.getString(R.string.cloud_cmd_no_peer)),
            host.notes,
        )
        assertEquals(emptyList<String>(), host.pings)
    }

    /** `/invite create <login>` mints the code for the account it names — the
     *  redeemer becomes *their* friend — so the second word has to reach the
     *  host as the login, untouched: whether the caller may ask at all is the
     *  server's answer (`forbidden`), not something to guess here.
     *
     *  What lands in the conversation is the shareable *link*, built on the
     *  session's own server: the note is a plain `Text`, so a bare code has
     *  nothing to copy or tap and nothing that tells the other person where to
     *  redeem it. */
    @Test
    fun inviteCreatePassesTheLoginThrough() {
        val code = "0123456789abcdef".repeat(4)
        host.inviteResult = Result.success(code)
        assertTrue(runner.run("/invite create remindka_bot", scope))

        assertEquals(listOf<String?>("remindka_bot"), host.invitedLogins)
        val note = host.notes.last()
        assertEquals("alice", note.first)
        assertTrue(note.second, note.second.contains("https://example.test/tailchat/?invite=$code"))
    }

    /** Bare `/invite` and `/invite create` are this account's own code — the
     *  request every build before this one made — so no login is sent. */
    @Test
    fun inviteWithoutALoginStaysTheOwnCode() {
        assertTrue(runner.run("/invite", scope))
        host.notes.clear()
        assertTrue(runner.run("/inv create", scope))

        assertEquals(listOf<String?>(null, null), host.invitedLogins)
    }

    /** `/inv`, `/invite accept <code>` and the other accept spellings keep
     *  taking the code from the second word, now that the first branch reads
     *  one too. */
    @Test
    fun inviteAcceptStillTakesTheCodeFromTheSecondWord() {
        assertTrue(runner.run("/inv accept abc123", scope))

        assertEquals(listOf("abc123"), host.acceptedCodes)
        assertEquals(
            "alice" to context.getString(R.string.cloud_cmd_invite_accepted, "Bob"),
            host.notes.last(),
        )
    }

    /** A refusal for somebody else's link is answered in the client's own
     *  words: the server sends one language to every device, and `unknown_user`
     *  used to fall through to that sentence. */
    @Test
    fun inviteCreateShowsRefusalsInTheClientsOwnWords() {
        host.inviteResult = Result.failure(CloudException("forbidden", "Приглашение для другого аккаунта может выдать только владелец деплоя."))
        assertTrue(runner.run("/invite create remindka_bot", scope))
        assertEquals("alice" to context.getString(R.string.cloud_error_forbidden), host.notes.last())

        host.notes.clear()
        host.inviteResult = Result.failure(CloudException("unknown_user", "Пользователь не найден."))
        assertTrue(runner.run("/invite create nobody", scope))
        assertEquals("alice" to context.getString(R.string.cloud_error_unknown_user), host.notes.last())
    }
}
