package com.lzhcard.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    public static final String EXTRA_REQUEST_MIC_PERMISSION = "extra_request_mic_permission";
    private static final int REQ_RECORD_AUDIO = 4101;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SystemOverlayPlugin.class);
        registerPlugin(PlayBillingPlugin.class);
        registerPlugin(NativeTtsPlugin.class);
        super.onCreate(savedInstanceState);
        requestMicPermissionIfNeeded();
        handleOverlayActionIntent(getIntent());
    }

    @Override
    public void onResume() {
        super.onResume();
        FloatingOverlayService.setAppForegroundState(this, true);
        checkMicPermissionExtra(getIntent());
    }

    @Override
    public void onPause() {
        super.onPause();
        FloatingOverlayService.setAppForegroundState(this, false);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleOverlayActionIntent(intent);
    }

    private void requestMicPermissionIfNeeded() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this,
                new String[]{ Manifest.permission.RECORD_AUDIO },
                REQ_RECORD_AUDIO
            );
        }
    }

    private void checkMicPermissionExtra(Intent intent) {
        if (intent != null && intent.getBooleanExtra(EXTRA_REQUEST_MIC_PERMISSION, false)) {
            intent.removeExtra(EXTRA_REQUEST_MIC_PERMISSION);
            requestMicPermissionIfNeeded();
        }
    }

    private void handleOverlayActionIntent(Intent intent) {
        if (intent == null) return;
        checkMicPermissionExtra(intent);
        String action = intent.getStringExtra("lzh_action");
        if (action != null && !action.isEmpty()) {
            getSharedPreferences(FloatingOverlayService.PREFS_NAME, MODE_PRIVATE)
                .edit()
                .putString(FloatingOverlayService.KEY_PENDING_ACTION, action)
                .apply();
        }
    }
}