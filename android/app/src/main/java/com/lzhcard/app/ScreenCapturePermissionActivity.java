package com.lzhcard.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Bundle;

public class ScreenCapturePermissionActivity extends Activity {

    public static final String EXTRA_PURPOSE = "capture_purpose";
    private static final int REQ_MEDIA_PROJECTION = 7301;

    private String purpose = "freeze";
    private boolean delivered = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        overridePendingTransition(0, 0);
        if (getIntent() != null) {
            String p = getIntent().getStringExtra(EXTRA_PURPOSE);
            if (p != null && !p.isEmpty()) {
                purpose = p;
            }
        }
        if (savedInstanceState == null) {
            launchProjectionConsent();
        }
    }

    private void launchProjectionConsent() {
        try {
            MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            if (mpm == null) {
                deliverAndFinish(RESULT_CANCELED, null);
                return;
            }
            startActivityForResult(mpm.createScreenCaptureIntent(), REQ_MEDIA_PROJECTION);
        } catch (Exception e) {
            deliverAndFinish(RESULT_CANCELED, null);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_MEDIA_PROJECTION) {
            deliverAndFinish(resultCode, data);
        }
    }

    private void deliverAndFinish(int resultCode, Intent data) {
        if (!delivered) {
            delivered = true;
            FloatingOverlayService.onMediaProjectionPermissionResult(getApplicationContext(), resultCode, data, purpose);
        }
        runOnUiThread(() -> {
            finish();
            overridePendingTransition(0, 0);
        });
    }

    @Override
    protected void onDestroy() {
        if (!delivered) {
            delivered = true;
            FloatingOverlayService.onMediaProjectionPermissionResult(getApplicationContext(), RESULT_CANCELED, null, purpose);
        }
        super.onDestroy();
    }
}
