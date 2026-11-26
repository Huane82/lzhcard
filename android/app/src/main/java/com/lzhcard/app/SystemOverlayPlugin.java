package com.lzhcard.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SystemOverlay")
public class SystemOverlayPlugin extends Plugin {

    private boolean hasOverlayPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }
        Context ctx = getContext();
        return ctx != null && Settings.canDrawOverlays(ctx);
    }

    private void saveConfigToPrefs(Context ctx, PluginCall call) {
        SharedPreferences.Editor ed = ctx.getSharedPreferences(FloatingOverlayService.PREFS_NAME, Context.MODE_PRIVATE).edit();
        if (call.hasOption("nativeLang")) ed.putString(FloatingOverlayService.KEY_NATIVE_LANG, call.getString("nativeLang", "zh-TW"));
        if (call.hasOption("theme")) ed.putString(FloatingOverlayService.KEY_THEME_MODE, call.getString("theme", "system"));
        if (call.hasOption("decksJson")) ed.putString(FloatingOverlayService.KEY_DECKS_JSON, call.getString("decksJson", "[\"我的單字本\"]"));
        if (call.hasOption("defaultDeck")) ed.putString(FloatingOverlayService.KEY_DEFAULT_DECK, call.getString("defaultDeck", "我的單字本"));
        if (call.hasOption("membershipTier")) ed.putString(FloatingOverlayService.KEY_MEMBERSHIP_TIER, call.getString("membershipTier", "free"));
        if (call.hasOption("aiUsageJson")) ed.putString(FloatingOverlayService.KEY_AI_USAGE_JSON, call.getString("aiUsageJson", "{}"));
        if (call.hasOption("chatSessionJson")) ed.putString(FloatingOverlayService.KEY_CHAT_SESSION_JSON, call.getString("chatSessionJson", "{}"));
        if (call.hasOption("videoRoiMode")) ed.putString(FloatingOverlayService.KEY_VIDEO_ROI_MODE, call.getString("videoRoiMode", "bottom25"));
        if (call.hasOption("videoRoiRectJson")) ed.putString(FloatingOverlayService.KEY_VIDEO_ROI_RECT_JSON, call.getString("videoRoiRectJson", "{}"));
        if (call.hasOption("videoSourceLang")) ed.putString(FloatingOverlayService.KEY_VIDEO_SOURCE_LANG, call.getString("videoSourceLang", "en"));
        ed.apply();
    }

    @PluginMethod
    public void checkOverlayPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", hasOverlayPermission());
        ret.put("running", FloatingOverlayService.isRunning());
        ret.put("manufacturer", Build.MANUFACTURER != null ? Build.MANUFACTURER : "");
        ret.put("brand", Build.BRAND != null ? Build.BRAND : "");
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        Context ctx = getContext();
        if (ctx == null) {
            call.reject("Context unavailable");
            return;
        }

        if (hasOverlayPermission()) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            ret.put("opened", false);
            call.resolve(ret);
            return;
        }

        boolean opened = false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Intent intent = new Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + ctx.getPackageName())
                );
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(intent);
                opened = true;
            }
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + ctx.getPackageName())
                );
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(fallback);
                opened = true;
            } catch (Exception inner) {
                call.reject("Unable to open system overlay settings: " + inner.getMessage());
                return;
            }
        }

        JSObject ret = new JSObject();
        ret.put("granted", hasOverlayPermission());
        ret.put("opened", opened);
        call.resolve(ret);
    }

    @PluginMethod
    public void startOverlayService(PluginCall call) {
        Context ctx = getContext();
        if (ctx == null) {
            call.reject("Context unavailable");
            return;
        }
        if (!hasOverlayPermission()) {
            JSObject ret = new JSObject();
            ret.put("running", false);
            ret.put("granted", false);
            call.resolve(ret);
            return;
        }

        try {
            saveConfigToPrefs(ctx, call);
            boolean inForeground = call.getBoolean("inForeground", true);

            Intent svc = new Intent(ctx, FloatingOverlayService.class);
            svc.setAction(FloatingOverlayService.ACTION_START);
            svc.putExtra(FloatingOverlayService.EXTRA_IN_FOREGROUND, inForeground);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(ctx, svc);
            } else {
                ctx.startService(svc);
            }
            JSObject ret = new JSObject();
            ret.put("running", true);
            ret.put("granted", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to start overlay service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void syncOverlayConfig(PluginCall call) {
        Context ctx = getContext();
        if (ctx == null) {
            call.reject("Context unavailable");
            return;
        }
        saveConfigToPrefs(ctx, call);

        if (FloatingOverlayService.isRunning()) {
            Intent svc = new Intent(ctx, FloatingOverlayService.class);
            svc.setAction(FloatingOverlayService.ACTION_SYNC_PREFS);
            ctx.startService(svc);
        }

        JSObject ret = new JSObject();
        ret.put("synced", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void setAppForeground(PluginCall call) {
        Context ctx = getContext();
        if (ctx != null) {
            boolean inFg = call.getBoolean("inForeground", true);
            FloatingOverlayService.setAppForegroundState(ctx, inFg);
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void consumePendingData(PluginCall call) {
        Context ctx = getContext();
        if (ctx == null) {
            call.reject("Context unavailable");
            return;
        }
        SharedPreferences sp = ctx.getSharedPreferences(FloatingOverlayService.PREFS_NAME, Context.MODE_PRIVATE);
        String cardsRaw = sp.getString(FloatingOverlayService.KEY_PENDING_CARDS, "[]");
        String action = sp.getString(FloatingOverlayService.KEY_PENDING_ACTION, "");
        sp.edit()
            .remove(FloatingOverlayService.KEY_PENDING_CARDS)
            .remove(FloatingOverlayService.KEY_PENDING_ACTION)
            .apply();

        JSObject ret = new JSObject();
        try {
            ret.put("cards", new JSArray(cardsRaw));
        } catch (Exception e) {
            ret.put("cards", new JSArray());
        }
        ret.put("action", action);
        call.resolve(ret);
    }

    @PluginMethod
    public void stopOverlayService(PluginCall call) {
        Context ctx = getContext();
        if (ctx == null) {
            call.reject("Context unavailable");
            return;
        }
        try {
            Intent svc = new Intent(ctx, FloatingOverlayService.class);
            ctx.stopService(svc);
            JSObject ret = new JSObject();
            ret.put("running", false);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to stop overlay service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void isOverlayRunning(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", FloatingOverlayService.isRunning());
        ret.put("granted", hasOverlayPermission());
        ret.put("screenCaptureReady", FloatingOverlayService.hasActiveMediaProjection());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestScreenCapturePermission(PluginCall call) {
        Context ctx = getContext();
        if (ctx == null) {
            call.reject("Context unavailable");
            return;
        }
        if (FloatingOverlayService.hasActiveMediaProjection()) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            ret.put("launched", false);
            call.resolve(ret);
            return;
        }
        try {
            String purpose = call.getString("purpose", "preauth");
            Intent perm = new Intent(ctx, ScreenCapturePermissionActivity.class);
            perm.putExtra(ScreenCapturePermissionActivity.EXTRA_PURPOSE, purpose);
            perm.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK |
                Intent.FLAG_ACTIVITY_MULTIPLE_TASK |
                Intent.FLAG_ACTIVITY_NO_ANIMATION
            );
            ctx.startActivity(perm);
            JSObject ret = new JSObject();
            ret.put("launched", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Unable to launch screen capture permission: " + e.getMessage());
        }
    }

    @PluginMethod
    public void setOverlayFullscreen(PluginCall call) {
        boolean isFullscreen = call.getBoolean("isFullscreen", false);
        FloatingOverlayService.setPanelFullscreenState(isFullscreen);
        JSObject ret = new JSObject();
        ret.put("isFullscreen", isFullscreen);
        call.resolve(ret);
    }

    @PluginMethod
    public void setImageModeActive(PluginCall call) {
        boolean active = call.getBoolean("active", false);
        FloatingOverlayService.setImageModeState(active);
        JSObject ret = new JSObject();
        ret.put("active", active);
        call.resolve(ret);
    }
}