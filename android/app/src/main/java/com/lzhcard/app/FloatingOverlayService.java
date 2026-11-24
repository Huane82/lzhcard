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
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
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
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.LinkedHashSet;
import java.util.Set;

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
    public static final String KEY_VIDEO_SOURCE_LANG = "overlay_video_source_lang";

    private static final String WORKER_FAST_REFINE_URL = "https://lzhcard.tomlin980415.workers.dev/ai/fast-refine";
    private static final String CHANNEL_ID = "lzhcard_overlay_service";
    private static final int NOTIFICATION_ID = 4901;
    private static final long SCAN_WATCHDOG_TIMEOUT_MS = 8000L;

    private static final Pattern JA_KANA_PATTERN = Pattern.compile("[\\u3040-\\u309F\\u30A0-\\u30FF々〆ヵヶ]");
    private static final Pattern KO_PATTERN = Pattern.compile("[\\uAC00-\\uD7AF\\u1100-\\u11FF\\u3130-\\u318F]");
    private static final Pattern CJK_PATTERN = Pattern.compile("[\\u4E00-\\u9FFF\\u3400-\\u4DBF]");
    private static final Pattern EN_PATTERN = Pattern.compile("[A-Za-z]");
    private static final Pattern HAS_VALID_LANG_CHAR = Pattern.compile("[A-Za-z\\u3040-\\u30FF\\u4E00-\\u9FFF\\u3400-\\u4DBF\\uAC00-\\uD7AF]");
    private static final Pattern PURE_NOISE_LINE = Pattern.compile("^[\\s\\p{Punct}0-9|~`^_=+<>\\\\/\\[\\]{}()*&%$#@!;:'\",.?-]+$");

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

    // 圖片模式鎖定 / 平板自適應尺寸 / 全螢幕狀態紀錄
    private volatile boolean isImageModeActive = false;
    private volatile boolean isSelectingImage = false;
    private volatile boolean isOverlayFullscreen = false;
    private int savedX = 0;
    private int savedY = 0;
    private int savedW = 0;
    private int savedH = 0;

    // Window 3: 原生全螢幕截圖定格點詞覆蓋層（脫離背景 WebView，確保 HyperOS 平板穩定互動）
    private WindowManager.LayoutParams freezeParams;
    private NativeFreezeOverlayView nativeFreezeView;
    private boolean isFreezeAttached = false;
    private volatile boolean isFreezeScanInProgress = false;
    private volatile boolean isScanning = false;
    private long activeScanSeq = 0L;
    private Runnable activeScanWatchdog;

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
    private TextRecognizer koreanRecognizer;
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

    public static void setPanelFullscreenState(boolean isFullscreen) {
        FloatingOverlayService inst = activeInstance;
        if (inst != null) {
            inst.mainHandler.post(() -> inst.setFullscreenInternal(isFullscreen));
        }
    }

    public static void setImageModeState(boolean active) {
        FloatingOverlayService inst = activeInstance;
        if (inst != null) {
            inst.mainHandler.post(() -> inst.setImageModeInternal(active));
        }
    }

    public static void deliverCapturedImageBase64(Context ctx, String base64) {
        FloatingOverlayService inst = activeInstance;
        if (inst == null) {
            if (!TextUtils.isEmpty(base64)) {
                pendingCapturedBase64 = base64;
            }
            return;
        }
        inst.mainHandler.post(() -> {
            inst.isSelectingImage = false;
            if (!TextUtils.isEmpty(base64)) {
                inst.isImageModeActive = true;
                pendingCapturedBase64 = null;
                if (!appInForeground) {
                    inst.processExternalBase64ImageWithNativeFreeze(base64);
                    return;
                }
                pendingCapturedBase64 = base64;
                inst.applyTabletImagePanelBounds();
            } else if (!appInForeground) {
                inst.showOverlayPanel();
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
            koreanRecognizer = TextRecognition.getClient(new KoreanTextRecognizerOptions.Builder().build());
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
        if (isFreezeScanInProgress || isFreezeAttached) {
            return;
        }
        if (appInForeground) {
            hideOverlayPanel();
            detachBubble();
            detachSubtitleOverlay();
        } else {
            if (!isPanelAttached) {
                attachBubble();
            }
            if (subtitleDesiredVisible) {
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

    private boolean isTabletDevice() {
        DisplayMetrics dm = getResources().getDisplayMetrics();
        float widthDp = dm.widthPixels / Math.max(1f, dm.density);
        float heightDp = dm.heightPixels / Math.max(1f, dm.density);
        int smallestWidthDp = getResources().getConfiguration().smallestScreenWidthDp;
        return Math.min(widthDp, heightDp) >= 600f || widthDp >= 600f || smallestWidthDp >= 600;
    }

    private void applyTabletImagePanelBounds() {
        if (panelParams == null || isOverlayFullscreen) return;
        if (!isTabletDevice()) return;
        DisplayMetrics dm = getResources().getDisplayMetrics();
        int targetW = Math.round(dm.widthPixels * 0.82f);
        int targetH = Math.round(dm.heightPixels * 0.80f);
        panelParams.width = targetW;
        panelParams.height = targetH;
        panelParams.x = Math.max(0, (dm.widthPixels - targetW) / 2);
        panelParams.y = Math.max(0, (dm.heightPixels - targetH) / 2);
        if (windowManager != null && panelContainer != null && isPanelAttached) {
            try {
                windowManager.updateViewLayout(panelContainer, panelParams);
            } catch (Exception ignored) {}
        }
    }

    private void restoreDefaultPanelBounds() {
        if (panelParams == null || isOverlayFullscreen) return;
        DisplayMetrics dm = getResources().getDisplayMetrics();
        int panelWidth = Math.min(dp(396), Math.max(dp(280), dm.widthPixels - dp(20)));
        int panelHeight = getDefaultPanelHeightPx();
        panelParams.width = panelWidth;
        panelParams.height = panelHeight;
        panelParams.x = Math.max(dp(10), (dm.widthPixels - panelWidth) / 2);
        panelParams.y = Math.max(dp(36), (int) (dm.heightPixels * 0.10f));
        if (windowManager != null && panelContainer != null && isPanelAttached) {
            try {
                windowManager.updateViewLayout(panelContainer, panelParams);
            } catch (Exception ignored) {}
        }
    }

    private void setImageModeInternal(boolean active) {
        isImageModeActive = active;
        if (active) {
            applyTabletImagePanelBounds();
        } else if (!isOverlayFullscreen) {
            restoreDefaultPanelBounds();
        }
    }

    private void setFullscreenInternal(boolean enable) {
        ensurePanelWebViewCreated();
        if (panelParams == null) return;
        if (enable) {
            if (!isOverlayFullscreen) {
                savedX = panelParams.x;
                savedY = panelParams.y;
                savedW = panelParams.width;
                savedH = panelParams.height;
                isOverlayFullscreen = true;
            }
            panelParams.width = WindowManager.LayoutParams.MATCH_PARENT;
            panelParams.height = WindowManager.LayoutParams.MATCH_PARENT;
            panelParams.x = 0;
            panelParams.y = 0;
        } else {
            isOverlayFullscreen = false;
            if (isImageModeActive && isTabletDevice()) {
                applyTabletImagePanelBounds();
            } else if (savedW != 0 && savedH != 0) {
                panelParams.width = savedW;
                panelParams.height = savedH;
                panelParams.x = savedX;
                panelParams.y = savedY;
            } else {
                restoreDefaultPanelBounds();
            }
        }
        if (windowManager != null && panelContainer != null && isPanelAttached) {
            try {
                windowManager.updateViewLayout(panelContainer, panelParams);
            } catch (Exception ignored) {}
        }
        if (overlayWebView != null && isWebPageLoaded) {
            overlayWebView.evaluateJavascript(
                "if(window.LZHOverlayApp && window.LZHOverlayApp.onNativeFullscreenChanged){window.LZHOverlayApp.onNativeFullscreenChanged(" + isOverlayFullscreen + ");}",
                null
            );
        }
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

        panelContainer = new FrameLayout(this) {
            @Override
            public void onWindowFocusChanged(boolean hasWindowFocus) {
                super.onWindowFocusChanged(hasWindowFocus);
                if (!hasWindowFocus && (isImageModeActive || isSelectingImage || isOverlayFullscreen || isFreezeScanInProgress || isFreezeAttached)) {
                    // 圖片/選圖、定格掃描或全螢幕模式下暫時失去焦點時，禁止縮回或重置尺寸
                    return;
                }
            }
        };
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
        if (isOverlayFullscreen) {
            panelParams.width = WindowManager.LayoutParams.MATCH_PARENT;
            panelParams.height = WindowManager.LayoutParams.MATCH_PARENT;
            panelParams.x = 0;
            panelParams.y = 0;
        } else if (isImageModeActive && isTabletDevice()) {
            applyTabletImagePanelBounds();
        } else if (panelParams.height < dp(260)) {
            panelParams.height = getDefaultPanelHeightPx();
        }
        if (!isPanelAttached && panelContainer != null) {
            try {
                windowManager.addView(panelContainer, panelParams);
                isPanelAttached = true;
                pushConfigToWebView();
                flushPendingCapturedImage();
            } catch (Exception ignored) {}
        } else if (isPanelAttached && panelContainer != null) {
            try {
                windowManager.updateViewLayout(panelContainer, panelParams);
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
        if (!appInForeground && running && !isFreezeAttached && !isFreezeScanInProgress) {
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
            obj.put("videoSourceLang", sp.getString(KEY_VIDEO_SOURCE_LANG, "en"));
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
       3. Window 3: 原生全螢幕截圖定格點詞覆蓋視窗 (NativeFreezeOverlayView)
       ========================================================================== */

    private void ensureNativeFreezeViewCreated() {
        if (nativeFreezeView != null && freezeParams != null) return;

        nativeFreezeView = new NativeFreezeOverlayView(this, new NativeFreezeOverlayView.HostCallback() {
            @Override
            public void onTranslateRequested(String text, String sourceLangHint, NativeFreezeOverlayView.TranslationResultListener listener) {
                translateFreezeTextNative(text, sourceLangHint, listener);
            }

            @Override
            public void onSpeakRequested(String text, String langCode) {
                mainHandler.post(() -> {
                    if (!ttsReady || ttsEngine == null || TextUtils.isEmpty(text)) return;
                    Locale loc = "ja".equals(langCode)
                        ? Locale.JAPAN
                        : ("ko".equals(langCode)
                            ? Locale.KOREA
                            : ("zh-TW".equals(langCode) ? Locale.TRADITIONAL_CHINESE : Locale.US));
                    ttsEngine.setLanguage(loc);
                    ttsEngine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "lzh_freeze_tts");
                });
            }

            @Override
            public void onSaveCardRequested(String word, String translation, String langCode, String targetDeck) {
                saveNativeCardToPendingPrefs(word, translation, langCode, targetDeck);
            }

            @Override
            public void onCloseRequested(boolean restorePanel) {
                hideFreezeWindow(restorePanel);
            }
        });

        int flags = WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS;
        freezeParams = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            getOverlayWindowType(),
            flags,
            PixelFormat.TRANSLUCENT
        );
        freezeParams.gravity = Gravity.TOP | Gravity.START;
        freezeParams.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            freezeParams.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
    }

    private void showNativeFreezeWindow(
        Bitmap bmp,
        List<NativeFreezeOverlayView.FreezeToken> tokens,
        List<String> lines,
        String defaultDeck
    ) {
        mainHandler.post(() -> {
            cancelScanWatchdog();
            isScanning = false;
            isFreezeScanInProgress = false;

            if (windowManager == null) {
                if (!bmp.isRecycled()) bmp.recycle();
                if (!appInForeground && running) showOverlayPanel();
                return;
            }

            ensureNativeFreezeViewCreated();
            detachBubble();
            hidePanelWithoutReattachingBubble();
            detachSubtitleOverlay();

            nativeFreezeView.setVisibility(View.VISIBLE);
            nativeFreezeView.setFreezeData(bmp, tokens, lines, defaultDeck);

            if (!isFreezeAttached) {
                try {
                    windowManager.addView(nativeFreezeView, freezeParams);
                    isFreezeAttached = true;
                } catch (Exception e) {
                    nativeFreezeView.releaseBitmapSafely();
                    Toast.makeText(this, "無法顯示定格視窗：" + e.getMessage(), Toast.LENGTH_SHORT).show();
                    if (!appInForeground && running) showOverlayPanel();
                }
            } else {
                try {
                    windowManager.updateViewLayout(nativeFreezeView, freezeParams);
                } catch (Exception ignored) {}
            }
        });
    }

    private void hideFreezeWindow(boolean restorePanel) {
        mainHandler.post(() -> {
            cancelScanWatchdog();
            isScanning = false;
            isFreezeScanInProgress = false;
            if (windowManager != null && nativeFreezeView != null && isFreezeAttached) {
                try {
                    windowManager.removeView(nativeFreezeView);
                } catch (Exception ignored) {}
                isFreezeAttached = false;
            }
            if (nativeFreezeView != null) {
                nativeFreezeView.releaseBitmapSafely();
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

    private void saveNativeCardToPendingPrefs(String word, String translation, String langCode, String targetDeck) {
        if (TextUtils.isEmpty(word)) return;
        try {
            SharedPreferences sp = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            String deck = !TextUtils.isEmpty(targetDeck) ? targetDeck : sp.getString(KEY_DEFAULT_DECK, "我的單字本");
            JSONArray existing = new JSONArray(sp.getString(KEY_PENDING_CARDS, "[]"));
            JSONObject card = new JSONObject();
            card.put("word", word.trim());
            card.put("meaning", translation != null ? translation.trim() : "");
            card.put("lang", !TextUtils.isEmpty(langCode) ? langCode : detectLanguageCode(word));
            card.put("targetDeck", deck);
            existing.put(card);
            sp.edit().putString(KEY_PENDING_CARDS, existing.toString()).apply();
            mainHandler.post(() -> Toast.makeText(this, "已加入待匯入單字：" + word.trim(), Toast.LENGTH_SHORT).show());
        } catch (Exception ignored) {}
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
            finishFreezeScanFailure(activeScanSeq, true, "無法請求螢幕擷取權限");
        }
    }

    private void handleMediaProjectionResult(int resultCode, @Nullable Intent data, String purpose) {
        if (resultCode != Activity.RESULT_OK || data == null) {
            cancelScanWatchdog();
            isScanning = false;
            isFreezeScanInProgress = false;
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
            if (mpm == null) {
                finishFreezeScanFailure(activeScanSeq, true, "系統無法存取螢幕擷取服務");
                return;
            }

            releaseVirtualDisplayAndReaderOnly();
            if (mediaProjection != null) {
                try { mediaProjection.stop(); } catch (Exception ignored) {}
                mediaProjection = null;
            }

            mediaProjection = mpm.getMediaProjection(resultCode, data);
            if (mediaProjection == null) {
                finishFreezeScanFailure(activeScanSeq, true, "螢幕擷取授權無效");
                return;
            }

            mediaProjection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    stopScreenCaptureResources();
                    cancelScanWatchdog();
                    isScanning = false;
                    isFreezeScanInProgress = false;
                    if (videoOcrActive) {
                        videoOcrActive = false;
                        notifyWebVideoOcrState(false);
                    }
                }
            }, mainHandler);

            if (!ensureVirtualDisplayReady()) {
                return;
            }

            if ("freeze".equals(purpose)) {
                performFreezeCaptureAfterDelay();
            } else if ("video_ocr".equals(purpose)) {
                videoOcrActive = true;
                startVideoOcrLoop();
            }
        } catch (Exception e) {
            stopScreenCaptureResources();
            finishFreezeScanFailure(activeScanSeq, true, "啟動螢幕擷取失敗，請重試");
        }
    }

    private void notifyWebVideoOcrState(boolean active) {
        mainHandler.post(() -> {
            if (overlayWebView == null || !isWebPageLoaded) return;
            overlayWebView.evaluateJavascript(
                "if(window.LZHOverlayApp && window.LZHOverlayApp.applyNativeConfig){window.LZHOverlayApp.applyNativeConfig({});}",
                null
            );
        });
    }

    private boolean ensureVirtualDisplayReady() {
        if (mediaProjection == null || windowManager == null) return false;

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
            return true;
        }

        try {
            if (virtualDisplay != null) {
                // Android 14+ / HyperOS 禁止重複 createVirtualDisplay：保持單一 VirtualDisplay，尺寸變動時改用 resize + setSurface
                ImageReader oldReader = imageReader;
                ImageReader newReader = ImageReader.newInstance(targetW, targetH, PixelFormat.RGBA_8888, 4);
                captureWidth = targetW;
                captureHeight = targetH;
                captureDensity = dm.densityDpi;
                virtualDisplay.resize(captureWidth, captureHeight, captureDensity);
                virtualDisplay.setSurface(newReader.getSurface());
                imageReader = newReader;
                if (oldReader != null) {
                    try { oldReader.close(); } catch (Exception ignored) {}
                }
                return true;
            }

            captureWidth = targetW;
            captureHeight = targetH;
            captureDensity = dm.densityDpi;
            imageReader = ImageReader.newInstance(captureWidth, captureHeight, PixelFormat.RGBA_8888, 4);
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
            return true;
        } catch (SecurityException | IllegalStateException e) {
            stopScreenCaptureResources();
            String fallbackPurpose = videoOcrActive ? "video_ocr" : "freeze";
            cancelScanWatchdog();
            isScanning = false;
            isFreezeScanInProgress = false;
            mainHandler.post(() -> launchMediaProjectionPermission(fallbackPurpose));
            return false;
        }
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
       6. 全螢幕截圖定格點詞流程（狀態鎖 + 8秒 Watchdog + 隱藏浮窗 -> 截圖 -> 原生 ML Kit）
       ========================================================================== */

    private void startScanWatchdog(final long scanToken) {
        cancelScanWatchdog();
        activeScanWatchdog = () -> {
            if (isScanning && activeScanSeq == scanToken) {
                isScanning = false;
                isFreezeScanInProgress = false;
                Toast.makeText(this, "定格掃描逾時，已重設狀態，請再試一次", Toast.LENGTH_SHORT).show();
                if (!appInForeground && running && !isFreezeAttached) {
                    showOverlayPanel();
                }
            }
        };
        mainHandler.postDelayed(activeScanWatchdog, SCAN_WATCHDOG_TIMEOUT_MS);
    }

    private void cancelScanWatchdog() {
        if (activeScanWatchdog != null) {
            mainHandler.removeCallbacks(activeScanWatchdog);
            activeScanWatchdog = null;
        }
    }

    private void finishFreezeScanFailure(long scanToken, boolean restorePanel, String toastMsg) {
        mainHandler.post(() -> {
            if (scanToken != activeScanSeq && scanToken != 0L) return;
            cancelScanWatchdog();
            isScanning = false;
            isFreezeScanInProgress = false;
            if (!TextUtils.isEmpty(toastMsg)) {
                Toast.makeText(this, toastMsg, Toast.LENGTH_SHORT).show();
            }
            if (restorePanel && !appInForeground && running && !isFreezeAttached) {
                showOverlayPanel();
            }
        });
    }

    private void performFreezeCaptureAfterDelay() {
        mainHandler.post(() -> {
            if (isScanning) {
                return;
            }
            final long scanToken = ++activeScanSeq;
            isScanning = true;
            isFreezeScanInProgress = true;
            startScanWatchdog(scanToken);

            hidePanelWithoutReattachingBubble();
            detachBubble();
            detachSubtitleOverlay();

            if (mediaProjection == null) {
                cancelScanWatchdog();
                isScanning = false;
                isFreezeScanInProgress = false;
                launchMediaProjectionPermission("freeze");
                return;
            }

            if (!ensureVirtualDisplayReady()) {
                return;
            }
            drainImageReaderQueue();

            mainHandler.postDelayed(() -> captureFreezeBitmapWithRetry(0, scanToken), 180);
        });
    }

    private void captureFreezeBitmapWithRetry(int attempt, final long scanToken) {
        captureHandler.post(() -> {
            if (!isScanning || scanToken != activeScanSeq) return;
            Bitmap bmp = acquireLatestScreenBitmap();
            if (bmp == null && attempt < 8) {
                captureHandler.postDelayed(() -> captureFreezeBitmapWithRetry(attempt + 1, scanToken), 50);
                return;
            }
            if (bmp == null) {
                finishFreezeScanFailure(scanToken, true, "螢幕畫面尚未就緒，請再試一次");
                return;
            }
            processFreezeBitmapWithMlKit(bmp, scanToken);
        });
    }

    private void processFreezeBitmapWithMlKit(Bitmap bmp, final long scanToken) {
        if (!isScanning || scanToken != activeScanSeq) {
            if (!bmp.isRecycled()) bmp.recycle();
            return;
        }

        final int bmpW = Math.max(1, bmp.getWidth());
        final int bmpH = Math.max(1, bmp.getHeight());
        final InputImage inputImage = InputImage.fromBitmap(bmp, 0);

        List<Task<Text>> tasks = new ArrayList<>();
        if (japaneseRecognizer != null) tasks.add(japaneseRecognizer.process(inputImage));
        if (chineseRecognizer != null) tasks.add(chineseRecognizer.process(inputImage));
        if (koreanRecognizer != null) tasks.add(koreanRecognizer.process(inputImage));
        if (latinRecognizer != null) tasks.add(latinRecognizer.process(inputImage));

        if (tasks.isEmpty()) {
            if (!bmp.isRecycled()) bmp.recycle();
            finishFreezeScanFailure(scanToken, true, "文字辨識引擎尚未就緒");
            return;
        }

        Tasks.whenAllComplete(tasks).addOnCompleteListener(bgExecutor, done -> {
            boolean ownershipTransferred = false;
            try {
                if (!isScanning || scanToken != activeScanSeq) {
                    return;
                }
                List<NativeFreezeOverlayView.FreezeToken> tokens = new ArrayList<>();
                Set<String> lineSet = new LinkedHashSet<>();
                for (Task<Text> t : tasks) {
                    if (!t.isSuccessful() || t.getResult() == null) continue;
                    extractTokensFromMlKitResult(t.getResult(), bmpW, bmpH, tokens, lineSet);
                }

                if (tokens.isEmpty()) {
                    finishFreezeScanFailure(scanToken, true, "未偵測到文字");
                    return;
                }

                SharedPreferences sp = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String defaultDeck = sp.getString(KEY_DEFAULT_DECK, "我的單字本");
                List<String> lines = new ArrayList<>(lineSet);

                ownershipTransferred = true;
                showNativeFreezeWindow(bmp, tokens, lines, defaultDeck);
            } catch (Exception e) {
                finishFreezeScanFailure(scanToken, true, "定格辨識失敗，請再試一次");
            } finally {
                if (!ownershipTransferred && !bmp.isRecycled()) {
                    try { bmp.recycle(); } catch (Exception ignored) {}
                }
            }
        });
    }

    private void processExternalBase64ImageWithNativeFreeze(String base64) {
        if (TextUtils.isEmpty(base64) || isScanning) return;
        final long scanToken = ++activeScanSeq;
        isScanning = true;
        isFreezeScanInProgress = true;
        startScanWatchdog(scanToken);

        bgExecutor.execute(() -> {
            Bitmap bmp = null;
            try {
                String cleanB64 = base64.contains(",") ? base64.substring(base64.indexOf(',') + 1) : base64;
                byte[] bytes = Base64.decode(cleanB64, Base64.DEFAULT);
                bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bmp == null) {
                    finishFreezeScanFailure(scanToken, true, "無法解析圖片");
                    return;
                }
                processFreezeBitmapWithMlKit(bmp, scanToken);
            } catch (Exception e) {
                if (bmp != null && !bmp.isRecycled()) {
                    try { bmp.recycle(); } catch (Exception ignored) {}
                }
                finishFreezeScanFailure(scanToken, true, "圖片辨識失敗");
            }
        });
    }

    private String cleanAndValidateOcrText(String rawText, @Nullable String forcedSourceLang) {
        if (TextUtils.isEmpty(rawText)) return "";
        String cleaned = rawText
            .replaceAll("[|~`^_\\\\\\[\\]{}]+", " ")
            .replaceAll("\\s*=+\\s*", " ")
            .replaceAll("\\s+", " ")
            .trim();
        if (cleaned.length() < 2) return "";
        if (PURE_NOISE_LINE.matcher(cleaned).matches()) return "";
        if (!HAS_VALID_LANG_CHAR.matcher(cleaned).find()) return "";

        if ("en".equalsIgnoreCase(forcedSourceLang)) {
            int latinCount = 0;
            for (int i = 0; i < cleaned.length(); i++) {
                char ch = cleaned.charAt(i);
                if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) latinCount++;
            }
            if (latinCount < 2) return "";
        }
        return cleaned;
    }

    private void extractTokensFromMlKitResult(
        Text result,
        int imgW,
        int imgH,
        List<NativeFreezeOverlayView.FreezeToken> dest,
        Set<String> lineSet
    ) {
        if (result == null) return;
        for (Text.TextBlock block : result.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                float lineConf = line.getConfidence();
                if (lineConf > 0f && lineConf < 0.65f) continue;

                String rawLine = line.getText() != null ? line.getText().trim() : "";
                String cleanLine = cleanAndValidateOcrText(rawLine, null);
                if (TextUtils.isEmpty(cleanLine)) continue;
                lineSet.add(cleanLine);

                for (Text.Element el : line.getElements()) {
                    float elConf = el.getConfidence();
                    if (elConf > 0f && elConf < 0.65f) continue;

                    String raw = el.getText() != null ? el.getText().trim() : "";
                    if (raw.isEmpty()) continue;
                    String cleaned = raw.replaceAll("^[\\p{Punct}\\s|~`^_=]+|[\\p{Punct}\\s|~`^_=]+$", "");
                    if (cleaned.isEmpty() || !HAS_VALID_LANG_CHAR.matcher(cleaned).find()) continue;

                    Rect r = el.getBoundingBox();
                    if (r == null || r.width() <= 0 || r.height() <= 0) continue;

                    int ymin = Math.max(0, Math.min(990, Math.round(r.top * 1000f / imgH)));
                    int xmin = Math.max(0, Math.min(990, Math.round(r.left * 1000f / imgW)));
                    int ymax = Math.max(ymin + 8, Math.min(1000, Math.round(r.bottom * 1000f / imgH)));
                    int xmax = Math.max(xmin + 8, Math.min(1000, Math.round(r.right * 1000f / imgW)));

                    if (isDuplicateBox(dest, cleaned, ymin, xmin, ymax, xmax)) continue;
                    dest.add(new NativeFreezeOverlayView.FreezeToken(
                        cleaned,
                        cleanLine,
                        detectLanguageCode(cleaned),
                        ymin,
                        xmin,
                        ymax,
                        xmax
                    ));
                }
            }
        }
    }

    private boolean isDuplicateBox(List<NativeFreezeOverlayView.FreezeToken> list, String txt, int ymin, int xmin, int ymax, int xmax) {
        for (NativeFreezeOverlayView.FreezeToken t : list) {
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
       7. 連續螢幕底部 ROI 即時翻譯（嚴格裁切 + 字幕區塗黑 + 單語系鎖定 + 信心度過濾）
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

        // 預設嚴格限制在畫面下方安全字幕帶，禁止傳入全螢幕畫面
        double xPct = 0.12;
        double yPct = 0.75;
        double wPct = 0.76;
        double hPct = 0.18;

        if ("bottom40".equals(mode)) {
            xPct = 0.08;
            yPct = 0.58;
            wPct = 0.84;
            hPct = 0.36;
        } else if ("top25".equals(mode)) {
            xPct = 0.10;
            yPct = 0.03;
            wPct = 0.80;
            hPct = 0.22;
        } else if ("custom".equals(mode)) {
            try {
                JSONObject rc = new JSONObject(TextUtils.isEmpty(rectJsonStr) ? "{}" : rectJsonStr);
                double rawX = rc.has("xPct") ? rc.optDouble("xPct", 0.12) : rc.optDouble("x", 0.12);
                double rawY = rc.has("yPct") ? rc.optDouble("yPct", 0.75) : rc.optDouble("y", 0.75);
                double rawW = rc.has("wPct") ? rc.optDouble("wPct", 0.76) : rc.optDouble("width", 0.76);
                double rawH = rc.has("hPct") ? rc.optDouble("hPct", 0.18) : rc.optDouble("height", 0.18);
                xPct = Math.max(0.0, Math.min(0.85, rawX));
                yPct = Math.max(0.0, Math.min(0.85, rawY));
                wPct = Math.max(0.15, Math.min(1.0 - xPct, rawW));
                hPct = Math.max(0.10, Math.min(1.0 - yPct, rawH));
            } catch (Exception ignored) {}
        } else if ("auto".equals(mode)) {
            double[][] bands = {
                {0.03, 0.20},
                {0.26, 0.22},
                {0.50, 0.22},
                {0.75, 0.18}
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
                    for (int px = Math.round(w * 0.12f); px < Math.round(w * 0.88f); px += stepX) {
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
                if (b == 3) avgScore *= 1.15;
                if (avgScore > bestScore) {
                    bestScore = avgScore;
                    bestIdx = b;
                }
            }
            xPct = 0.12;
            wPct = 0.76;
            yPct = bands[bestIdx][0];
            hPct = bands[bestIdx][1];
        }

        int rx = Math.max(0, Math.min(w - 20, (int) Math.round(w * xPct)));
        int ry = Math.max(0, Math.min(h - 20, (int) Math.round(h * yPct)));
        int rw = Math.max(20, Math.min(w - rx, (int) Math.round(w * wPct)));
        int rh = Math.max(20, Math.min(h - ry, (int) Math.round(h * hPct)));
        return new Rect(rx, ry, rx + rw, ry + rh);
    }

    private Bitmap maskSubtitleOverlayOnRoiBitmap(Bitmap roiBmp, Rect roiInFullBmp, int fullW, int fullH) {
        if (!isSubtitleAttached || subtitleContainer == null || subtitleParams == null || windowManager == null) {
            return roiBmp;
        }
        try {
            DisplayMetrics dm = new DisplayMetrics();
            windowManager.getDefaultDisplay().getRealMetrics(dm);
            int screenW = Math.max(1, dm.widthPixels);
            int screenH = Math.max(1, dm.heightPixels);

            int hudW = subtitleContainer.getWidth() > 0 ? subtitleContainer.getWidth() : subtitleParams.width;
            int hudH = subtitleContainer.getHeight() > 0 ? subtitleContainer.getHeight() : dp(96);
            int hudLeft = Math.round(subtitleParams.x * (fullW / (float) screenW));
            int hudTop = Math.round(subtitleParams.y * (fullH / (float) screenH));
            int hudRight = Math.round((subtitleParams.x + hudW) * (fullW / (float) screenW));
            int hudBottom = Math.round((subtitleParams.y + hudH) * (fullH / (float) screenH));

            Rect hudInFull = new Rect(hudLeft - 4, hudTop - 4, hudRight + 4, hudBottom + 4);
            Rect overlap = new Rect();
            if (!overlap.setIntersect(roiInFullBmp, hudInFull)) {
                return roiBmp;
            }

            Bitmap mutable = roiBmp.isMutable() ? roiBmp : roiBmp.copy(Bitmap.Config.ARGB_8888, true);
            if (mutable != roiBmp) {
                roiBmp.recycle();
            }
            Canvas canvas = new Canvas(mutable);
            Paint blackPaint = new Paint();
            blackPaint.setColor(Color.BLACK);
            blackPaint.setStyle(Paint.Style.FILL);
            canvas.drawRect(
                overlap.left - roiInFullBmp.left,
                overlap.top - roiInFullBmp.top,
                overlap.right - roiInFullBmp.left,
                overlap.bottom - roiInFullBmp.top,
                blackPaint
            );
            return mutable;
        } catch (Exception ignored) {
            return roiBmp;
        }
    }

    private TextRecognizer getSingleRecognizerForSourceLang(String sourceLang) {
        String lang = sourceLang != null ? sourceLang.trim().toLowerCase(Locale.ROOT) : "en";
        if ("ja".equals(lang) || "jpn".equals(lang)) {
            return japaneseRecognizer != null ? japaneseRecognizer : latinRecognizer;
        }
        if ("ko".equals(lang) || "kor".equals(lang)) {
            return koreanRecognizer != null ? koreanRecognizer : latinRecognizer;
        }
        if (lang.startsWith("zh")) {
            return chineseRecognizer != null ? chineseRecognizer : latinRecognizer;
        }
        return latinRecognizer != null ? latinRecognizer : japaneseRecognizer;
    }

    private String extractStrictRoiTextFromMlKitResult(Text result, String sourceLang) {
        if (result == null) return "";
        StringBuilder sb = new StringBuilder();
        for (Text.TextBlock block : result.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                float lineConf = line.getConfidence();
                if (lineConf > 0f && lineConf < 0.65f) continue;

                StringBuilder lineSb = new StringBuilder();
                List<Text.Element> elements = line.getElements();
                if (elements != null && !elements.isEmpty()) {
                    for (Text.Element el : elements) {
                        float elConf = el.getConfidence();
                        if (elConf > 0f && elConf < 0.65f) continue;
                        String elTxt = el.getText() != null ? el.getText().trim() : "";
                        if (elTxt.isEmpty()) continue;
                        if (lineSb.length() > 0) lineSb.append(' ');
                        lineSb.append(elTxt);
                    }
                } else if (line.getText() != null) {
                    lineSb.append(line.getText().trim());
                }

                String cleanedLine = cleanAndValidateOcrText(lineSb.toString(), sourceLang);
                if (!TextUtils.isEmpty(cleanedLine)) {
                    if (sb.length() > 0) sb.append(' ');
                    sb.append(cleanedLine);
                }
            }
        }
        return sb.toString().replaceAll("\\s+", " ").trim();
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
                final String sourceLang = sp.getString(KEY_VIDEO_SOURCE_LANG, "en");

                int fullW = Math.max(1, fullBmp.getWidth());
                int fullH = Math.max(1, fullBmp.getHeight());
                Rect roi = resolveVideoRoiRect(fullBmp, roiMode, roiRectJson);
                roiBmp = Bitmap.createBitmap(fullBmp, roi.left, roi.top, roi.width(), roi.height());
                fullBmp.recycle();

                // 將自家透明字幕條重疊區域塗黑，防止翻譯結果被二次辨識
                roiBmp = maskSubtitleOverlayOnRoiBitmap(roiBmp, roi, fullW, fullH);

                // 嚴格單一語系辨識鎖定：禁止同時混用多種語系辨識器
                TextRecognizer singleRecognizer = getSingleRecognizerForSourceLang(sourceLang);
                if (singleRecognizer == null) {
                    roiBmp.recycle();
                    videoOcrInFlight = false;
                    return;
                }

                InputImage roiImg = InputImage.fromBitmap(roiBmp, 0);
                final Bitmap toRecycle = roiBmp;
                singleRecognizer.process(roiImg)
                    .addOnSuccessListener(bgExecutor, textResult -> {
                        try { toRecycle.recycle(); } catch (Exception ignored) {}
                        videoOcrInFlight = false;
                        String filteredText = extractStrictRoiTextFromMlKitResult(textResult, sourceLang);
                        handleRoiOcrText(filteredText, sourceLang);
                    })
                    .addOnFailureListener(bgExecutor, e -> {
                        try { toRecycle.recycle(); } catch (Exception ignored) {}
                        videoOcrInFlight = false;
                    });
            } catch (Exception e) {
                try { fullBmp.recycle(); } catch (Exception ignored) {}
                if (roiBmp != null) { try { roiBmp.recycle(); } catch (Exception ignored) {} }
                videoOcrInFlight = false;
            }
        });
    }

    private void handleRoiOcrText(String rawText, String lockedSourceLang) {
        if (!videoOcrActive || TextUtils.isEmpty(rawText)) return;
        String clean = rawText.replaceAll("\\s+", " ").trim();
        if (clean.length() < 2 || clean.length() > 220) return;

        double sim = computeCharacterSimilarity(lastRoiOrigText, clean);
        if (sim >= 0.85d) return;

        lastRoiOrigText = clean;
        String srcLang = !TextUtils.isEmpty(lockedSourceLang) ? lockedSourceLang : detectLanguageCode(clean);
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

    private void notifyWebNativeSttState(boolean active, String reason) {
        mainHandler.post(() -> {
            if (overlayWebView == null || !isWebPageLoaded) return;
            String js = "if(window.LZHOverlayApp && window.LZHOverlayApp.onNativeSttStateChanged){"
                + "window.LZHOverlayApp.onNativeSttStateChanged(" + active + "," + JSONObject.quote(reason != null ? reason : "") + ");}";
            overlayWebView.evaluateJavascript(js, null);
        });
    }

    private void redirectMainActivityForMicPermission() {
        try {
            Intent permIntent = new Intent(this, MainActivity.class);
            permIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            permIntent.putExtra(MainActivity.EXTRA_REQUEST_MIC_PERMISSION, true);
            startActivity(permIntent);
        } catch (Exception ignored) {}
    }

    private void startSpeechRecognizerSession() {
        mainHandler.post(() -> {
            if (!nativeSttRunning) return;
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                nativeSttRunning = false;
                notifyWebNativeSttState(false, "MIC_PERMISSION_REQUIRED");
                Toast.makeText(this, "請先在 LZHCard 允許麥克風錄音權限", Toast.LENGTH_LONG).show();
                redirectMainActivityForMicPermission();
                return;
            }
            if (!SpeechRecognizer.isRecognitionAvailable(this)) {
                nativeSttRunning = false;
                notifyWebNativeSttState(false, "STT_UNAVAILABLE");
                Toast.makeText(this, "此裝置不支援原生離線/串流語音辨識", Toast.LENGTH_SHORT).show();
                return;
            }

            destroySpeechRecognizerOnly();
            speechRecognizer = SpeechRecognizer.createSpeechRecognizer(this);
            speechRecognizer.setRecognitionListener(new RecognitionListener() {
                @Override
                public void onReadyForSpeech(Bundle params) {
                    if (nativeSttRunning) {
                        notifyWebNativeSttState(true, "");
                    }
                }
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
                        notifyWebNativeSttState(false, "MIC_PERMISSION_REQUIRED");
                        Toast.makeText(FloatingOverlayService.this, "缺少麥克風權限，請於主程式開啟權限", Toast.LENGTH_SHORT).show();
                        redirectMainActivityForMicPermission();
                        return;
                    }
                    if (error == SpeechRecognizer.ERROR_AUDIO || error == SpeechRecognizer.ERROR_CLIENT) {
                        nativeSttRunning = false;
                        notifyWebNativeSttState(false, "STT_ERROR_" + error);
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
                notifyWebNativeSttState(false, "STT_START_FAILED");
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
        if (KO_PATTERN.matcher(text).find()) return "ko";
        if (CJK_PATTERN.matcher(text).find()) return "zh-TW";
        if (EN_PATTERN.matcher(text).find()) return "en";
        return "en";
    }

    private String toMlKitLanguage(String langCode) {
        if ("ja".equalsIgnoreCase(langCode)) return TranslateLanguage.JAPANESE;
        if ("ko".equalsIgnoreCase(langCode)) return TranslateLanguage.KOREAN;
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
        String sysPrompt = "You are a low-latency subtitle interpreter. "
            + "1) Automatically ignore and clean residual OCR edge symbols or broken gibberish tokens (e.g. '| ar Ss = 5'). If the entire input is pure OCR noise with no meaningful words, return an empty string. "
            + "2) Translate colloquialisms, idioms, and slang contextually into natural " + targetLangName + " (e.g., English 'new whip' means 「新車／座駕」, not literal whip). "
            + "3) Output ONLY the final translated string with zero quotes or markdown.";
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

    private String callGoogleTranslatePublicSync(String text, String srcLang, String targetLang) {
        if (TextUtils.isEmpty(text)) return "";
        HttpURLConnection conn = null;
        try {
            String sl = TextUtils.isEmpty(srcLang) ? "auto" : srcLang;
            String tl = TextUtils.isEmpty(targetLang) ? "zh-TW" : targetLang;
            String urlStr = "https://translate.googleapis.com/translate_a/single?client=gtx&sl="
                + URLEncoder.encode(sl, "UTF-8")
                + "&tl=" + URLEncoder.encode(tl, "UTF-8")
                + "&dt=t&q=" + URLEncoder.encode(text, "UTF-8");
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(4500);
            conn.setReadTimeout(6500);
            if (conn.getResponseCode() < 200 || conn.getResponseCode() >= 300) return "";
            BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
            JSONArray root = new JSONArray(sb.toString());
            JSONArray segments = root.optJSONArray(0);
            if (segments == null) return "";
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < segments.length(); i++) {
                JSONArray seg = segments.optJSONArray(i);
                if (seg != null && seg.length() > 0) {
                    String part = seg.optString(0, "");
                    if (!TextUtils.isEmpty(part)) out.append(part);
                }
            }
            return out.toString().trim();
        } catch (Exception ignored) {
            return "";
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void translateFreezeTextNative(String text, String srcLangHint, NativeFreezeOverlayView.TranslationResultListener listener) {
        if (TextUtils.isEmpty(text)) {
            listener.onResult("");
            return;
        }
        SharedPreferences sp = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        final String nativeLang = sp.getString(KEY_NATIVE_LANG, "zh-TW");
        final String targetLangName = "ja".equals(nativeLang)
            ? "Japanese (日本語)"
            : ("en".equals(nativeLang) ? "English" : "Traditional Chinese (繁體中文)");
        final String srcLang = !TextUtils.isEmpty(srcLangHint) ? srcLangHint : detectLanguageCode(text);

        bgExecutor.execute(() -> {
            String result = "";
            if (isPaidOrPersonalFastRefineEligible()) {
                result = callDirectByokFastRefineSync(text, "", targetLangName, null);
                if (TextUtils.isEmpty(result)) {
                    result = callWorkerFastRefineSync(text, "", srcLang, nativeLang, targetLangName, new ArrayList<>());
                }
            }
            if (TextUtils.isEmpty(result)) {
                result = callGoogleTranslatePublicSync(text, srcLang, nativeLang);
            }
            if (!TextUtils.isEmpty(result)) {
                listener.onResult(result);
                return;
            }
            translateWithMlKitOffline(text, srcLang, listener::onResult);
        });
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
                if (isOverlayFullscreen || isSelectingImage || isFreezeScanInProgress || isFreezeAttached) return;
                if (isImageModeActive && isTabletDevice()) return;
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
        public void setImageModeActive(boolean active) {
            mainHandler.post(() -> setImageModeInternal(active));
        }

        @JavascriptInterface
        public void setOverlayFullscreen(boolean isFullscreen) {
            mainHandler.post(() -> setFullscreenInternal(isFullscreen));
        }

        @JavascriptInterface
        public void collapsePanel() {
            mainHandler.post(() -> {
                if (isOverlayFullscreen) {
                    setFullscreenInternal(false);
                }
                hideOverlayPanel();
            });
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
                if (windowManager == null || panelContainer == null || !isPanelAttached || isOverlayFullscreen) return;
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
                isSelectingImage = true;
                isImageModeActive = true;
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
                    isSelectingImage = false;
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
        public void setVideoSourceLang(String lang) {
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .putString(KEY_VIDEO_SOURCE_LANG, !TextUtils.isEmpty(lang) ? lang : "en")
                .apply();
        }

        @JavascriptInterface
        public void openNativeImageOverlayBase64(String b64) {
            processExternalBase64ImageWithNativeFreeze(b64);
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
            mainHandler.post(() -> {
                destroySpeechRecognizerOnly();
                notifyWebNativeSttState(false, "");
            });
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
        if (windowManager != null && nativeFreezeView != null && isFreezeAttached) {
            try { windowManager.removeView(nativeFreezeView); } catch (Exception ignored) {}
            isFreezeAttached = false;
        }
        if (nativeFreezeView != null) {
            nativeFreezeView.releaseBitmapSafely();
            nativeFreezeView = null;
        }
        detachSubtitleOverlay();
        detachBubble();

        if (overlayWebView != null) {
            try { overlayWebView.destroy(); } catch (Exception ignored) {}
            overlayWebView = null;
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
        if (koreanRecognizer != null) {
            try { koreanRecognizer.close(); } catch (Exception ignored) {}
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