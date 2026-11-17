import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
    id("com.google.gms.google-services")
}

val generatedEmojiAssets = layout.buildDirectory.dir("generated/emojiAssets")
val generateEmojiCatalog by tasks.registering(Exec::class) {
    val generator = rootProject.file("../bin/make-android-emoji-data.js")
    inputs.files(generator, rootProject.file("../web/cloud/emoji-data.js"))
    outputs.dir(generatedEmojiAssets)
    commandLine("node", generator.absolutePath, generatedEmojiAssets.get().asFile.absolutePath)
}

// Keystore secrets never live in git: they come from the environment or
// from android/local.properties (gitignored, one per machine):
//   tailchat.keystore.password=…
//   tailchat.key.password=…      (defaults to the keystore password)
// Without them only the release build cannot be signed; debug builds and
// unit tests need nothing.
val localProps = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
fun secret(env: String, prop: String): String? =
    System.getenv(env)?.takeIf { it.isNotEmpty() } ?: localProps.getProperty(prop)?.takeIf { it.isNotEmpty() }
val keystorePassword = secret("TAILCHAT_KEYSTORE_PASSWORD", "tailchat.keystore.password")

android {
    namespace = "net.tailchat.android"
    compileSdk = 34

    defaultConfig {
        applicationId = "net.tailchat.android"
        minSdk = 29
        targetSdk = 34
        versionCode = 190
        versionName = "0.76.85"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Owner decision (docs/specs/2026-09-15-android-calls-plan.md §9.1):
        // 32-bit phones stay supported, so both ABIs ship in the single
        // universal APK self-update distributes. x86/x86_64 are dropped —
        // nobody's phone is an emulator.
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    signingConfigs {
        create("sideload") {
            storeFile = rootProject.file("tailchat-release.jks")
            storePassword = keystorePassword
            keyAlias = secret("TAILCHAT_KEY_ALIAS", "tailchat.key.alias") ?: "tailchat"
            keyPassword = secret("TAILCHAT_KEY_PASSWORD", "tailchat.key.password") ?: keystorePassword
        }
    }

    buildTypes {
        debug {
            // Deliberately NOT signingConfigs["sideload"]: that keystore is the
            // production signing identity (tailchat-release.jks), committed only
            // because self-update installs must keep matching it release after
            // release. A debug build needs no relationship to that identity —
            // AGP's implicit per-machine ~/.android/debug.keystore is enough,
            // and it means a debug APK can never be mistaken for (or silently
            // update) a real install. release-android.js only ever builds and
            // publishes assembleRelease.
            //
            // Debug-only: lets the call engine be exercised on the x86_64
            // emulator during development. release keeps exactly the two ABIs
            // from defaultConfig — this is additive, not an override.
            ndk {
                abiFilters += "x86_64"
            }
        }
        release {
            // material-icons-extended is thousands of generated vector builders
            // and the app uses five of them; without R8 the APK is 41 MB of
            // icons nobody will ever see. Nothing here is reached by
            // reflection — the JSON layer works on JsonObject, not on
            // @Serializable classes — so there is nothing for it to break.
            //
            // `-PnoR8` builds the same release, signed with the same identity,
            // with minification and resource shrinking off. That is the only
            // way to tell "the app is broken" apart from "R8 broke the app":
            // 0.76.1/98 (minified) would not start on a real device while
            // 0.76.2/102 and /104 (the same code, unminified) did — see
            // docs/worklog.md. Never the default: an unminified release is
            // 67 MB against 24 MB.
            val minify = !project.hasProperty("noR8")
            isMinifyEnabled = minify
            isShrinkResources = minify
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = signingConfigs.getByName("sideload")
        }
    }

    // The instrumented tests under `src/androidTest` run against the *release*
    // variant, not the debug one. `debug` is signed with AGP's per-machine
    // `~/.android/debug.keystore` (see `buildTypes` above), and a device that
    // already carries a sideload-signed release refuses that APK outright — so
    // on any real phone the test run has to share the release's own identity
    // and versionCode. Two consequences to remember, both recorded in
    // android/HANDOFF.md:
    //
    //  * `connectedDebugAndroidTest` no longer exists for this module. The
    //    device run is `:app:connectedReleaseAndroidTest`, or the two APKs by
    //    hand — `app-release.apk` and `app-release-androidTest.apk` — through
    //    `am instrument`.
    //  * It has to be built with `-PnoR8`. R8 renames the app's own classes,
    //    and the test APK is compiled from source against their real names, so
    //    a minified build fails at runtime with `NoClassDefFoundError` — the
    //    same minification escape hatch `buildTypes.release` already documents.
    testBuildType = "release"

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }

    sourceSets {
        getByName("main") {
            // The same immutable artwork as web, without a second repository copy.
            assets.srcDir("../../web/cloud/emoji")
            assets.srcDir(generatedEmojiAssets)
        }
        // `MigrationTestHelper` reads a version's schema JSON through
        // `Instrumentation.context.assets`; Robolectric's own unit-test
        // config points at the *debug* variant's merged assets
        // (`android_merged_assets=…/mergeDebugAssets`), not a `test`
        // source set, so this has to live on `debug` to be found. It never
        // reaches a release build — `mergeReleaseAssets` does not see it.
        getByName("debug") {
            assets.srcDirs("$projectDir/schemas")
        }
    }

    testOptions {
        unitTests.all {
            it.testLogging { showStandardStreams = true }
        }
        // Room DAO/migration tests run on the JVM through Robolectric, which
        // needs the merged resources and manifest of the app under test.
        unitTests.isIncludeAndroidResources = true
    }
}

tasks.named("preBuild").configure { dependsOn(generateEmojiCatalog) }

// Room schema JSON, one file per version, checked in under app/schemas — the
// only way `MigrationTestHelper` can open "what version 1 actually looked
// like" once a version 2 exists to migrate from.
ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.core:core-ktx:1.13.1")
    // Android 12+'s own cold-start splash, drawn back to this app's minSdk by
    // the compat shim — see Theme.Tailchat.Splash and MainActivity's
    // installSplashScreen() call.
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-process:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation(platform("androidx.compose:compose-bom:2024.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")
    implementation("net.zetetic:sqlcipher-android:4.6.1@aar")
    implementation("androidx.sqlite:sqlite:2.4.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-savedstate:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    // FCM push notifications: `TailchatFirebaseMessagingService` wakes the
    // app process even when ChatService's socket is not running (force-stop,
    // OEM battery kill, Doze) — see LOCAL_FIRST_EXECUTION_PLAN.md's
    // notification-reliability gap. Server side: `src/cloud/fcm.js`.
    implementation(platform("com.google.firebase:firebase-bom:33.5.1"))
    implementation("com.google.firebase:firebase-messaging-ktx")
    // Voice calls (docs/specs/2026-09-15-android-calls-plan.md §1). Pinned
    // exact version, not a range — see the plan for the Maven Central check
    // and the fallback to 137.7151.05 if AGP/NDK build issues surface.
    implementation("io.github.webrtc-sdk:android:150.7871.01")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.robolectric:robolectric:4.13")
    testImplementation("androidx.test:core-ktx:1.6.1")
    testImplementation("androidx.room:room-testing:2.6.1")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    testImplementation("androidx.work:work-testing:2.9.1")
    // Real pointer input for the transcript's own gestures. The reply swipe is
    // a custom `awaitEachGesture` loop whose whole job is deciding whether the
    // LazyColumn keeps the pointer, and no pure function can prove that: only
    // an injected touch sequence through the real pipeline can show a scroll
    // still scrolling and a sideways drag still arming a reply. Robolectric
    // runs it in the ordinary unit-test task, so it is a gate rather than a
    // one-off device check.
    testImplementation("androidx.compose.ui:ui-test-junit4")
    // The host activity `createComposeRule` needs, in the debug manifest only —
    // debugImplementation, so it cannot reach a release APK.
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    // TalkBack custom-action coverage (LOCAL_FIRST_EXECUTION_PLAN.md §8B
    // accessibility row): only a real AccessibilityNodeInfo tree exposes
    // whether a Compose `CustomAccessibilityAction` is actually reachable
    // the way TalkBack reaches it, which a JVM/Robolectric unit test cannot
    // do — UiAutomator drives the platform tree the same service would.
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
    androidTestImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
