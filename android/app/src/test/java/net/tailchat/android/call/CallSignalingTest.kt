package net.tailchat.android.call

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CallSignalingTest {
    @Test
    fun offerRoundTrips() {
        val offer = CallFrame.Offer(callId = "c1", sdp = "v=0", media = "audio", ts = 1234L)
        val json = CallSignaling.toJson(offer)
        assertEquals("call-offer", json["t"]!!.let { (it as kotlinx.serialization.json.JsonPrimitive).content })
        assertEquals(offer, CallSignaling.fromJson(json))
    }

    @Test
    fun answerRoundTrips() {
        val answer = CallFrame.Answer("c1", "v=0 answer")
        assertEquals(answer, CallSignaling.fromJson(CallSignaling.toJson(answer)))
    }

    @Test
    fun ringAndTakenRoundTrip() {
        assertEquals(CallFrame.Ring("c1"), CallSignaling.fromJson(CallSignaling.toJson(CallFrame.Ring("c1"))))
        assertEquals(CallFrame.Taken("c1"), CallSignaling.fromJson(CallSignaling.toJson(CallFrame.Taken("c1"))))
    }

    @Test
    fun iceCandidatesRoundTripAsAnArrayNotOnePerFrame() {
        val frame = CallFrame.IceCandidates(
            "c1",
            listOf(
                IceCandidate("candidate:1 1 udp 1 1.1.1.1 1 typ host", "0", 0),
                IceCandidate("candidate:2 1 udp 1 2.2.2.2 2 typ srflx", null, null),
            ),
        )
        val json = CallSignaling.toJson(frame)
        assertEquals(2, json["candidates"]!!.let { (it as kotlinx.serialization.json.JsonArray).size })
        assertEquals(frame, CallSignaling.fromJson(json))
    }

    @Test
    fun endReasonRoundTripsAndUnrecognisedReasonDecodesToUnknownRatherThanFailing() {
        val end = CallFrame.End("c1", CallEndReason.Declined)
        assertEquals(end, CallSignaling.fromJson(CallSignaling.toJson(end)))

        val future = buildJsonObject {
            put("t", "call-end")
            put("callId", "c1")
            put("reason", "some-future-reason")
        }
        assertEquals(CallFrame.End("c1", CallEndReason.Unknown), CallSignaling.fromJson(future))
    }

    @Test
    fun unknownFieldsAreTolerated() {
        val withExtra = buildJsonObject {
            put("t", "call-offer")
            put("callId", "c1")
            put("sdp", "v=0")
            put("media", "audio")
            put("ts", 1L)
            put("fromSomeNewerClient", "ignored")
        }
        assertEquals(CallFrame.Offer("c1", "v=0", "audio", 1L), CallSignaling.fromJson(withExtra))
    }

    @Test
    fun missingCallIdOrRequiredFieldDecodesToNullRatherThanThrowing() {
        assertNull(CallSignaling.fromJson(buildJsonObject { put("t", "call-offer") }))
        assertNull(
            CallSignaling.fromJson(
                buildJsonObject {
                    put("t", "call-answer")
                    put("callId", "c1")
                    // no sdp
                },
            ),
        )
    }

    @Test
    fun unrecognisedFrameTypeDecodesToNull() {
        assertNull(
            CallSignaling.fromJson(
                buildJsonObject {
                    put("t", "call-something-future")
                    put("callId", "c1")
                },
            ),
        )
    }

    @Test
    fun offerDefaultsMediaToAudioWhenAbsent() {
        val json = buildJsonObject {
            put("t", "call-offer")
            put("callId", "c1")
            put("sdp", "v=0")
            put("ts", 5L)
        }
        assertEquals(CallFrame.Offer("c1", "v=0", "audio", 5L), CallSignaling.fromJson(json))
    }
}
