package {{PACKAGE}};

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

// RECORD_AUDIO (web/cloud/'s voice messages, getUserMedia) is declared in the manifest but never
// actually requested anywhere in Bubblewrap's generated project — TWA content runs in Chrome's
// process, but Chrome can only grant hardware access this host app itself already holds.
// Requesting it here, in the one context guaranteed to be foreground (the user opening the app),
// is the extension point android-browser-helper documents for exactly this:
// shouldLaunchImmediately() defers the TWA launch until an async prerequisite (the permission
// prompt) finishes, then launchTwa() is called explicitly.
//
// Note: this deliberately does NOT touch POST_NOTIFICATIONS. Notification Delegation is off
// (see generate-manifest.mjs) specifically so push notifications go through Chrome's own,
// already-granted notification permission instead of depending on this app requesting and
// getting one of its own.
public class LauncherActivity extends com.google.androidbrowserhelper.trusted.LauncherActivity {
    private static final int PERMISSION_REQUEST_CODE = 1001;

    @Override
    protected boolean shouldLaunchImmediately() {
        return isGranted(Manifest.permission.RECORD_AUDIO);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!isGranted(Manifest.permission.RECORD_AUDIO)) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.RECORD_AUDIO},
                    PERMISSION_REQUEST_CODE);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // Launch either way — declining just means no voice messages, same as declining on any
        // other Android app.
        if (requestCode == PERMISSION_REQUEST_CODE) {
            launchTwa();
        }
    }

    private boolean isGranted(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
    }
}
