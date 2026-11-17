package net.tailchat.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import net.tailchat.android.ChatController
import net.tailchat.android.ChatState
import net.tailchat.android.Settings
import net.tailchat.android.cloud.CloudController
import net.tailchat.proto.PeerDevice

private fun portOf(text: String): Int = text.trim().toIntOrNull() ?: Settings.DEFAULT_PORT

private fun digitsOnly(text: String): String = text.filter { it.isDigit() }.take(5)

@Composable
fun SettingsSheet(
    controller: ChatController,
    /** The same always-alive controller the cloud screen uses, threaded in
     *  here only for [UpdateCheckSection]: self-update must not be a
     *  cloud-account-only feature — this direct-tailnet screen gets the same
     *  check/update button as the cloud settings sheet. */
    cloudController: CloudController,
    state: ChatState,
    initialName: String,
    initialPeer: String,
    initialPeerPort: Int,
    initialListenPort: Int,
    initialKeepTranscript: Boolean,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(initialName) }
    var peer by remember { mutableStateOf(initialPeer) }
    var peerPort by remember { mutableStateOf(initialPeerPort.toString()) }
    var listenPort by remember { mutableStateOf(initialListenPort.toString()) }
    var keepTranscript by remember { mutableStateOf(initialKeepTranscript) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(start = 20.dp, end = 20.dp, bottom = 28.dp),
    ) {
        Text(text = "settings", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(16.dp))

        OutlinedTextField(
            value = name,
            onValueChange = { name = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("display name") },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyMedium,
            shape = RoundedCornerShape(12.dp),
            colors = fieldColors(),
        )
        Spacer(Modifier.height(12.dp))

        OutlinedTextField(
            value = peer,
            onValueChange = { peer = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("peer — MagicDNS name or 100.x address") },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyMedium,
            shape = RoundedCornerShape(12.dp),
            colors = fieldColors(),
        )
        Spacer(Modifier.height(12.dp))

        Row(modifier = Modifier.fillMaxWidth()) {
            OutlinedTextField(
                value = peerPort,
                onValueChange = { peerPort = digitsOnly(it) },
                modifier = Modifier.weight(1f),
                label = { Text("peer port") },
                placeholder = { Text(Settings.DEFAULT_PORT.toString()) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                textStyle = MaterialTheme.typography.bodyMedium,
                shape = RoundedCornerShape(12.dp),
                colors = fieldColors(),
            )
            Spacer(Modifier.width(12.dp))
            OutlinedTextField(
                value = listenPort,
                onValueChange = { listenPort = digitsOnly(it) },
                modifier = Modifier.weight(1f),
                label = { Text("listen port") },
                placeholder = { Text(Settings.DEFAULT_PORT.toString()) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                textStyle = MaterialTheme.typography.bodyMedium,
                shape = RoundedCornerShape(12.dp),
                colors = fieldColors(),
            )
        }
        Spacer(Modifier.height(8.dp))

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(text = "keep transcript", style = MaterialTheme.typography.bodyMedium)
                Text(
                    text = "keeps the conversation on this device between runs",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Switch(
                checked = keepTranscript,
                onCheckedChange = { keepTranscript = it },
                colors = SwitchDefaults.colors(
                    checkedThumbColor = MaterialTheme.colorScheme.onPrimary,
                    checkedTrackColor = MaterialTheme.colorScheme.primary,
                    uncheckedTrackColor = MaterialTheme.colorScheme.surfaceVariant,
                    uncheckedThumbColor = LocalTailchatAccents.current.line,
                    uncheckedBorderColor = MaterialTheme.colorScheme.outline,
                ),
            )
        }
        Spacer(Modifier.height(16.dp))

        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(12.dp),
            color = MaterialTheme.colorScheme.surfaceVariant,
            contentColor = MaterialTheme.colorScheme.onSurface,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        ) {
            Column(modifier = Modifier.padding(14.dp)) {
                InfoRow("this device", state.tailnetAddress ?: "tailscale is down")
                Spacer(Modifier.height(6.dp))
                InfoRow("listening on", state.listenAddress ?: "not listening")
            }
        }

        if (state.peerDevices.isNotEmpty()) {
            Spacer(Modifier.height(20.dp))
            Text(
                text = "peer devices",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(4.dp))
            state.peerDevices.forEach { device ->
                DeviceRow(device) { target ->
                    controller.retarget(target, portOf(peerPort))
                    onDismiss()
                }
            }
        }

        Spacer(Modifier.height(20.dp))
        UpdateCheckSection(cloudController)

        Spacer(Modifier.height(24.dp))
        Button(
            onClick = {
                controller.applySettings(
                    name.trim(),
                    peer.trim(),
                    portOf(peerPort),
                    portOf(listenPort),
                    keepTranscript,
                )
                onDismiss()
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("save")
        }
        Spacer(Modifier.height(4.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            TextButton(onClick = { controller.clearTranscript() }) { Text("clear transcript") }
            TextButton(onClick = { controller.sendLogo() }) { Text("send logo") }
        }
    }
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = MaterialTheme.colorScheme.primary,
    unfocusedBorderColor = MaterialTheme.colorScheme.outline,
    focusedLabelColor = MaterialTheme.colorScheme.primary,
    unfocusedLabelColor = MaterialTheme.colorScheme.onSurfaceVariant,
    cursorColor = MaterialTheme.colorScheme.primary,
    // A tonal fill, not only an edge: with «Обводки» off the border is
    // transparent and the field would otherwise be an unframed label.
    focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
)

@Composable
private fun InfoRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = label,
            modifier = Modifier.width(104.dp),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(text = value, style = MaterialTheme.typography.bodySmall)
    }
}

/**
 * One of the peer's other machines. Only rows we can actually dial are tappable:
 * a device without an address is worth showing but not worth retargeting to.
 */
@Composable
private fun DeviceRow(device: PeerDevice, onPick: (String) -> Unit) {
    val ip = device.ips.firstOrNull()
    val label = device.host ?: device.dns ?: ip ?: "unnamed device"
    val row = Modifier
        .fillMaxWidth()
        .then(if (ip != null) Modifier.clickable { onPick(ip) } else Modifier)
        .padding(vertical = 10.dp)
    Column {
        Row(modifier = row, verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(text = label, style = MaterialTheme.typography.bodyMedium)
                Text(
                    text = ip ?: "no address",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (ip != null) {
                Text(
                    text = "use",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    }
}
