package net.tailchat.android.ui

import net.tailchat.android.cloud.CloudBotAction
import net.tailchat.android.cloud.CloudUser
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The menu button this client draws on its own behalf, offered exactly where
 * the conversation cannot offer it instead: the service account's thread, with
 * no message in it and no history still on its way.
 *
 * `official` is true for both server-side accounts, and `/help` is a command
 * only one of them answers — which is why this pins the login rather than that
 * flag.
 */
class ServiceMenuOfferedTest {
    private val service = CloudUser(login = "tailchat", name = "Tailchat", official = true)
    private val assistant = CloudUser(login = "tailik", name = "tailik", official = true)
    private val friend = CloudUser(login = "olga", name = "Ольга")
    private val live = listOf(CloudBotAction(id = "help", label = "Помощь", value = "/help"))

    @Test
    fun `an empty service thread offers the menu`() {
        assertTrue(serviceMenuOffered(live = emptyList(), peer = service, messageCount = 0, loadingHistory = false))
    }

    @Test
    fun `the assistant and a friend never do`() {
        assertFalse(serviceMenuOffered(emptyList(), assistant, 0, false))
        assertFalse(serviceMenuOffered(emptyList(), friend, 0, false))
    }

    @Test
    fun `a thread with anything in it, or one still loading, keeps the account's own buttons`() {
        assertFalse(serviceMenuOffered(emptyList(), service, messageCount = 1, loadingHistory = false))
        assertFalse(serviceMenuOffered(emptyList(), service, messageCount = 0, loadingHistory = true))
    }

    @Test
    fun `what the server said the account offers wins over the seeded menu`() {
        assertFalse(serviceMenuOffered(live, service, messageCount = 0, loadingHistory = false))
    }
}
