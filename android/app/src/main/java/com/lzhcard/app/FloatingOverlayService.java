package com.lzhcard.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.text.TextUtils;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.nl.translate.TranslateLanguage;
import com.google.mlkit.nl.translate.Translation;
import com.google.mlkit.nl.translate.Translator;
import com.google.mlkit.nl.translate.TranslatorOptions;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

public class FloatingOverlayService extends Service {

    public static final String ACTION_START = "com.lzhcard.app.ACTION_START_OVERLAY";
    public static final String ACTION_STOP = "com.lzhcard.app.ACTION_STOP_OVERLAY";
    public static final String ACTION_SYNC_PREFS = "com.lzhcard.app.ACTION_SYNC_OVERLAY_PREFS";
    public static final String ACTION_FOREGROUND_STATE = "com.lzhcard.app.ACTION_FOREGROUND_STATE";
    public static final String ACTION_MEDIA_PROJECTION_RESULT = "com.lzhcard.app.ACTION_MEDIA_PROJECTION_RESULT";
    public static final String EXTRA_IN_FOREGROUND = "in_foreground";
    public static final String EXTRA_MP_RESULT_CODE = "mp_result_code";
    public static final String EXTRA_MP_DATA = "mp_data";
    public static final String EXTRA_MP_PURPOSE = "mp_purpose";

    public static final String PREFS_NAME = "lzhcard_native_overlay_prefs";
    public static final String KEY_PENDING_CARDS = "pending_overlay_cards_json";
    public static final String KEY_PENDING_ACTION = "pending_overlay_action";
    public static final String KEY_NATIVE_LANG = "overlay_native_lang";
    public static final String KEY_THEME_MODE = "overlay_theme_mode";
    public static final String KEY_API_MODE = "overlay_api_mode";
    public static final String KEY_API_KEY = "overlay_api_key";
    public static final String KEY_GROQ_API_KEY = "overlay_groq_api_key";
    public static final String KEY_DECKS_JSON = "overlay_decks_json";
    public static final String KEY_DEFAULT_DECK = "overlay_default_deck";
    public static final String KEY_MEMBERSHIP_TIER = "overlay_membership_tier";
    public static final String KEY_AI_USAGE_JSON = "overlay_ai_usage_json";
    public static final String KEY_CHAT_SESSION_JSON = "overlay_chat_session_json";
    public static final String KEY_VIDEO_ROI_MODE = "overlay_video_roi_mode";
    public static final String KEY_VIDEO_ROI_RECT_JSON = "overlay_video_roi_rect_json";

    private static final String WORKER_FAST_REFINE_URL = "https://lzhcard.tomlin980415.workers.dev/ai/fast-refine";
    private static final String CHANNEL_ID = "lzhcard_overlay_service";
    private static final int NOTIFICATION_ID = 4901;

    private static final Pattern JA_KANA_PATTERN = Pattern.compile("[\\u3040-\\u309F\\u30A0-\\u30FF々〆ヵヶ]");
    private static final Pattern CJK_PATTERN = Pattern.compile("[\\u4E00-\\u9FFF\\u3400-\\u4DBF]");
    private static final Pattern EN_PATTERN = Pattern.compile("[A-Za-z]");

    private static volatile boolean running = false;
    private static volatile boolean appInForeground = true;
    private static volatile String pendingCapturedBase64 = null;
    private static volatile FloatingOverlayService activeInstance = null;

    private WindowManager windowManager;

    // Window 1: 懸浮球
    private WindowManager.LayoutParams bubbleParams;
    private TextView bubbleView;
    private boolean isBubbleAttached = false;

    // Window 2: 統一外觀主懸浮面板
    private WindowManager.LayoutParams panelParams;
    private FrameLayout panelContainer;
    private WebView overlayWebView;
    private boolean isPanelAttached = false;
    private boolean isWebPageLoaded = false;

    // Window 3: 全螢幕截圖定格點詞覆蓋層
    private WindowManager.LayoutParams freezeParams;
    private FrameLayout freezeContainer;
    private WebView freezeWebView;
    private boolean isFreezeAttached = false;
    private boolean isFreezePageLoaded = false;
    private String pendingFreezePayloadJson = null;

    // Window 4: 獨立可拖曳透明螢幕字幕視窗
    private WindowManager.LayoutParams subtitleParams;
    private LinearLayout subtitleContainer;
    private TextView subtitleTierView;
    private TextView subtitleOrigView;
    private TextView subtitleTransView;
    private boolean isSubtitleAttached = false;
    private boolean subtitleDesiredVisible = false;

    // TTS
    private TextToSpeech ttsEngine;
    private boolean ttsReady = false;

    // MediaProjection + VirtualDisplay + ML Kit
    private MediaProjection mediaProjection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private int captureWidth = 0;
    private int captureHeight = 0;
    private int captureDensity = 320;
    private HandlerThread captureThread;
    private Handler captureHandler;
    private final ExecutorService bgExecutor = Executors.newFixedThreadPool(3);

    private TextRecognizer latinRecognizer;
    private TextRecognizer japaneseRecognizer;
    private TextRecognizer chineseRecognizer;
    private final Map<String, Translator> translatorCache = new HashMap<>();

    // 畫面字幕掃描狀態
    private volatile boolean videoOcrActive = false;
    private volatile boolean videoOcrInFlight = false;
    private String lastRoiOrigText = "";
    private final Deque<String> recentSubtitleLines = new ArrayDeque<>();

    // 原生語音辨識與商業配額斷路器狀態
    private SpeechRecognizer speechRecognizer;
    private volatile boolean nativeSttRunning = false;
    private volatile boolean fastRefineQuotaExhausted = false;
    private String nativeSttLangTag = "en-US";
    private long lastPartialTranslateAt = 0L;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    public static boolean isRunning() {
        return running;
    }

    public static boolean hasActiveMediaProjection() {
        FloatingOverlayService inst = activeInstance;
        return inst != null && inst.mediaProjection != null;
    }

    public static void setAppForegroundState(Context ctx, boolean inForeground) {
        appInForeground = inForeground;
        if (!running || ctx == null) return;
        try {
            Intent intent = new Intent(ctx, FloatingOverlayService.class);
            intent.setAction(ACTION_FOREGROUND_STATE);
            intent.putExtra(EXTRA_IN_FOREGROUND, inForeground);
            ctx.startService(intent);
        } catch (Exception ignored) {}
    }

    public static void deliverCapturedImageBase64(Context ctx, String base64) {
        if (!TextUtils.isEmpty(base64)) {
            pendingCapturedBase64 = base64;
        }
        FloatingOverlayService inst = activeInstance;
        if (inst == null) return;
        inst.mainHandler.post(() -> {
            if (!appInForeground) {
                inst.showOverlayPanel();
                inst.flushPendingCapturedImage();
            }
        });
    }

    public static void onMediaProjectionPermissionResult(Context ctx, int resultCode, @Nullable Intent data, String purpose) {
        if (ctx == null) return;
        try {
            Intent svc = new Intent(ctx, FloatingOverlayService.class);
            svc.setAction(ACTION_MEDIA_PROJECTION_RESULT);
            svc.putExtra(EXTRA_MP_RESULT_CODE, resultCode);
            if (data != null) svc.putExtra(EXTRA_MP_DATA, data);
            svc.putExtra(EXTRA_MP_PURPOSE, purpose != null ? purpose : "freeze");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(ctx, svc);
            } else {
                ctx.startService(svc);
            }
        } catch (Exception ignored) {}
    }

    private void flushPendingCapturedImage() {
        String b64 = pendingCapturedBase64;
        if (TextUtils.isEmpty(b64) || overlayWebView == null || !isWebPageLoaded) return;
        pendingCapturedBase64 = null;
        String safe = JSONObject.quote(b64);
        overlayWebView.evaluateJavascript(
            "if(window.LZHOverlayApp && window.LZHOverlayApp.onNativeImageCaptured){window.LZHOverlayApp.onNativeImageCaptured(" + safe + ");}",
            null
        );
    }

    @Override
    public void onCreate() {
        super.onCreate();
        activeInstance = this;
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        captureThread = new HandlerThread("LZHCardScreenCapture");
        captureThread.start();
        captureHandler = new Handler(captureThread.getLooper());
        createOverlayNotificationChannel();
        initTts();
        initMlKitRecognizers();
    }

    private void initTts() {
        try {
            ttsEngine = new TextToSpeech(getApplicationContext(), status -> ttsReady = (status == TextToSpeech.SUCCESS));
        } catch (Exception ignored) {
            ttsReady = false;
        }
    }

    private void initMlKitRecognizers() {
        try {
            latinRecognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
            japaneseRecognizer = TextRecognition.getClient(new JapaneseTextRecognizerOptions.Builder().build());
            chineseRecognizer = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
        } catch (Exception ignored) {}
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            if (ACTION_STOP.equals(action)) {
                stopSelf();
                return START_NOT_STICKY;
            }
            if (ACTION_FOREGROUND_STATE.equals(action)) {
                appInForeground = intent.getBooleanExtra(EXTRA_IN_FOREGROUND, true);
                applyForegroundVisibility();
                return START_STICKY;
            }
            if (ACTION_SYNC_PREFS.equals(action)) {
                fastRefineQuotaExhausted = false;
                pushConfigToWebView();
                return START_STICKY;
            }
            if (ACTION_MEDIA_PROJECTION_RESULT.equals(action)) {
                int resultCode = intent.getIntExtra(EXTRA_MP_RESULT_CODE, Activity.RESULT_CANCELED);
                Intent data = intent.getParcelableExtra(EXTRA_MP_DATA);
                String purpose = intent.getStringExtra(EXTRA_MP_PURPOSE);
                handleMediaProjectionResult(resultCode, data, purpose);
                return START_STICKY;
            }
            if (intent.hasExtra(EXTRA_IN_FOREGROUND)) {
                appInForeground = intent.getBooleanExtra(EXTRA_IN_FOREGROUND, true);
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }

        startServiceForegroundCompat(mediaProjection != null);
        running = true;
        applyForegroundVisibility();
        return START_STICKY;
    }

    private void startServiceForegroundCompat(boolean includeMediaProjection) {
        Notification notification = buildForegroundNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            int fgsType = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
            if (includeMediaProjection) {
                fgsType |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
            }
            startForeground(NOTIFICATION_ID, notification, fgsType);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && includeMediaProjection) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void applyForegroundVisibility() {
        if (appInForeground) {
            hideOverlayPanel();
            detachBubble();
            if (!isFreezeAttached) {
                detachSubtitleOverlay();
            }
        } else {
            if (!isPanelAttached && !isFreezeAttached) {
                attachBubble();
            }
            if (subtitleDesiredVisible && !isFreezeAttached) {
                showSubtitleOverlay();
            }
        }
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value,
            getResources().getDisplayMetrics()
        );
    }

    private int getDefaultPanelHeightPx() {
        DisplayMetrics dm = getResources().getDisplayMetrics();
        return Math.min(dp(500), Math.max(dp(340), (int) (dm.heightPixels * 0.72f)));
    }

    private int getOverlayWindowType() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;
        }
        return WindowManager.LayoutParams.TYPE_PHONE;
    }

    /* ==========================================================================
       1. Window 1: 懸浮球（52dp, #4F46E5 品牌靛藍, 白邊框, 🌐 圖示）
       ========================================================================== */

    private void attachBubble() {
        if (windowManager == null || isBubbleAttached || appInForeground || isFreezeAttached) return;

        if (bubbleView == null) {
            bubbleView = new TextView(this);
            bubbleView.setText("🌐");
            bubbleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 21);
            bubbleView.setGravity(Gravity.CENTER);
            bubbleView.setElevation(dp(10));

            GradientDrawable circleBg = new GradientDrawable();
            circleBg.setShape(GradientDrawable.OVAL);
            circleBg.setColor(Color.parseColor("#4F46E5"));
            circleBg.setStroke(dp(2), Color.parseColor("#CCFFFFFF"));
            bubbleView.setBackground(circleBg);

            int size = dp(52);
            bubbleParams = new WindowManager.LayoutParams(
                size,
                size,
                getOverlayWindowType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT
            );
            bubbleParams.gravity = Gravity.TOP | Gravity.START;
            DisplayMetrics dm = getResources().getDisplayMetrics();
            bubbleParams.x = Math.max(dp(12), dm.widthPixels - size - dp(12));
            bubbleParams.y = Math.max(dp(68), (int) (dm.heightPixels * 0.65f));

            bubbleView.setOnTouchListener(new View.OnTouchListener() {
                private int initialX;
                private int initialY;
                private float initialTouchX;
                private float initialTouchY;
                private boolean moved;

                @Override
                public boolean onTouch(View v, MotionEvent event) {
                    switch (event.getActionMasked()) {
                        case MotionEvent.ACTION_DOWN:
                            initialX = bubbleParams.x;
                            initialY = bubbleParams.y;
                            initialTouchX = event.getRawX();
                            initialTouchY = event.getRawY();
                            moved = false;
                            return true;
                        case MotionEvent.ACTION_MOVE:
                            int dx = Math.round(event.getRawX() - initialTouchX);
                            int dy = Math.round(event.getRawY() - initialTouchY);
                            if (Math.hypot(dx, dy) > dp(6)) {
                                moved = true;
                            }
                            DisplayMetrics metrics = getResources().getDisplayMetrics();
                            int maxX = Math.max(0, metrics.widthPixels - size);
                            int maxY = Math.max(0, metrics.heightPixels - size);
                            bubbleParams.x = Math.max(0, Math.min(maxX, initialX + dx));
                            bubbleParams.y = Math.max(dp(24), Math.min(maxY, initialY + dy));
                            try {
                                windowManager.updateViewLayout(bubbleView, bubbleParams);
                            } catch (Exception ignored) {}
                            return true;
                        case MotionEvent.ACTION_UP:
                            if (!moved) {
                                showOverlayPanel();
                            } else {
                                DisplayMetrics metricsUp = getResources().getDisplayMetrics();
                                int mid = metricsUp.widthPixels / 2;
                                bubbleParams.x = (bubbleParams.x + size / 2 < mid)
                                    ? dp(12)
                                    : Math.max(dp(12), metricsUp.widthPixels - size - dp(12));
                                try {
                                    windowManager.updateViewLayout(bubbleView, bubbleParams);
                                } catch (Exception ignored) {}
                            }
                            return true;
                    }
                    return false;
                }
            });
        }

        try {
            windowManager.addView(bubbleView, bubbleParams);
            isBubbleAttached = true;
        } catch (Exception ignored) {}
    }

    private void detachBubble() {
        if (windowManager != null && bubbleView != null && isBubbleAttached) {
            try {
                windowManager.removeView(bubbleView);
            } catch (Exception ignored) {}
            isBubbleAttached = false;
        }
    }

    /* ==========================================================================
       2. Window 2: 展開懸浮面板（內外 UI/UX 100% 統一 + 翻譯/聊天雙模式）
       ========================================================================== */

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    private void configureOverlayWebView(WebView wv) {
        wv.setBackgroundColor(Color.TRANSPARENT);
        wv.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings ws = wv.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setAllowContentAccess(true);
        ws.setAllowUniversalAccessFromFileURLs(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        wv.addJavascriptInterface(new OverlayWebBridge(), "AndroidOverlay");
        wv.setWebChromeClient(new WebChromeClient());
    }

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    private void ensurePanelWebViewCreated() {
        if (panelContainer != null && overlayWebView != null) return;

        DisplayMetrics dm = getResources().getDisplayMetrics();
        int panelWidth = Math.min(dp(396), Math.max(dp(280), dm.widthPixels - dp(20)));
        int panelHeight = getDefaultPanelHeightPx();

        panelContainer = new FrameLayout(this);
        panelContainer.setBackgroundColor(Color.TRANSPARENT);

        overlayWebView = new WebView(getApplicationContext());
        configureOverlayWebView(overlayWebView);

        isWebPageLoaded = false;
        overlayWebView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                isWebPageLoaded = true;
                pushConfigToWebView();
                flushPendingCapturedImage();
            }
        });

        panelContainer.addView(overlayWebView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));

        panelParams = new WindowManager.LayoutParams(
            panelWidth,
            panelHeight,
            getOverlayWindowType(),
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        );
        panelParams.gravity = Gravity.TOP | Gravity.START;
        panelParams.x = Math.max(dp(10), (dm.widthPixels - panelWidth) / 2);
        panelParams.y = Math.max(dp(36), (int) (dm.heightPixels * 0.10f));
        panelParams.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;

        overlayWebView.loadUrl("file:///android_asset/public/overlay.html");
    }

    private void showOverlayPanel() {
        if (windowManager == null || appInForeground) return;
        ensurePanelWebViewCreated();
        detachBubble();
        if (!isPanelAttached && panelContainer != null) {
            try {
                if (panelParams.height < dp(260)) {
                    panelParams.height = getDefaultPanelHeightPx();
                }
                windowManager.addView(panelContainer, panelParams);
                isPanelAttached = true;
                pushConfigToWebView();
                flushPendingCapturedImage();
            } catch (Exception ignored) {}
        }
    }

    private void hideOverlayPanel() {
        if (windowManager != null && panelContainer != null && isPanelAttached) {
            try {
                windowManager.removeView(panelContainer);
            } catch (Exception ignored) {}
            isPanelAttached = false;
        }
        if (!appInForeground && running && !isFreezeAttached) {
            attachBubble();
        }
    }

    private void hidePanelWithoutReattachingBubble() {
        if (windowManager != null && panelContainer != null && isPanelAttached) {
            try {
                windowManager.removeView(panelContainer);
            } catch (Exception ignored) {}
            isPanelAttached = false;
        }
    }

    private void pushConfigToWebView() {
        String json = buildConfigJson();
        mainHandler.post(() -> {
            if (overlayWebView != null && isWebPageLoaded) {
                overlayWebView.evaluateJavascript(
                    "if(window.LZHOverlayApp && window.LZHOverlayApp.applyNativeConfig){window.LZHOverlayApp.applyNativeConfig(" + json + ");}",
                    null
                );
            }
        });
    }

    private String buildConfigJson() {
        SharedPreferences sp = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        JSONObject obj = new JSONObject();
        try {
            String themePref = sp.getString(KEY_THEME_MODE, "system");
            int nightFlags = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
            boolean systemDark = (nightFlags == Configuration.UI_MODE_NIGHT_YES);
            boolean isDark = "dark".equalsIgnoreCase(themePref) || ("system".equalsIgnoreCase(themePref) && systemDark);

            obj.put("nativeLang", sp.getString(KEY_NATIVE_LANG, "zh-TW"));
            obj.put("isDark", isDark);
            obj.put("apiMode", sp.getString(KEY_API_MODE, "shared"));
            obj.put("apiKey", sp.getString(KEY_API_KEY, ""));
            obj.put("groqApiKey", sp.getString(KEY_GROQ_API_KEY, ""));
            obj.put("decks", new JSONArray(sp.getString(KEY_DECKS_JSON, "[\"我的單字本\"]")));
            obj.put("defaultDeck", sp.getString(KEY_DEFAULT_DECK, "我的單字本"));
            obj.put("membershipTier", sp.getString(KEY_MEMBERSHIP_TIER, "free"));
            obj.put("videoRoiMode", sp.getString(KEY_VIDEO_ROI_MODE, "bottom25"));
            try {
                obj.put("videoRoiRect", new JSONObject(sp.getString(KEY_VIDEO_ROI_RECT_JSON, "{}")));
            } catch (Exception ignored) {
                obj.put("videoRoiRect", new JSONObject());
            }

            String aiUsageRaw = sp.getString(KEY_AI_USAGE_JSON, "{}");
            try {
                obj.put("aiUsage", new JSONObject(aiUsageRaw));
            } catch (Exception ignored) {
                obj.put("aiUsage", new JSONObject());
            }

            String chatRaw = sp.getString(KEY_CHAT_SESSION_JSON, "{}");
            try {
                obj.put("chatSession", new JSONObject(chatRaw));
            } catch (Exception ignored) {
                obj.put("chatSession", new JSONObject());
            }
        } catch (Exception ignored) {}
        return obj.toString();
    }

    /* ==========================================================================
       3. Window 3: 全螢幕截圖定格點詞覆蓋視窗 (overlay.html?mode=freeze)
       ========================================================================== */

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    private void ensureFreezeWebViewCreated() {
        if (freezeContainer != null && freezeWebView != null) return;

        freezeContainer = new FrameLayout(this);
        freezeContainer.setBackgroundColor(Color.parseColor("#EB020617"));

        freezeWebView = new WebView(getApplicationContext());
        configureOverlayWebView(freezeWebView);
        isFreezePageLoaded = false;

        freezeWebView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                isFreezePageLoaded = true;
                flushPendingFreezePayload();
            }
        });

        freezeContainer.addView(freezeWebView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));

        freezeParams = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            getOverlayWindowType(),
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        );
        freezeParams.gravity = Gravity.TOP | Gravity.START;
        freezeParams.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;

        freezeWebView.loadUrl("file:///android_asset/public/overlay.html?mode=freeze");
    }

    private void showFreezeWindowWithPayload(String payloadJson) {
        pendingFreezePayloadJson = payloadJson;
        mainHandler.post(() -> {
            if (windowManager == null) return;
            ensureFreezeWebViewCreated();
            detachBubble();
            hidePanelWithoutReattachingBubble();
            detachSubtitleOverlay();
            if (!isFreezeAttached && freezeContainer != null) {
                try {
                    windowManager.addView(freezeContainer, freezeParams);
                    isFreezeAttached = true;
                } catch (Exception ignored) {}
            }
            flushPendingFreezePayload();
        });
    }

    private void flushPendingFreezePayload() {
        String payload = pendingFreezePayloadJson;
        if (TextUtils.isEmpty(payload) || freezeWebView == null || !isFreezePageLoaded) return;
        pendingFreezePayloadJson = null;
        freezeWebView.evaluateJavascript(
            "if(window.LZHOverlayApp && window.LZHOverlayApp.openFreezeMode){window.LZHOverlayApp.openFreezeMode(" + payload + ");}",
            null
        );
    }

    private void hideFreezeWindow(boolean restorePanel) {
        mainHandler.post(() -> {
            if (windowManager != null && freezeContainer != null && isFreezeAttached) {
                try {
                    windowManager.removeView(freezeContainer);
                } catch (Exception ignored) {}
                isFreezeAttached = false;
            }
            if (subtitleDesiredVisible && !appInForeground) {
                showSubtitleOverlay();
            }
            if (!appInForeground && running) {
                if (restorePanel) {
                    showOverlayPanel();
                } else if (!isPanelAttached) {
                    attachBubble();
                }
            }
        });
    }

    /* ==========================================================================
       4. Window 4: 螢幕覆蓋式透明字幕視窗（獨立可拖曳 HUD）
       ========================================================================== */

    @SuppressLint("ClickableViewAccessibility")
    private void ensureSubtitleOverlayCreated() {
        if (subtitleContainer != null) return;

        DisplayMetrics dm = getResources().getDisplayMetrics();
        int widthPx = Math.min(dp(420), Math.max(dp(260), dm.widthPixels - dp(28)));

        subtitleContainer = new LinearLayout(this);
        subtitleContainer.setOrientation(LinearLayout.VERTICAL);
        subtitleContainer.setPadding(dp(12), dp(8), dp(12), dp(10));
        subtitleContainer.setElevation(dp(8));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#CC0F172A"));
        bg.setCornerRadius(dp(16));
        bg.setStroke(dp(1), Color.parseColor("#55818CF8"));
        subtitleContainer.setBackground(bg);

        LinearLayout topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);

        TextView gripView = new TextView(this);
        gripView.setText("⠿ LZH 雙語字幕");
        gripView.setTextColor(Color.parseColor("#CBD5E1"));
        gripView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10.5f);
        LinearLayout.LayoutParams gripLp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        topBar.addView(gripView, gripLp);

        subtitleTierView = new TextView(this);
        subtitleTierView.setText("⚡ 就緒");
        subtitleTierView.setTextColor(Color.parseColor("#A5B4FC"));
        subtitleTierView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f);
        subtitleTierView.setPadding(dp(6), dp(2), dp(6), dp(2));
        topBar.addView(subtitleTierView);

        TextView hideBtn = new TextView(this);
        hideBtn.setText("✕");
        hideBtn.setTextColor(Color.parseColor("#94A3B8"));
        hideBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        hideBtn.setPadding(dp(8), dp(2), dp(2), dp(2));
        hideBtn.setOnClickListener(v -> {
            subtitleDesiredVisible = false;
            detachSubtitleOverlay();
        });
        topBar.addView(hideBtn);

        subtitleContainer.addView(topBar);

        subtitleOrigView = new TextView(this);
        subtitleOrigView.setText("等待螢幕字幕或語音串流...");
        subtitleOrigView.setTextColor(Color.WHITE);
        subtitleOrigView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f);
        subtitleOrigView.setMaxLines(3);
        subtitleOrigView.setEllipsize(TextUtils.TruncateAt.END);
        subtitleOrigView.setPadding(0, dp(4), 0, dp(2));
        subtitleContainer.addView(subtitleOrigView);

        subtitleTransView = new TextView(this);
        subtitleTransView.setText("");
        subtitleTransView.setTextColor(Color.parseColor("#34D399"));
        subtitleTransView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        subtitleTransView.setMaxLines(3);
        subtitleTransView.setEllipsize(TextUtils.TruncateAt.END);
        subtitleContainer.addView(subtitleTransView);

        subtitleParams = new WindowManager.LayoutParams(
            widthPx,
            WindowManager.LayoutParams.WRAP_CONTENT,
            getOverlayWindowType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        );
        subtitleParams.gravity = Gravity.TOP | Gravity.START;
        subtitleParams.x = Math.max(dp(12), (dm.widthPixels - widthPx) / 2);
        subtitleParams.y = Math.max(dp(60), (int) (dm.heightPixels * 0.72f));

        subtitleContainer.setOnTouchListener(new View.OnTouchListener() {
            private int initialX;
            private int initialY;
            private float initialTouchX;
            private float initialTouchY;

            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        initialX = subtitleParams.x;
                        initialY = subtitleParams.y;
                        initialTouchX = event.getRawX();
                        initialTouchY = event.getRawY();
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        DisplayMetrics metrics = getResources().getDisplayMetrics();
                        int w = subtitleContainer.getWidth() > 0 ? subtitleContainer.getWidth() : subtitleParams.width;
                        int h = subtitleContainer.getHeight() > 0 ? subtitleContainer.getHeight() : dp(90);
                        int maxX = Math.max(0, metrics.widthPixels - w);
                        int maxY = Math.max(0, metrics.heightPixels - h);
                        subtitleParams.x = Math.max(0, Math.min(maxX, initialX + Math.round(event.getRawX() - initialTouchX)));
                        subtitleParams.y = Math.max(dp(24), Math.min(maxY, initialY + Math.round(event.getRawY() - initialTouchY)));
                        try {
                            windowManager.updateViewLayout(subtitleContainer, subtitleParams);
                        } catch (Exception ignored) {}
                        return true;
                }
                return false;
            }
        });
    }

    private void showSubtitleOverlay() {
        mainHandler.post(() -> {
            if (windowManager == null || isFreezeAttached || appInForeground) return;
            ensureSubtitleOverlayCreated();
            if (!isSubtitleAttached && subtitleContainer != null) {
                try {
                    windowManager.addView(subtitleContainer, subtitleParams);
                    isSubtitleAttached = true;
                } catch (Exception ignored) {}
            }
        });
    }

    private void detachSubtitleOverlay() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(this::detachSubtitleOverlay);
            return;
        }
        if (windowManager != null && subtitleContainer != null && isSubtitleAttached) {
            try {
                windowManager.removeView(subtitleContainer);
            } catch (Exception ignored) {}
            isSubtitleAttached = false;
        }
    }

    private void updateSubtitleHudText(String orig, String trans, String tierLabel) {
        mainHandler.post(() -> {
            if (!subtitleDesiredVisible) return;
            if (!isSubtitleAttached && !isFreezeAttached && !appInForeground) {
                showSubtitleOverlay();
            }
            if (subtitleOrigView != null && !TextUtils.isEmpty(orig)) {
                subtitleOrigView.setText(orig);
            }
            if (subtitleTransView != null) {
                subtitleTransView.setText(trans != null ? trans : "");
            }
            if (subtitleTierView != null && !TextUtils.isEmpty(tierLabel)) {
                subtitleTierView.setText(tierLabel);
            }
        });
    }

    /* ==========================================================================
       5. MediaProjection 權限與單張 / 連續 ROI 擷取管線
       ========================================================================== */

    private void launchMediaProjectionPermission(String purpose) {
        try {
            Intent perm = new Intent(this, ScreenCapturePermissionActivity.class);
            perm.putExtra(ScreenCapturePermissionActivity.EXTRA_PURPOSE, purpose);
            perm.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK |
                Intent.FLAG_ACTIVITY_MULTIPLE_TASK |
                Intent.FLAG_ACTIVITY_NO_ANIMATION
            );
            startActivity(perm);
        } catch (Exception e) {
            mainHandler.post(() -> Toast.makeText(this, "無法請求螢幕擷取權限", Toast.LENGTH_SHORT).show());
        }
    }

    private void handleMediaProjectionResult(int resultCode, @Nullable Intent data, String purpose) {
        if (resultCode != Activity.RESULT_OK || data == null) {
            if ("video_ocr".equals(purpose)) {
                videoOcrActive = false;
                notifyWebVideoOcrState(false);
            }
            if (!appInForeground && running) {
                showOverlayPanel();
            }
            mainHandler.post(() -> Toast.makeText(this, "已取消螢幕擷取授權", Toast.LENGTH_SHORT).show());
            return;
        }

        try {
            startServiceForegroundCompat(true);
            MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            if (mpm == null) return;

            releaseVirtualDisplayAndReaderOnly();
            if (mediaProjection != null) {
                try { mediaProjection.stop(); } catch (Exception ignored) {}
                mediaProjection = null;
            }

            mediaProjection = mpm.getMediaProjection(resultCode, data);
            if (mediaProjection == null) return;

            mediaProjection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    stopScreenCaptureResources();
                    if (videoOcrActive) {
                        videoOcrActive = false;
                        notifyWebVideoOcrState(false);
                    }
                }
            }, mainHandler);

            ensureVirtualDisplayReady();

            if ("freeze".equals(purpose)) {
                performFreezeCaptureAfterDelay();
            } else if ("video_ocr".equals(purpose)) {
                videoOcrActive = true;
                startVideoOcrLoop();
            }
        } catch (Exception e) {
            stopScreenCaptureResources();
            mainHandler.post(() -> Toast.makeText(this, "啟動螢幕擷取失敗，請重試", Toast.LENGTH_SHORT).show());
        }
    }

    private void notifyWebVideoOcrState(boolean active) {
        mainHandler.post(() -> {
            if (overlayWebView != null && isWebPageLoaded) {
                overlayWebView.evaluateJavascript(
                    "if(window.LZHOverlayApp && window.LZHOverlayApp.applyNativeConfig){window.LZHOverlayApp.applyNativeConfig({});}",
                    null
                );
            }
        });
    }

    private void ensureVirtualDisplayReady() {
        if (mediaProjection == null || windowManager == null) return;

        DisplayMetrics dm = new DisplayMetrics();
        windowManager.getDefaultDisplay().getRealMetrics(dm);
        int rawW = Math.max(1, dm.widthPixels);
        int rawH = Math.max(1, dm.heightPixels);
        float scale = Math.min(1f, 1600f / Math.max(rawW, rawH));
        int targetW = Math.max(2, Math.round(rawW * scale));
        int targetH = Math.max(2, Math.round(rawH * scale));
        if ((targetW & 1) == 1) targetW--;
        if ((targetH & 1) == 1) targetH--;

        if (virtualDisplay != null && imageReader != null && captureWidth == targetW && captureHeight == targetH) {
            return;
        }

        releaseVirtualDisplayAndReaderOnly();
        captureWidth = targetW;
        captureHeight = targetH;
        captureDensity = dm.densityDpi;

        imageReader = ImageReader.newInstance(captureWidth, captureHeight, PixelFormat.RGBA_8888, 2);
        virtualDisplay = mediaProjection.createVirtualDisplay(
            "LZHCardScreenCapture",
            captureWidth,
            captureHeight,
            captureDensity,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader.getSurface(),
            null,
            captureHandler
        );
    }

    private void releaseVirtualDisplayAndReaderOnly() {
        if (virtualDisplay != null) {
            try { virtualDisplay.release(); } catch (Exception ignored) {}
            virtualDisplay = null;
        }
        if (imageReader != null) {
            try { imageReader.close(); } catch (Exception ignored) {}
            imageReader = null;
        }
    }

    private void stopScreenCaptureResources() {
        mainHandler.removeCallbacks(videoOcrTickRunnable);
        releaseVirtualDisplayAndReaderOnly();
        if (mediaProjection != null) {
            try { mediaProjection.stop(); } catch (Exception ignored) {}
            mediaProjection = null;
        }
    }

    @Nullable
    private Bitmap acquireLatestScreenBitmap() {
        if (imageReader == null) return null;
        Image img = null;
        try {
            img = imageReader.acquireLatestImage();
            if (img == null) return null;
            int width = img.getWidth();
            int height = img.getHeight();
            Image.Plane[] planes = img.getPlanes();
            if (planes == null || planes.length == 0) return null;
            ByteBuffer buffer = planes[0].getBuffer();
            int pixelStride = planes[0].getPixelStride();
            int rowStride = planes[0].getRowStride();
            int rowPadding = rowStride - pixelStride * width;
            int bmpWidth = width + (pixelStride > 0 ? rowPadding / pixelStride : 0);

            Bitmap rawBmp = Bitmap.createBitmap(bmpWidth, height, Bitmap.Config.ARGB_8888);
            rawBmp.copyPixelsFromBuffer(buffer);
            if (bmpWidth == width) {
                return rawBmp;
            }
            Bitmap cropped = Bitmap.createBitmap(rawBmp, 0, 0, width, height);
            rawBmp.recycle();
            return cropped;
        } catch (Exception e) {
            return null;
        } finally {
            if (img != null) {
                try { img.close(); } catch (Exception ignored) {}
            }
        }
    }

    private void drainImageReaderQueue() {
        if (imageReader == null) return;
        try {
            Image stale = imageReader.acquireLatestImage();
            if (stale != null) stale.close();
        } catch (Exception ignored) {}
    }

    /* ==========================================================================
       6. 全螢幕截圖定格點詞流程（隱藏浮窗 -> 延遲 120ms -> 截圖 -> ML Kit OCR）
       ========================================================================== */

    private void performFreezeCaptureAfterDelay() {
        mainHandler.post(() -> {
            hidePanelWithoutReattachingBubble();
            detachBubble();
            detachSubtitleOverlay();

            if (mediaProjection == null) {
                launchMediaProjectionPermission("freeze");
                return;
            }

            ensureVirtualDisplayReady();

            mainHandler.postDelayed(() -> captureFreezeBitmapWithRetry(0), 140);
        });
    }

    private void captureFreezeBitmapWithRetry(int attempt) {
        captureHandler.post(() -> {
            Bitmap bmp = acquireLatestScreenBitmap();
            if (bmp == null && attempt < 5) {
                captureHandler.postDelayed(() -> captureFreezeBitmapWithRetry(attempt + 1), 65);
                return;
            }
            if (bmp == null) {
                mainHandler.post(() -> {
                    Toast.makeText(this, "螢幕畫面尚未就緒，請再試一次", Toast.LENGTH_SHORT).show();
                    if (!appInForeground) showOverlayPanel();
                });
                return;
            }
            processFreezeBitmapWithMlKit(bmp);
        });
    }

    private void processFreezeBitmapWithMlKit(Bitmap bmp) {
        final int bmpW = Math.max(1, bmp.getWidth());
        final int bmpH = Math.max(1, bmp.getHeight());
        final InputImage inputImage = InputImage.fromBitmap(bmp, 0);

        List<Task<Text>> tasks = new ArrayList<>();
        if (japaneseRecognizer != null) tasks.add(japaneseRecognizer.process(inputImage));
        if (chineseRecognizer != null) tasks.add(chineseRecognizer.process(inputImage));
        if (latinRecognizer != null) tasks.add(latinRecognizer.process(inputImage));

        if (tasks.isEmpty()) {
            bmp.recycle();
            mainHandler.post(() -> {
                if (!appInForeground) showOverlayPanel();
            });
            return;
        }

        Tasks.whenAllComplete(tasks).addOnCompleteListener(bgExecutor, done -> {
            try {
                List<TokenBox> tokens = new ArrayList<>();
                for (Task<Text> t : tasks) {
                    if (!t.isSuccessful() || t.getResult() == null) continue;
                    extractTokensFromMlKitResult(t.getResult(), bmpW, bmpH, tokens);
                }

                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                bmp.compress(Bitmap.CompressFormat.JPEG, 92, baos);
                String b64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
                bmp.recycle();

                SharedPreferences sp = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                int nightFlags = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
                boolean systemDark = (nightFlags == Configuration.UI_MODE_NIGHT_YES);
                String themePref = sp.getString(KEY_THEME_MODE, "system");
                boolean isDark = "dark".equalsIgnoreCase(themePref) || ("system".equalsIgnoreCase(themePref) && systemDark);

                JSONArray tokArr = new JSONArray();
                int limit = Math.min(tokens.size(), 600);
                for (int i = 0; i < limit; i++) {
                    TokenBox tb = tokens.get(i);
                    JSONObject o = new JSONObject();
                    o.put("text", tb.text);
                    o.put("lang", tb.lang);
                    JSONArray normBox = new JSONArray();
                    normBox.put(tb.ymin);
                    normBox.put(tb.xmin);
                    normBox.put(tb.ymax);
                    normBox.put(tb.xmax);
                    o.put("box", normBox);
                    tokArr.put(o);
                }

                JSONObject payload = new JSONObject();
                payload.put("imageBase64", b64);
                payload.put("tokens", tokArr);
                payload.put("decks", new JSONArray(sp.getString(KEY_DECKS_JSON, "[\"我的單字本\"]")));
                payload.put("defaultDeck", sp.getString(KEY_DEFAULT_DECK, "我的單字本"));
                payload.put("nativeLang", sp.getString(KEY_NATIVE_LANG, "zh-TW"));
                payload.put("isDark", isDark);

                showFreezeWindowWithPayload(payload.toString());
            } catch (Exception e) {
                bmp.recycle();
                mainHandler.post(() -> {
                    Toast.makeText(this, "定格辨識失敗，請再試一次", Toast.LENGTH_SHORT).show();
                    if (!appInForeground) showOverlayPanel();
                });
            }
        });
    }

    private static class TokenBox {
        final String text;
        final String lang;
        final int ymin;
        final int xmin;
        final int ymax;
        final int xmax;

        TokenBox(String text, String lang, int ymin, int xmin, int ymax, int xmax) {
            this.text = text;
            this.lang = lang;
            this.ymin = ymin;
            this.xmin = xmin;
            this.ymax = ymax;
            this.xmax = xmax;
        }
    }

    private void extractTokensFromMlKitResult(Text result, int imgW, int imgH, List<TokenBox> dest) {
        if (result == null) return;
        for (Text.TextBlock block : result.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                for (Text.Element el : line.getElements()) {
                    String raw = el.getText() != null ? el.getText().trim() : "";
                    if (raw.isEmpty()) continue;
                    String cleaned = raw.replaceAll("^[\\p{Punct}\\s]+|[\\p{Punct}\\s]+$", "");
                    if (cleaned.isEmpty()) continue;
                    Rect r = el.getBoundingBox();
                    if (r == null || r.width() <= 0 || r.height() <= 0) continue;

                    int ymin = Math.max(0, Math.min(990, Math.round(r.top * 1000f / imgH)));
                    int xmin = Math.max(0, Math.min(990, Math.round(r.left * 1000f / imgW)));
                    int ymax = Math.max(ymin + 8, Math.min(1000, Math.round(r.bottom * 1000f / imgH)));
                    int xmax = Math.max(xmin + 8, Math.min(1000, Math.round(r.right * 1000f / imgW)));

                    if (isDuplicateBox(dest, cleaned, ymin, xmin, ymax, xmax)) continue;
                    dest.add(new TokenBox(cleaned, detectLanguageCode(cleaned), ymin, xmin, ymax, xmax));
                }
            }
        }
    }

    private boolean isDuplicateBox(List<TokenBox> list, String txt, int ymin, int xmin, int ymax, int xmax) {
        for (TokenBox t : list) {
            int interTop = Math.max(t.ymin, ymin);
            int interLeft = Math.max(t.xmin, xmin);
            int interBottom = Math.min(t.ymax, ymax);
            int interRight = Math.min(t.xmax, xmax);
            if (interRight <= interLeft || interBottom <= interTop) continue;
            float interArea = (interRight - interLeft) * (float) (interBottom - interTop);
            float areaA = Math.max(1f, (t.xmax - t.xmin) * (float) (t.ymax - t.ymin));
            float areaB = Math.max(1f, (xmax - xmin) * (float) (ymax - ymin));
            float iou = interArea / (areaA + areaB - interArea);
            if (iou > 0.55f && (t.text.equalsIgnoreCase(txt) || t.text.length() >= txt.length())) {
                return true;
            }
        }
        return false;
    }

    /* ==========================================================================
       7. 連續螢幕底部 ROI 即時翻譯（ML Kit + 本地去重 + 三段式極速譯與精修）
       ========================================================================== */

    private final Runnable videoOcrTickRunnable = new Runnable() {
        @Override
        public void run() {
            if (!videoOcrActive) return;
            if (!videoOcrInFlight && mediaProjection != null && !isFreezeAttached) {
                runSingleVideoRoiOcrPass();
            }
            if (videoOcrActive) {
                mainHandler.postDelayed(this, 250);
            }
        }
    };

    private void startVideoOcrLoop() {
        mainHandler.removeCallbacks(videoOcrTickRunnable);
        if (videoOcrActive) {
            ensureVirtualDisplayReady();
            mainHandler.postDelayed(videoOcrTickRunnable, 150);
        }
    }

    private Rect resolveVideoRoiRect(Bitmap fullBmp, String roiMode, String rectJsonStr) {
        int w = Math.max(1, fullBmp.getWidth());
        int h = Math.max(1, fullBmp.getHeight());
        String mode = roiMode != null ? roiMode.trim().toLowerCase(Locale.ROOT) : "bottom25";

        double xPct = 0.0;
        double yPct = 0.72;
        double wPct = 1.0;
        double hPct = 0.26;

        if ("bottom40".equals(mode)) {
            yPct = 0.58;
            hPct = 0.40;
        } else if ("top25".equals(mode)) {
            yPct = 0.02;
            hPct = 0.25;
        } else if ("full".equals(mode)) {
            yPct = 0.0;
            hPct = 1.0;
        } else if ("custom".equals(mode)) {
            try {
                JSONObject rc = new JSONObject(TextUtils.isEmpty(rectJsonStr) ? "{}" : rectJsonStr);
                xPct = Math.max(0.0, Math.min(0.85, rc.optDouble("xPct", 0.05)));
                yPct = Math.max(0.0, Math.min(0.85, rc.optDouble("yPct", 0.72)));
                wPct = Math.max(0.15, Math.min(1.0 - xPct, rc.optDouble("wPct", 0.90)));
                hPct = Math.max(0.10, Math.min(1.0 - yPct, rc.optDouble("hPct", 0.26)));
            } catch (Exception ignored) {}
        } else if ("auto".equals(mode)) {
            // 自動掃描四個垂直區域水平邊緣梯度密度，自動定位高對比字幕帶
            double[][] bands = {
                {0.02, 0.24},
                {0.26, 0.24},
                {0.50, 0.24},
                {0.72, 0.26}
            };
            double bestScore = -1.0;
            int bestIdx = 3;
            for (int b = 0; b < bands.length; b++) {
                int sy = Math.max(0, (int) Math.round(h * bands[b][0]));
                int ey = Math.min(h - 1, (int) Math.round(h * (bands[b][0] + bands[b][1])));
                long edgeSum = 0L;
                int count = 0;
                int stepY = Math.max(4, (ey - sy) / 14);
                int stepX = Math.max(8, w / 36);
                for (int py = sy; py < ey; py += stepY) {
                    int prevLum = -1;
                    for (int px = Math.round(w * 0.08f); px < Math.round(w * 0.92f); px += stepX) {
                        int c = fullBmp.getPixel(px, py);
                        int lum = (((c >> 16) & 0xFF) * 299 + ((c >> 8) & 0xFF) * 587 + (c & 0xFF) * 114) / 1000;
                        if (prevLum >= 0) {
                            int diff = Math.abs(lum - prevLum);
                            if (diff > 28) edgeSum += diff;
                        }
                        prevLum = lum;
                        count++;
                    }
                }
                double avgScore = count > 0 ? (double) edgeSum / count : 0.0;
                if (b == 3) avgScore *= 1.15; // 優先微幅加權底部常見字幕區
                if (avgScore > bestScore) {
                    bestScore = avgScore;
                    bestIdx = b;
                }
            }
            yPct = bands[bestIdx][0];
            hPct = bands[bestIdx][1];
        }

        int rx = Math.max(0, Math.min(w - 20, (int) Math.round(w * xPct)));
        int ry = Math.max(0, Math.min(h - 20, (int) Math.round(h * yPct)));
        int rw = Math.max(20, Math.min(w - rx, (int) Math.round(w * wPct)));
        int rh = Math.max(20, Math.min(h - ry, (int) Math.round(h * hPct)));
        return new Rect(rx, ry, rx + rw, ry + rh);
    }

    private void runSingleVideoRoiOcrPass() {
        videoOcrInFlight = true;
        captureHandler.post(() -> {
            Bitmap fullBmp = acquireLatestScreenBitmap();
            if (fullBmp == null) {
                videoOcrInFlight = false;
                return;
            }
            Bitmap roiBmp = null;
            try {
                SharedPreferences sp = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String roiMode = sp.getString(KEY_VIDEO_ROI_MODE, "bottom25");
                String roiRectJson = sp.getString(KEY_VIDEO_ROI_RECT_JSON, "{}");
                Rect roi = resolveVideoRoiRect(fullBmp, roiMode, roiRectJson);
                roiBmp = Bitmap.createBitmap(fullBmp, roi.left, roi.top, roi.width(), roi.height());
                fullBmp.recycle();

                InputImage roiImg = InputImage.fromBitmap(roiBmp, 0);
                List<Task<Text>> tasks = new ArrayList<>();
                if (japaneseRecognizer != null) tasks.add(japaneseRecognizer.process(roiImg));
                if (chineseRecognizer != null) tasks.add(chineseRecognizer.process(roiImg));
                if (latinRecognizer != null && tasks.isEmpty()) tasks.add(latinRecognizer.process(roiImg));

                if (tasks.isEmpty()) {
                    roiBmp.recycle();
                    videoOcrInFlight = false;
                    return;
                }
                final Bitmap toRecycle = roiBmp;
                Tasks.whenAllComplete(tasks).addOnCompleteListener(bgExecutor, done -> {
                    try { toRecycle.recycle(); } catch (Exception ignored) {}
                    videoOcrInFlight = false;
                    String bestText = "";
                    for (Task<Text> t : tasks) {
                        if (!t.isSuccessful() || t.getResult() == null) continue;
                        String cand = t.getResult().getText() != null ? t.getResult().getText().replaceAll("\\s+", " ").trim() : "";
                        if (cand.length() > bestText.length()) {
                            bestText = cand;
                        }
                    }
                    handleRoiOcrText(bestText);
                });
            } catch (Exception e) {
                try { fullBmp.recycle(); } catch (Exception ignored) {}
                if (roiBmp != null) { try { roiBmp.recycle(); } catch (Exception ignored) {} }
                videoOcrInFlight = false;
            }
        });
    }

    private void handleRoiOcrText(String rawText) {
        if (!videoOcrActive || TextUtils.isEmpty(rawText)) return;
        String clean = rawText.replaceAll("\\s+", " ").trim();
        if (clean.length() < 3 || clean.length() > 220) return;

        double sim = computeCharacterSimilarity(lastRoiOrigText, clean);
        if (sim >= 0.85d) return;

        lastRoiOrigText = clean;
        String srcLang = detectLanguageCode(clean);
        recordRecentContextLine(clean);

        runTwoTierSubtitleTranslation(clean, srcLang, false);
    }

    private double computeCharacterSimilarity(String a, String b) {
        if (TextUtils.isEmpty(a) || TextUtils.isEmpty(b)) return 0d;
        String na = a.toLowerCase(Locale.ROOT).replaceAll("\\s+", "");
        String nb = b.toLowerCase(Locale.ROOT).replaceAll("\\s+", "");
        if (na.equals(nb)) return 1d;
        int lenA = na.length();
        int lenB = nb.length();
        int maxLen = Math.max(lenA, lenB);
        if (maxLen == 0) return 1d;
        if (Math.abs(lenA - lenB) > maxLen * 0.4d) return 0d;

        int[][] dpArr = new int[lenA + 1][lenB + 1];
        for (int i = 0; i <= lenA; i++) dpArr[i][0] = i;
        for (int j = 0; j <= lenB; j++) dpArr[0][j] = j;
        for (int i = 1; i <= lenA; i++) {
            char ca = na.charAt(i - 1);
            for (int j = 1; j <= lenB; j++) {
                int cost = (ca == nb.charAt(j - 1)) ? 0 : 1;
                dpArr[i][j] = Math.min(
                    Math.min(dpArr[i - 1][j] + 1, dpArr[i][j - 1] + 1),
                    dpArr[i - 1][j - 1] + cost
                );
            }
        }
        return 1d - (dpArr[lenA][lenB] / (double) maxLen);
    }

    private void recordRecentContextLine(String line) {
        synchronized (recentSubtitleLines) {
            if (!line.equals(recentSubtitleLines.peekLast())) {
                recentSubtitleLines.addLast(line);
                while (recentSubtitleLines.size() > 3) {
                    recentSubtitleLines.removeFirst();
                }
            }
        }
    }

    /* ==========================================================================
       8. 原生 Android SpeechRecognizer 連續語音串流（Partial -> 2-Tier）
       ========================================================================== */

    private void startSpeechRecognizerSession() {
        mainHandler.post(() -> {
            if (!nativeSttRunning) return;
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                nativeSttRunning = false;
                Toast.makeText(this, "請先在 LZHCard 允許麥克風錄音權限", Toast.LENGTH_LONG).show();
                return;
            }
            if (!SpeechRecognizer.isRecognitionAvailable(this)) {
                nativeSttRunning = false;
                Toast.makeText(this, "此裝置不支援原生離線/串流語音辨識", Toast.LENGTH_SHORT).show();
                return;
            }

            destroySpeechRecognizerOnly();
            speechRecognizer = SpeechRecognizer.createSpeechRecognizer(this);
            speechRecognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) {}
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rmsdB) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onEvent(int eventType, Bundle params) {}

                @Override
                public void onPartialResults(Bundle partialResults) {
                    if (!nativeSttRunning || partialResults == null) return;
                    ArrayList<String> list = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (list == null || list.isEmpty()) return;
                    String partial = list.get(0) != null ? list.get(0).trim() : "";
                    if (partial.isEmpty()) return;

                    long now = System.currentTimeMillis();
                    if (now - lastPartialTranslateAt > 360) {
                        lastPartialTranslateAt = now;
                        String srcLang = detectLanguageCode(partial);
                        translateWithMlKitOffline(partial, srcLang, draft -> {
                            updateSubtitleHudText(partial, draft, "⚡ 語音");
                            pushSubtitleUpdateToWebView(partial, draft, false, "draft", srcLang);
                        });
                    } else {
                        updateSubtitleHudText(partial, null, "🎙️ 串流");
                    }
                }

                @Override
                public void onResults(Bundle results) {
                    if (!nativeSttRunning) return;
                    if (results != null) {
                        ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        if (list != null && !list.isEmpty()) {
                            String fin = list.get(0) != null ? list.get(0).trim() : "";
                            if (!fin.isEmpty()) {
                                String srcLang = detectLanguageCode(fin);
                                recordRecentContextLine(fin);
                                runTwoTierSubtitleTranslation(fin, srcLang, true);
                            }
                        }
                    }
                    if (nativeSttRunning) {
                        mainHandler.postDelayed(() -> startSpeechRecognizerSession(), 120);
                    }
                }

                @Override
                public void onError(int error) {
                    if (!nativeSttRunning) return;
                    if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                        nativeSttRunning = false;
                        Toast.makeText(FloatingOverlayService.this, "缺少麥克風權限，已停止語音字幕", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    int delay = (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) ? 450 : 250;
                    mainHandler.postDelayed(() -> startSpeechRecognizerSession(), delay);
                }
            });

            Intent recIntent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            recIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            recIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, nativeSttLangTag);
            recIntent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            recIntent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            try {
                speechRecognizer.startListening(recIntent);
            } catch (Exception e) {
                nativeSttRunning = false;
            }
        });
    }

    private void destroySpeechRecognizerOnly() {
        if (speechRecognizer != null) {
            try {
                speechRecognizer.cancel();
                speechRecognizer.destroy();
            } catch (Exception ignored) {}
            speechRecognizer = null;
        }
    }

    /* ==========================================================================
       9. 三段式翻譯引擎：Tier-1 裝置端 ML Kit 離線譯 -> Tier-2 Worker 極速精修
       ========================================================================== */

    private interface TranslationCallback {
        void onResult(String translated);
    }

    private String detectLanguageCode(String text) {
        if (TextUtils.isEmpty(text)) return "en";
        if (JA_KANA_PATTERN.matcher(text).find()) return "ja";
        if (CJK_PATTERN.matcher(text).find()) return "zh-TW";
        if (EN_PATTERN.matcher(text).find()) return "en";
        return "en";
    }

    private String toMlKitLanguage(String langCode) {
        if ("ja".equalsIgnoreCase(langCode)) return TranslateLanguage.JAPANESE;
        if (langCode != null && langCode.toLowerCase(Locale.ROOT).startsWith("zh")) return TranslateLanguage.CHINESE;
        return TranslateLanguage.ENGLISH;
    }

    private void translateWithMlKitOffline(String text, String srcLang, TranslationCallback cb) {
        if (TextUtils.isEmpty(text)) {
            cb.onResult("");
            return;
        }
        String nativeLang = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString(KEY_NATIVE_LANG, "zh-TW");
        String mlSrc = toMlKitLanguage(srcLang);
        String mlDst = toMlKitLanguage(nativeLang);
        if (mlSrc.equals(mlDst)) {
            cb.onResult(text);
            return;
        }

        String cacheKey = mlSrc + "->" + mlDst;
        Translator translator;
        synchronized (translatorCache) {
            translator = translatorCache.get(cacheKey);
            if (translator == null) {
                TranslatorOptions opts = new TranslatorOptions.Builder()
                    .setSourceLanguage(mlSrc)
                    .setTargetLanguage(mlDst)
                    .build();
                translator = Translation.getClient(opts);
                translatorCache.put(cacheKey, translator);
            }
        }

        final Translator finalTranslator = translator;
        finalTranslator.downloadModelIfNeeded(new DownloadConditions.Builder().build())
            .addOnSuccessListener(bgExecutor, v -> finalTranslator.translate(text)
                .addOnSuccessListener(bgExecutor, cb::onResult)
                .addOnFailureListener(bgExecutor, e -> cb.onResult("")))
            .addOnFailureListener(bgExecutor, e -> cb.onResult(""));
    }

    private boolean isPaidOrPersonalFastRefineEligible() {
        SharedPreferences sp = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String apiKey = sp.getString(KEY_API_KEY, "").trim();
        String groqKey = sp.getString(KEY_GROQ_API_KEY, "").trim();
        if (!TextUtils.isEmpty(groqKey) || !TextUtils.isEmpty(apiKey)) {
            return true;
        }
        String tier = sp.getString(KEY_MEMBERSHIP_TIER, "free");
        boolean hasExtraCredit = false;
        try {
            JSONObject usageObj = new JSONObject(sp.getString(KEY_AI_USAGE_JSON, "{}"));
            JSONObject credits = usageObj.optJSONObject("credits");
            if (credits != null && credits.optInt("fast_refine", 0) > 0) {
                hasExtraCredit = true;
            }
        } catch (Exception ignored) {}
        return (!"free".equalsIgnoreCase(tier) || hasExtraCredit) && !fastRefineQuotaExhausted;
    }

    private String callDirectByokFastRefineSync(
        String text,
        String draft,
        String targetLangName,
        List<String> contextLines
    ) {
        SharedPreferences sp = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String groqKey = sp.getString(KEY_GROQ_API_KEY, "").trim();
        String geminiKey = sp.getString(KEY_API_KEY, "").trim();

        StringBuilder ctxBlock = new StringBuilder();
        if (contextLines != null && !contextLines.isEmpty()) {
            ctxBlock.append("Prior context:\n");
            for (String l : contextLines) {
                if (!TextUtils.isEmpty(l)) ctxBlock.append(l).append("\n");
            }
            ctxBlock.append("\n");
        }
        String draftHint = !TextUtils.isEmpty(draft) ? ("Draft translation: " + draft + "\n") : "";
        String sysPrompt = "You are a low-latency subtitle interpreter. Translate the current subtitle naturally into " + targetLangName + ". Output ONLY the final translated subtitle string with zero quotes or markdown.";
        String userPrompt = ctxBlock.toString() + draftHint + "Subtitle:\n" + text;

        if (!TextUtils.isEmpty(groqKey)) {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL("https://api.groq.com/openai/v1/chat/completions").openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(4500);
                conn.setReadTimeout(6500);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                conn.setRequestProperty("Authorization", "Bearer " + groqKey);

                JSONObject body = new JSONObject();
                body.put("model", "llama-3.1-8b-instant");
                body.put("temperature", 0.2);
                body.put("max_tokens", 200);
                JSONArray msgs = new JSONArray();
                msgs.put(new JSONObject().put("role", "system").put("content", sysPrompt));
                msgs.put(new JSONObject().put("role", "user").put("content", userPrompt));
                body.put("messages", msgs);

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                if (conn.getResponseCode() >= 200 && conn.getResponseCode() < 300) {
                    BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = br.readLine()) != null) sb.append(line);
                    JSONObject json = new JSONObject(sb.toString());
                    String out = json.optJSONArray("choices").getJSONObject(0).getJSONObject("message").optString("content", "").trim();
                    out = out.replaceAll("<think>[\\s\\S]*?</think>", "").replaceAll("^[\"「『]|[\"」』]$", "").trim();
                    if (!TextUtils.isEmpty(out)) return out;
                }
            } catch (Exception ignored) {
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        if (!TextUtils.isEmpty(geminiKey)) {
            HttpURLConnection conn = null;
            try {
                String urlStr = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=" + Uri.encode(geminiKey);
                conn = (HttpURLConnection) new URL(urlStr).openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(4500);
                conn.setReadTimeout(6500);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");

                JSONObject part = new JSONObject().put("text", sysPrompt + "\n\n" + userPrompt);
                JSONArray parts = new JSONArray().put(part);
                JSONArray contents = new JSONArray().put(new JSONObject().put("parts", parts));
                JSONObject body = new JSONObject().put("contents", contents);

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                if (conn.getResponseCode() >= 200 && conn.getResponseCode() < 300) {
                    BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = br.readLine()) != null) sb.append(line);
                    JSONObject json = new JSONObject(sb.toString());
                    String out = json.optJSONArray("candidates").getJSONObject(0).getJSONObject("content").getJSONArray("parts").getJSONObject(0).optString("text", "").trim();
                    out = out.replaceAll("<think>[\\s\\S]*?</think>", "").replaceAll("^[\"「『]|[\"」』]$", "").trim();
                    if (!TextUtils.isEmpty(out)) return out;
                }
            } catch (Exception ignored) {
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        return "";
    }

    private void runTwoTierSubtitleTranslation(String orig, String srcLang, boolean emitFinalImmediatelyIfNeeded) {
        SharedPreferences sp = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String nativeLang = sp.getString(KEY_NATIVE_LANG, "zh-TW");
        String targetLangName = "ja".equals(nativeLang)
            ? "Japanese (日本語)"
            : ("en".equals(nativeLang) ? "English" : "Traditional Chinese (繁體中文)");

        List<String> ctxSnapshot;
        synchronized (recentSubtitleLines) {
            ctxSnapshot = new ArrayList<>(recentSubtitleLines);
        }

        translateWithMlKitOffline(orig, srcLang, draft -> {
            if (!TextUtils.isEmpty(draft)) {
                updateSubtitleHudText(orig, draft, "⚡ 極速");
                pushSubtitleUpdateToWebView(orig, draft, false, "draft", srcLang);
            } else if (!emitFinalImmediatelyIfNeeded) {
                updateSubtitleHudText(orig, "...", "⏳ 翻譯");
            }

            if (!isPaidOrPersonalFastRefineEligible()) {
                pushSubtitleUpdateToWebView(orig, !TextUtils.isEmpty(draft) ? draft : "", true, "draft", srcLang);
                return;
            }

            bgExecutor.execute(() -> {
                String refined = callDirectByokFastRefineSync(orig, draft, targetLangName, ctxSnapshot);
                if (TextUtils.isEmpty(refined)) {
                    refined = callWorkerFastRefineSync(orig, draft, srcLang, nativeLang, targetLangName, ctxSnapshot);
                }
                if (!TextUtils.isEmpty(refined)) {
                    updateSubtitleHudText(orig, refined, "✨ 精修");
                    pushSubtitleUpdateToWebView(orig, refined, true, "refined", srcLang);
                } else if (!TextUtils.isEmpty(draft)) {
                    pushSubtitleUpdateToWebView(orig, draft, true, "draft", srcLang);
                } else {
                    pushSubtitleUpdateToWebView(orig, "", true, "draft", srcLang);
                }
            });
        });
    }

    private String callWorkerFastRefineSync(
        String text,
        String draft,
        String sourceLang,
        String targetLang,
        String targetLangName,
        List<String> contextLines
    ) {
        HttpURLConnection conn = null;
        try {
            SharedPreferences sp = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            String apiMode = sp.getString(KEY_API_MODE, "shared");
            String apiKey = sp.getString(KEY_API_KEY, "").trim();
            String idToken = "";
            try {
                JSONObject chatJson = new JSONObject(sp.getString(KEY_CHAT_SESSION_JSON, "{}"));
                idToken = chatJson.optString("idToken", "").trim();
            } catch (Exception ignored) {}

            URL url = new URL(WORKER_FAST_REFINE_URL);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(4500);
            conn.setReadTimeout(6500);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            conn.setRequestProperty("X-AI-Feature", "fast_refine");
            conn.setRequestProperty("X-Client-Platform", "android-overlay");
            if (!TextUtils.isEmpty(idToken)) {
                conn.setRequestProperty("Authorization", "Bearer " + idToken);
            }
            if ("personal".equalsIgnoreCase(apiMode) && !TextUtils.isEmpty(apiKey)) {
                conn.setRequestProperty("X-User-Api-Key", apiKey);
            }

            JSONObject body = new JSONObject();
            body.put("text", text);
            body.put("draftTranslation", draft != null ? draft : "");
            body.put("sourceLang", sourceLang);
            body.put("targetLang", targetLang);
            body.put("targetLangName", targetLangName);
            body.put("feature", "fast_refine");
            JSONArray ctxArr = new JSONArray();
            for (String line : contextLines) ctxArr.put(line);
            body.put("contextLines", ctxArr);

            byte[] outBytes = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(outBytes);
            }

            int code = conn.getResponseCode();
            if (code == 429) {
                fastRefineQuotaExhausted = true;
                return "";
            }
            if (code < 200 || code >= 300) return "";
            InputStream is = conn.getInputStream();
            BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
            JSONObject respJson = new JSONObject(sb.toString());
            return respJson.optString("translation", "").trim();
        } catch (Exception e) {
            return "";
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void pushSubtitleUpdateToWebView(String orig, String trans, boolean isFinal, String tier, String lang) {
        mainHandler.post(() -> {
            if (overlayWebView == null || !isWebPageLoaded) return;
            String js = "if(window.LZHOverlayApp && window.LZHOverlayApp.onNativeSubtitleUpdate){"
                + "window.LZHOverlayApp.onNativeSubtitleUpdate("
                + JSONObject.quote(orig != null ? orig : "") + ","
                + JSONObject.quote(trans != null ? trans : "") + ","
                + isFinal + ","
                + JSONObject.quote(tier != null ? tier : "refined") + ","
                + JSONObject.quote(lang != null ? lang : "")
                + ");}";
            overlayWebView.evaluateJavascript(js, null);
        });
    }

    /* ==========================================================================
       10. JS <-> Android 原生橋接介面 (window.AndroidOverlay)
       ========================================================================== */

    private class OverlayWebBridge {

        @JavascriptInterface
        public String getInitialConfig() {
            return buildConfigJson();
        }

        @JavascriptInterface
        public void updatePanelHeight(int cssHeight) {
            mainHandler.post(() -> {
                if (windowManager == null || panelContainer == null || !isPanelAttached || panelParams == null) return;
                DisplayMetrics dm = getResources().getDisplayMetrics();
                int targetPx = Math.round(cssHeight * dm.density);
                int minH = dp(240);
                int maxH = Math.max(dp(340), (int) (dm.heightPixels * 0.84f));
                int clampedH = Math.max(minH, Math.min(maxH, targetPx));
                if (Math.abs(panelParams.height - clampedH) < dp(3)) return;

                panelParams.height = clampedH;
                int maxY = Math.max(dp(20), dm.heightPixels - clampedH - dp(16));
                if (panelParams.y > maxY) {
                    panelParams.y = maxY;
                }
                try {
                    windowManager.updateViewLayout(panelContainer, panelParams);
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void collapsePanel() {
            mainHandler.post(FloatingOverlayService.this::hideOverlayPanel);
        }

        @JavascriptInterface
        public void stopOverlayService() {
            mainHandler.post(() -> {
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().clear().apply();
                stopSelf();
            });
        }

        @JavascriptInterface
        public void movePanelBy(int dxPx, int dyPx) {
            mainHandler.post(() -> {
                if (windowManager == null || panelContainer == null || !isPanelAttached) return;
                DisplayMetrics dm = getResources().getDisplayMetrics();
                int w = panelContainer.getWidth() > 0 ? panelContainer.getWidth() : panelParams.width;
                int h = panelContainer.getHeight() > 0 ? panelContainer.getHeight() : panelParams.height;
                int maxX = Math.max(dp(6), dm.widthPixels - w - dp(6));
                int maxY = Math.max(dp(20), dm.heightPixels - h - dp(16));
                panelParams.x = Math.max(dp(6), Math.min(maxX, panelParams.x + dxPx));
                panelParams.y = Math.max(dp(20), Math.min(maxY, panelParams.y + dyPx));
                try {
                    windowManager.updateViewLayout(panelContainer, panelParams);
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public String readClipboard() {
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) {
                    CharSequence cs = cm.getPrimaryClip().getItemAt(0).coerceToText(FloatingOverlayService.this);
                    return cs != null ? cs.toString().trim() : "";
                }
            } catch (Exception ignored) {}
            return "";
        }

        @JavascriptInterface
        public void speakText(String text, String lang) {
            mainHandler.post(() -> {
                if (!ttsReady || ttsEngine == null || TextUtils.isEmpty(text)) return;
                Locale loc = "ja".equals(lang) ? Locale.JAPAN : ("zh-TW".equals(lang) ? Locale.TRADITIONAL_CHINESE : Locale.US);
                ttsEngine.setLanguage(loc);
                ttsEngine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "lzh_overlay_tts");
            });
        }

        @JavascriptInterface
        public void saveNativeLang(String lang) {
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putString(KEY_NATIVE_LANG, lang).apply();
        }

        @JavascriptInterface
        public void queueCardsForApp(String cardsJsonArrayStr, String targetDeck) {
            try {
                SharedPreferences sp = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                JSONArray existing = new JSONArray(sp.getString(KEY_PENDING_CARDS, "[]"));
                JSONArray incoming = new JSONArray(cardsJsonArrayStr);
                for (int i = 0; i < incoming.length(); i++) {
                    JSONObject card = incoming.getJSONObject(i);
                    if (!TextUtils.isEmpty(targetDeck)) {
                        card.put("targetDeck", targetDeck);
                    }
                    existing.put(card);
                }
                JSONArray decks = new JSONArray(sp.getString(KEY_DECKS_JSON, "[\"我的單字本\"]"));
                if (!TextUtils.isEmpty(targetDeck)) {
                    boolean found = false;
                    for (int i = 0; i < decks.length(); i++) {
                        if (targetDeck.equals(decks.optString(i))) {
                            found = true;
                            break;
                        }
                    }
                    if (!found) decks.put(targetDeck);
                }
                sp.edit()
                    .putString(KEY_PENDING_CARDS, existing.toString())
                    .putString(KEY_DECKS_JSON, decks.toString())
                    .putString(KEY_DEFAULT_DECK, targetDeck)
                    .apply();
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void openImagePicker(boolean useCamera) {
            mainHandler.post(() -> {
                hidePanelWithoutReattachingBubble();
                detachBubble();
                try {
                    Intent picker = new Intent(FloatingOverlayService.this, OverlayPickerActivity.class);
                    picker.putExtra(OverlayPickerActivity.EXTRA_USE_CAMERA, useCamera);
                    picker.addFlags(
                        Intent.FLAG_ACTIVITY_NEW_TASK |
                        Intent.FLAG_ACTIVITY_MULTIPLE_TASK |
                        Intent.FLAG_ACTIVITY_NO_ANIMATION
                    );
                    startActivity(picker);
                } catch (Exception e) {
                    Toast.makeText(FloatingOverlayService.this, "無法開啟圖片選擇器", Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void startScreenFreezeLookup() {
            performFreezeCaptureAfterDelay();
        }

        @JavascriptInterface
        public void closeFreezeMode() {
            hideFreezeWindow(true);
        }

        @JavascriptInterface
        public void setSubtitleOverlayVisible(boolean visible) {
            subtitleDesiredVisible = visible;
            if (visible) {
                showSubtitleOverlay();
            } else {
                detachSubtitleOverlay();
            }
        }

        @JavascriptInterface
        public void updateSubtitleOverlay(String orig, String trans, String tierLabel) {
            updateSubtitleHudText(orig, trans, tierLabel);
        }

        @JavascriptInterface
        public void toggleScreenSubtitleOcr(boolean enable) {
            videoOcrActive = enable;
            if (!enable) {
                mainHandler.removeCallbacks(videoOcrTickRunnable);
                return;
            }
            if (mediaProjection == null) {
                mainHandler.post(() -> launchMediaProjectionPermission("video_ocr"));
                return;
            }
            startVideoOcrLoop();
        }

        @JavascriptInterface
        public void setVideoRoiConfig(String mode, String rectJson) {
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .putString(KEY_VIDEO_ROI_MODE, !TextUtils.isEmpty(mode) ? mode : "bottom25")
                .putString(KEY_VIDEO_ROI_RECT_JSON, !TextUtils.isEmpty(rectJson) ? rectJson : "{}")
                .apply();
        }

        @JavascriptInterface
        public void startNativeStt(String langTag) {
            nativeSttLangTag = !TextUtils.isEmpty(langTag) ? langTag : "en-US";
            nativeSttRunning = true;
            startSpeechRecognizerSession();
        }

        @JavascriptInterface
        public void stopNativeStt() {
            nativeSttRunning = false;
            mainHandler.post(FloatingOverlayService.this::destroySpeechRecognizerOnly);
        }

        @JavascriptInterface
        public void openAppMain() {
            mainHandler.post(() -> {
                hideOverlayPanel();
                try {
                    Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
                    if (launch != null) {
                        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                        startActivity(launch);
                    }
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void showNativeToast(String msg) {
            mainHandler.post(() -> Toast.makeText(FloatingOverlayService.this, msg, Toast.LENGTH_SHORT).show());
        }
    }

    private void createOverlayNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "LZHCard 三語懸浮翻譯",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("離開 LZHCard 時自動顯示三語懸浮翻譯球與螢幕字幕服務");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildForegroundNotification() {
        Intent stopIntent = new Intent(this, FloatingOverlayService.class);
        stopIntent.setAction(ACTION_STOP);
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent stopPending = PendingIntent.getService(this, 1, stopIntent, flags);

        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent openPending = launchIntent != null
            ? PendingIntent.getActivity(this, 2, launchIntent, flags)
            : null;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("LZHCard 跨 App 三語懸浮球已就緒")
            .setContentText("支援跨 App 定格點詞、免費字幕與好友即時聊天")
            .setSmallIcon(android.R.drawable.ic_menu_search)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "關閉", stopPending);
        if (openPending != null) {
            builder.setContentIntent(openPending);
        }
        return builder.build();
    }

    @Override
    public void onDestroy() {
        running = false;
        activeInstance = null;
        videoOcrActive = false;
        nativeSttRunning = false;
        mainHandler.removeCallbacksAndMessages(null);

        destroySpeechRecognizerOnly();
        stopScreenCaptureResources();

        if (windowManager != null && panelContainer != null && isPanelAttached) {
            try { windowManager.removeView(panelContainer); } catch (Exception ignored) {}
            isPanelAttached = false;
        }
        if (windowManager != null && freezeContainer != null && isFreezeAttached) {
            try { windowManager.removeView(freezeContainer); } catch (Exception ignored) {}
            isFreezeAttached = false;
        }
        detachSubtitleOverlay();
        detachBubble();

        if (overlayWebView != null) {
            try { overlayWebView.destroy(); } catch (Exception ignored) {}
            overlayWebView = null;
        }
        if (freezeWebView != null) {
            try { freezeWebView.destroy(); } catch (Exception ignored) {}
            freezeWebView = null;
        }
        if (latinRecognizer != null) {
            try { latinRecognizer.close(); } catch (Exception ignored) {}
        }
        if (japaneseRecognizer != null) {
            try { japaneseRecognizer.close(); } catch (Exception ignored) {}
        }
        if (chineseRecognizer != null) {
            try { chineseRecognizer.close(); } catch (Exception ignored) {}
        }
        synchronized (translatorCache) {
            for (Translator t : translatorCache.values()) {
                try { t.close(); } catch (Exception ignored) {}
            }
            translatorCache.clear();
        }
        if (ttsEngine != null) {
            try {
                ttsEngine.stop();
                ttsEngine.shutdown();
            } catch (Exception ignored) {}
        }
        if (captureThread != null) {
            try { captureThread.quitSafely(); } catch (Exception ignored) {}
        }
        bgExecutor.shutdownNow();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}