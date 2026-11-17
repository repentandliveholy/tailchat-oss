# The app reaches nothing by reflection: the JSON layer works on JsonObject and
# JsonElement rather than on @Serializable classes, so the usual
# kotlinx-serialization keep rules are not needed. These two entries exist only
# because the platform instantiates them by name from the manifest.
-keep class net.tailchat.android.MainActivity { *; }
-keep class net.tailchat.android.ChatService { *; }

# libwebrtc calls back into its own Java classes from JNI by name; R8 sees no
# caller for them and strips the callbacks in release only (docs/specs/
# 2026-09-15-android-calls-plan.md §4.1) unless kept explicitly.
-keep class org.webrtc.** { *; }
# io.github.webrtc-sdk 150.x routes every one of those JNI lookups through
# jni_zero, which lives *outside* org.webrtc and is referenced only from
# native code. Without this, R8 strips it and `JNI_OnLoad` aborts the process
# the first time `PeerConnectionFactory.initialize` runs — i.e. in
# `ChatService.onCreate`, before any UI: `JNI DETECTED ERROR IN APPLICATION:
# java_class == null in call to GetStaticMethodID`, with
# `ClassNotFoundException: org.jni_zero.JniZero` as the pending exception.
# That is the crash that took 0.76.1/98 down on a real phone and cost a
# rollback to 0.75.7/99 — reproduced on the API 34 emulator and fixed here.
-keep class org.jni_zero.** { *; }
-dontwarn org.jni_zero.**
# SQLCipher JNI callbacks: libsqlcipher.so looks up Java classes in net.zetetic by name
-keep class net.zetetic.** { *; }
-dontwarn net.zetetic.**
-keepclasseswithmembernames class * {
    native <methods>;
}
