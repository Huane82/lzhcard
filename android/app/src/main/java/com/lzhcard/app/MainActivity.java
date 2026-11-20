package com.lzhcard.app;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SystemOverlayPlugin.class);
        registerPlugin(PlayBillingPlugin.class);
        super.onCreate(savedInstanceState);
        handleOverlayActionIntent(getIntent());
    }

    @Override
    public void onResume() {
        super.onResume();
        FloatingOverlayService.setAppForegroundState(this, true);
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

    private void handleOverlayActionIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getStringExtra("lzh_action");
        if (action != null && !action.isEmpty()) {
            getSharedPreferences(FloatingOverlayService.PREFS_NAME, MODE_PRIVATE)
                .edit()
                .putString(FloatingOverlayService.KEY_PENDING_ACTION, action)
                .apply();
        }
    }
}