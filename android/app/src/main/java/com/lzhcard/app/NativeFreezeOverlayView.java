package com.lzhcard.app;

import android.annotation.SuppressLint;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 原生 Android 全螢幕截圖定格點詞覆蓋層：
 * 完全脫離背景 WebView JS 執行環境，徹底解決平板（如 HyperOS / 小米 Pad）
 * 背景節流導致的點詞無反應、無法翻譯與座標偏移問題。
 */
@SuppressLint("ViewConstructor")
public class NativeFreezeOverlayView extends FrameLayout {

    public static class FreezeToken {
        public final String text;
        public final String lineText;
        public final String lang;
        public final int ymin;
        public final int xmin;
        public final int ymax;
        public final int xmax;

        public FreezeToken(String text, String lineText, String lang, int ymin, int xmin, int ymax, int xmax) {
            this.text = text;
            this.lineText = lineText;
            this.lang = lang;
            this.ymin = ymin;
            this.xmin = xmin;
            this.ymax = ymax;
            this.xmax = xmax;
        }
    }

    public interface TranslationResultListener {
        void onResult(String translatedText);
    }

    public interface HostCallback {
        void onTranslateRequested(String text, String sourceLangHint, TranslationResultListener listener);
        void onSpeakRequested(String text, String langCode);
        void onSaveCardRequested(String word, String translation, String langCode, String targetDeck);
        void onCloseRequested(boolean restorePanel);
    }

    private final HostCallback hostCallback;
    private final ImageView screenshotView;
    private final FrameLayout tokenLayer;
    private final LinearLayout topToolbar;
    private final TextView titleBadgeView;
    private final LinearLayout listDrawerContainer;
    private final LinearLayout listItemsHost;
    private final LinearLayout resultCardContainer;
    private final TextView resultLangBadge;
    private final TextView resultOrigView;
    private final TextView resultTransView;
    private final TextView resultWholeLineBtn;
    private final TextView resultSaveBtn;
    private final TextView resultSpeakBtn;
    private final TextView resultCopyBtn;

    private final List<FreezeToken> allTokens = new ArrayList<>();
    private final List<String> distinctLines = new ArrayList<>();
    private final List<View> renderedBoxViews = new ArrayList<>();

    private Bitmap currentBitmap;
    private String defaultDeck = "我的單字本";
    private String activeOrigText = "";
    private String activeWholeLineText = "";
    private String activeTransText = "";
    private String activeLangCode = "en";
    private int activeRequestSeq = 0;
    private View activeSelectedBoxView = null;
    private int cachedTopInsetPx = 0;
    private int lastLayoutW = 0;
    private int lastLayoutH = 0;

    public NativeFreezeOverlayView(@NonNull Context context, @NonNull HostCallback callback) {
        super(context);
        this.hostCallback = callback;

        setBackgroundColor(Color.parseColor("#EC020617"));
        setClickable(true);
        setFocusable(true);
        setFocusableInTouchMode(true);

        // 1. 底層截圖 ImageView (FIT_CENTER 確保不裁切不變形，實際座標於 layout 時精算)
        screenshotView = new ImageView(context);
        screenshotView.setScaleType(ImageView.ScaleType.FIT_CENTER);
        screenshotView.setAdjustViewBounds(false);
        addView(screenshotView, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));

        // 2. 互動點詞方框層
        tokenLayer = new FrameLayout(context);
        tokenLayer.setClickable(false);
        addView(tokenLayer, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));

        // 3. 頂部懸浮原生工具列（翻譯全部 / 清單 / 關閉）
        topToolbar = new LinearLayout(context);
        topToolbar.setOrientation(LinearLayout.HORIZONTAL);
        topToolbar.setGravity(Gravity.CENTER_VERTICAL);
        topToolbar.setPadding(dp(12), dp(8), dp(12), dp(8));
        topToolbar.setElevation(dp(10));
        GradientDrawable toolbarBg = new GradientDrawable();
        toolbarBg.setColor(Color.parseColor("#E60F172A"));
        toolbarBg.setCornerRadius(dp(12));
        toolbarBg.setStroke(dp(1), Color.parseColor("#66818CF8"));
        topToolbar.setBackground(toolbarBg);

        titleBadgeView = new TextView(context);
        titleBadgeView.setText("定格點詞");
        titleBadgeView.setTextColor(Color.WHITE);
        titleBadgeView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        titleBadgeView.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        topToolbar.addView(titleBadgeView, titleLp);

        TextView translateAllBtn = makeToolbarButton("翻譯全部", "#4F46E5", "#FFFFFF");
        translateAllBtn.setOnClickListener(v -> translateAllLines());
        topToolbar.addView(translateAllBtn, makeToolbarBtnLp());

        TextView listToggleBtn = makeToolbarButton("句子清單", "#1E293B", "#E2E8F0");
        listToggleBtn.setOnClickListener(v -> toggleLineListDrawer());
        topToolbar.addView(listToggleBtn, makeToolbarBtnLp());

        TextView closeBtn = makeToolbarButton("✕ 關閉", "#BE123C", "#FFFFFF");
        closeBtn.setOnClickListener(v -> hostCallback.onCloseRequested(true));
        topToolbar.addView(closeBtn, makeToolbarBtnLp());

        LayoutParams toolbarLp = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        toolbarLp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        toolbarLp.leftMargin = dp(12);
        toolbarLp.rightMargin = dp(12);
        toolbarLp.topMargin = Math.max(dp(28), getStatusBarFallbackPx());
        addView(topToolbar, toolbarLp);

        // 4. 可展開句子清單抽屜
        listDrawerContainer = new LinearLayout(context);
        listDrawerContainer.setOrientation(LinearLayout.VERTICAL);
        listDrawerContainer.setVisibility(View.GONE);
        listDrawerContainer.setElevation(dp(12));
        GradientDrawable drawerBg = new GradientDrawable();
        drawerBg.setColor(Color.parseColor("#F20F172A"));
        drawerBg.setCornerRadius(dp(14));
        drawerBg.setStroke(dp(1), Color.parseColor("#5564748B"));
        listDrawerContainer.setBackground(drawerBg);
        listDrawerContainer.setPadding(dp(10), dp(10), dp(10), dp(10));

        ScrollView listScroll = new ScrollView(context);
        listItemsHost = new LinearLayout(context);
        listItemsHost.setOrientation(LinearLayout.VERTICAL);
        listScroll.addView(listItemsHost);
        listDrawerContainer.addView(listScroll, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(220)
        ));

        LayoutParams drawerLp = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        drawerLp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        drawerLp.leftMargin = dp(12);
        drawerLp.rightMargin = dp(12);
        drawerLp.topMargin = dp(82);
        addView(listDrawerContainer, drawerLp);

        // 5. 底部原生翻譯卡片（點擊任何框選詞組 / 翻譯全部時顯示）
        resultCardContainer = new LinearLayout(context);
        resultCardContainer.setOrientation(LinearLayout.VERTICAL);
        resultCardContainer.setVisibility(View.GONE);
        resultCardContainer.setElevation(dp(14));
        resultCardContainer.setPadding(dp(14), dp(12), dp(14), dp(12));
        GradientDrawable cardBg = new GradientDrawable();
        cardBg.setColor(Color.parseColor("#F50F172A"));
        cardBg.setCornerRadius(dp(16));
        cardBg.setStroke(dp(1), Color.parseColor("#886366F1"));
        resultCardContainer.setBackground(cardBg);

        LinearLayout cardHeader = new LinearLayout(context);
        cardHeader.setOrientation(LinearLayout.HORIZONTAL);
        cardHeader.setGravity(Gravity.CENTER_VERTICAL);

        resultLangBadge = new TextView(context);
        resultLangBadge.setText("EN");
        resultLangBadge.setTextColor(Color.parseColor("#C7D2FE"));
        resultLangBadge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10.5f);
        resultLangBadge.setTypeface(Typeface.DEFAULT_BOLD);
        resultLangBadge.setPadding(dp(8), dp(2), dp(8), dp(2));
        GradientDrawable badgeBg = new GradientDrawable();
        badgeBg.setColor(Color.parseColor("#334F46E5"));
        badgeBg.setCornerRadius(dp(6));
        resultLangBadge.setBackground(badgeBg);
        cardHeader.addView(resultLangBadge);

        View spacer = new View(context);
        cardHeader.addView(spacer, new LinearLayout.LayoutParams(0, 1, 1f));

        TextView cardCloseBtn = new TextView(context);
        cardCloseBtn.setText("收合 ✕");
        cardCloseBtn.setTextColor(Color.parseColor("#94A3B8"));
        cardCloseBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        cardCloseBtn.setPadding(dp(8), dp(2), dp(4), dp(2));
        cardCloseBtn.setOnClickListener(v -> {
            resultCardContainer.setVisibility(View.GONE);
            clearBoxSelection();
        });
        cardHeader.addView(cardCloseBtn);
        resultCardContainer.addView(cardHeader);

        ScrollView textScroll = new ScrollView(context);
        LinearLayout textInner = new LinearLayout(context);
        textInner.setOrientation(LinearLayout.VERTICAL);

        resultOrigView = new TextView(context);
        resultOrigView.setTextColor(Color.WHITE);
        resultOrigView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15.5f);
        resultOrigView.setTypeface(Typeface.DEFAULT_BOLD);
        resultOrigView.setPadding(0, dp(6), 0, dp(4));
        textInner.addView(resultOrigView);

        resultTransView = new TextView(context);
        resultTransView.setTextColor(Color.parseColor("#34D399"));
        resultTransView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
        resultTransView.setPadding(0, dp(2), 0, dp(8));
        textInner.addView(resultTransView);

        textScroll.addView(textInner);
        LinearLayout.LayoutParams textScrollLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        textScrollLp.weight = 0;
        textScroll.setLayoutParams(textScrollLp);
        // 避免長文撐滿整個平板螢幕，限制最大高度
        resultCardContainer.addView(textScroll, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        LinearLayout actionRow = new LinearLayout(context);
        actionRow.setOrientation(LinearLayout.HORIZONTAL);
        actionRow.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        actionRow.setPadding(0, dp(4), 0, 0);

        resultWholeLineBtn = makeCardActionButton("查整句", "#334155", "#E2E8F0");
        resultWholeLineBtn.setOnClickListener(v -> {
            if (!TextUtils.isEmpty(activeWholeLineText) && !activeWholeLineText.equals(activeOrigText)) {
                translateAndShowCard(activeWholeLineText, activeWholeLineText, activeLangCode);
            }
        });
        actionRow.addView(resultWholeLineBtn, makeActionBtnLp());

        resultSpeakBtn = makeCardActionButton("🔊 發音", "#1E293B", "#E2E8F0");
        resultSpeakBtn.setOnClickListener(v -> hostCallback.onSpeakRequested(activeOrigText, activeLangCode));
        actionRow.addView(resultSpeakBtn, makeActionBtnLp());

        resultCopyBtn = makeCardActionButton("📋 複製", "#1E293B", "#E2E8F0");
        resultCopyBtn.setOnClickListener(v -> copyActiveTranslation());
        actionRow.addView(resultCopyBtn, makeActionBtnLp());

        resultSaveBtn = makeCardActionButton("＋ 存單字", "#059669", "#FFFFFF");
        resultSaveBtn.setOnClickListener(v -> {
            if (TextUtils.isEmpty(activeOrigText)) return;
            String tr = !TextUtils.isEmpty(activeTransText) ? activeTransText : "";
            hostCallback.onSaveCardRequested(activeOrigText, tr, activeLangCode, defaultDeck);
            resultSaveBtn.setText("✓ 已存入");
        });
        actionRow.addView(resultSaveBtn, makeActionBtnLp());

        resultCardContainer.addView(actionRow);

        LayoutParams cardLp = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        cardLp.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        cardLp.leftMargin = dp(12);
        cardLp.rightMargin = dp(12);
        cardLp.bottomMargin = dp(20);
        addView(resultCardContainer, cardLp);

        // 點擊空白截圖背景時收合卡片與清單
        screenshotView.setOnClickListener(v -> {
            if (listDrawerContainer.getVisibility() == View.VISIBLE) {
                listDrawerContainer.setVisibility(View.GONE);
            }
        });

        addOnLayoutChangeListener((v, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            int w = right - left;
            int h = bottom - top;
            if (w > 0 && h > 0 && (w != lastLayoutW || h != lastLayoutH)) {
                lastLayoutW = w;
                lastLayoutH = h;
                layoutTokenBoxes();
            }
        });
    }

    @Override
    public WindowInsets onApplyWindowInsets(WindowInsets insets) {
        if (insets != null) {
            int topInset = 0;
            int bottomInset = 0;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets sys = insets.getInsetsIgnoringVisibility(
                    WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars() | WindowInsets.Type.displayCutout()
                );
                topInset = sys.top;
                bottomInset = sys.bottom;
            } else {
                topInset = insets.getSystemWindowInsetTop();
                bottomInset = insets.getSystemWindowInsetBottom();
            }
            if (topInset > 0 && topInset != cachedTopInsetPx) {
                cachedTopInsetPx = topInset;
                LayoutParams toolbarLp = (LayoutParams) topToolbar.getLayoutParams();
                toolbarLp.topMargin = topInset + dp(8);
                topToolbar.setLayoutParams(toolbarLp);

                LayoutParams drawerLp = (LayoutParams) listDrawerContainer.getLayoutParams();
                drawerLp.topMargin = topInset + dp(60);
                listDrawerContainer.setLayoutParams(drawerLp);
            }
            if (bottomInset >= 0) {
                LayoutParams cardLp = (LayoutParams) resultCardContainer.getLayoutParams();
                int targetBottom = bottomInset + dp(16);
                if (cardLp.bottomMargin != targetBottom) {
                    cardLp.bottomMargin = targetBottom;
                    resultCardContainer.setLayoutParams(cardLp);
                }
            }
        }
        return super.onApplyWindowInsets(insets);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event != null && event.getKeyCode() == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_UP) {
            if (listDrawerContainer.getVisibility() == View.VISIBLE) {
                listDrawerContainer.setVisibility(View.GONE);
                return true;
            }
            if (resultCardContainer.getVisibility() == View.VISIBLE) {
                resultCardContainer.setVisibility(View.GONE);
                clearBoxSelection();
                return true;
            }
            hostCallback.onCloseRequested(true);
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    public void setFreezeData(
        @NonNull Bitmap bmp,
        @NonNull List<FreezeToken> tokens,
        @NonNull List<String> lines,
        @Nullable String deckName
    ) {
        Bitmap prev = currentBitmap;
        currentBitmap = bmp;
        screenshotView.setImageBitmap(bmp);
        if (prev != null && prev != bmp && !prev.isRecycled()) {
            try { prev.recycle(); } catch (Exception ignored) {}
        }

        allTokens.clear();
        allTokens.addAll(tokens);
        distinctLines.clear();
        distinctLines.addAll(lines);
        if (!TextUtils.isEmpty(deckName)) {
            defaultDeck = deckName;
        }

        activeSelectedBoxView = null;
        resultCardContainer.setVisibility(View.GONE);
        listDrawerContainer.setVisibility(View.GONE);
        titleBadgeView.setText(String.format(Locale.ROOT, "定格點詞 · %d 個詞", allTokens.size()));

        rebuildLineDrawerItems();
        post(this::layoutTokenBoxes);
        requestFocus();
    }

    public void releaseBitmapSafely() {
        screenshotView.setImageDrawable(null);
        if (currentBitmap != null && !currentBitmap.isRecycled()) {
            try { currentBitmap.recycle(); } catch (Exception ignored) {}
        }
        currentBitmap = null;
        allTokens.clear();
        distinctLines.clear();
        tokenLayer.removeAllViews();
        renderedBoxViews.clear();
    }

    private RectF computeDisplayedBitmapRect() {
        int vw = getWidth();
        int vh = getHeight();
        if (vw <= 0 || vh <= 0 || currentBitmap == null || currentBitmap.isRecycled()) {
            return new RectF(0f, 0f, Math.max(1, vw), Math.max(1, vh));
        }
        float bw = Math.max(1f, currentBitmap.getWidth());
        float bh = Math.max(1f, currentBitmap.getHeight());
        float scale = Math.min(vw / bw, vh / bh);
        float drawW = bw * scale;
        float drawH = bh * scale;
        float left = (vw - drawW) / 2f;
        float top = (vh - drawH) / 2f;
        return new RectF(left, top, left + drawW, top + drawH);
    }

    private void layoutTokenBoxes() {
        tokenLayer.removeAllViews();
        renderedBoxViews.clear();
        activeSelectedBoxView = null;
        if (currentBitmap == null || currentBitmap.isRecycled() || allTokens.isEmpty()) {
            return;
        }
        RectF imgRect = computeDisplayedBitmapRect();
        float drawW = imgRect.width();
        float drawH = imgRect.height();
        if (drawW <= 4f || drawH <= 4f) return;

        int padPx = dp(3);
        int minHitPx = dp(24);
        int limit = Math.min(allTokens.size(), 500);
        for (int i = 0; i < limit; i++) {
            final FreezeToken tok = allTokens.get(i);
            float rawLeft = imgRect.left + (tok.xmin / 1000f) * drawW;
            float rawTop = imgRect.top + (tok.ymin / 1000f) * drawH;
            float rawRight = imgRect.left + (tok.xmax / 1000f) * drawW;
            float rawBottom = imgRect.top + (tok.ymax / 1000f) * drawH;

            int left = Math.max(0, Math.round(rawLeft) - padPx);
            int top = Math.max(0, Math.round(rawTop) - padPx);
            int width = Math.max(minHitPx, Math.round(rawRight - rawLeft) + padPx * 2);
            int height = Math.max(minHitPx, Math.round(rawBottom - rawTop) + padPx * 2);

            View box = new View(getContext());
            box.setClickable(true);
            box.setBackground(createTokenBoxDrawable(false));
            box.setOnClickListener(v -> {
                selectBoxView(v);
                listDrawerContainer.setVisibility(View.GONE);
                translateAndShowCard(tok.text, tok.lineText, tok.lang);
            });

            LayoutParams lp = new LayoutParams(width, height);
            lp.leftMargin = left;
            lp.topMargin = top;
            tokenLayer.addView(box, lp);
            renderedBoxViews.add(box);
        }
    }

    private void rebuildLineDrawerItems() {
        listItemsHost.removeAllViews();
        Context ctx = getContext();
        if (distinctLines.isEmpty()) {
            TextView empty = new TextView(ctx);
            empty.setText("未擷取到完整句子");
            empty.setTextColor(Color.parseColor("#94A3B8"));
            empty.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
            empty.setPadding(dp(8), dp(8), dp(8), dp(8));
            listItemsHost.addView(empty);
            return;
        }
        int maxLines = Math.min(distinctLines.size(), 40);
        for (int i = 0; i < maxLines; i++) {
            final String line = distinctLines.get(i);
            TextView row = new TextView(ctx);
            row.setText(line);
            row.setTextColor(Color.WHITE);
            row.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
            row.setPadding(dp(10), dp(8), dp(10), dp(8));
            GradientDrawable rowBg = new GradientDrawable();
            rowBg.setColor(Color.parseColor("#1E293B"));
            rowBg.setCornerRadius(dp(10));
            rowBg.setStroke(dp(1), Color.parseColor("#334155"));
            row.setBackground(rowBg);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            );
            lp.bottomMargin = dp(6);
            row.setOnClickListener(v -> {
                listDrawerContainer.setVisibility(View.GONE);
                clearBoxSelection();
                translateAndShowCard(line, line, "");
            });
            listItemsHost.addView(row, lp);
        }
    }

    private void toggleLineListDrawer() {
        if (listDrawerContainer.getVisibility() == View.VISIBLE) {
            listDrawerContainer.setVisibility(View.GONE);
        } else {
            listDrawerContainer.setVisibility(View.VISIBLE);
        }
    }

    private void translateAllLines() {
        listDrawerContainer.setVisibility(View.GONE);
        clearBoxSelection();
        if (distinctLines.isEmpty()) {
            Toast.makeText(getContext(), "畫面上未偵測到可翻譯文字", Toast.LENGTH_SHORT).show();
            return;
        }
        String joined = TextUtils.join("\n", distinctLines);
        if (joined.length() > 1400) {
            joined = joined.substring(0, 1400);
        }
        translateAndShowCard(joined, joined, "");
    }

    private void translateAndShowCard(String orig, String wholeLine, String langHint) {
        if (TextUtils.isEmpty(orig)) return;
        activeOrigText = orig.trim();
        activeWholeLineText = !TextUtils.isEmpty(wholeLine) ? wholeLine.trim() : activeOrigText;
        activeTransText = "";
        activeLangCode = !TextUtils.isEmpty(langHint) ? langHint : guessLangHint(activeOrigText);

        final int mySeq = ++activeRequestSeq;

        resultLangBadge.setText(activeLangCode.toUpperCase(Locale.ROOT));
        resultOrigView.setText(activeOrigText);
        resultTransView.setText("⏳ 翻譯中...");
        resultSaveBtn.setText("＋ 存單字");
        resultWholeLineBtn.setVisibility(
            (!TextUtils.isEmpty(activeWholeLineText) && !activeWholeLineText.equals(activeOrigText))
                ? View.VISIBLE
                : View.GONE
        );
        resultCardContainer.setVisibility(View.VISIBLE);

        hostCallback.onTranslateRequested(activeOrigText, activeLangCode, translated -> post(() -> {
            if (mySeq != activeRequestSeq) return;
            String clean = translated != null ? translated.trim() : "";
            activeTransText = clean;
            resultTransView.setText(!TextUtils.isEmpty(clean) ? clean : "（暫無翻譯結果，請檢查網路或 API 設定）");
        }));
    }

    private void copyActiveTranslation() {
        String textToCopy = !TextUtils.isEmpty(activeTransText) ? activeTransText : activeOrigText;
        if (TextUtils.isEmpty(textToCopy)) return;
        try {
            ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) {
                cm.setPrimaryClip(ClipData.newPlainText("LZHCard", textToCopy));
                Toast.makeText(getContext(), "已複製翻譯內容", Toast.LENGTH_SHORT).show();
            }
        } catch (Exception ignored) {}
    }

    private void selectBoxView(View target) {
        clearBoxSelection();
        activeSelectedBoxView = target;
        if (target != null) {
            target.setBackground(createTokenBoxDrawable(true));
        }
    }

    private void clearBoxSelection() {
        if (activeSelectedBoxView != null) {
            activeSelectedBoxView.setBackground(createTokenBoxDrawable(false));
            activeSelectedBoxView = null;
        }
    }

    private GradientDrawable createTokenBoxDrawable(boolean selected) {
        GradientDrawable d = new GradientDrawable();
        d.setCornerRadius(dp(5));
        if (selected) {
            d.setColor(Color.parseColor("#5510B981"));
            d.setStroke(dp(2), Color.parseColor("#34D399"));
        } else {
            d.setColor(Color.parseColor("#266366F1"));
            d.setStroke(dp(1), Color.parseColor("#B3818CF8"));
        }
        return d;
    }

    private TextView makeToolbarButton(String label, String bgHex, String textHex) {
        TextView tv = new TextView(getContext());
        tv.setText(label);
        tv.setTextColor(Color.parseColor(textHex));
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        tv.setPadding(dp(10), dp(6), dp(10), dp(6));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor(bgHex));
        bg.setCornerRadius(dp(8));
        tv.setBackground(bg);
        return tv;
    }

    private LinearLayout.LayoutParams makeToolbarBtnLp() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        lp.leftMargin = dp(6);
        return lp;
    }

    private TextView makeCardActionButton(String label, String bgHex, String textHex) {
        TextView tv = new TextView(getContext());
        tv.setText(label);
        tv.setTextColor(Color.parseColor(textHex));
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        tv.setPadding(dp(10), dp(6), dp(10), dp(6));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor(bgHex));
        bg.setCornerRadius(dp(8));
        tv.setBackground(bg);
        return tv;
    }

    private LinearLayout.LayoutParams makeActionBtnLp() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        lp.leftMargin = dp(6);
        return lp;
    }

    private String guessLangHint(String s) {
        if (TextUtils.isEmpty(s)) return "en";
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if ((c >= 0x3040 && c <= 0x30FF) || (c >= 0x31F0 && c <= 0x31FF)) return "ja";
            if (c >= 0xAC00 && c <= 0xD7AF) return "ko";
            if (c >= 0x4E00 && c <= 0x9FFF) return "zh-TW";
        }
        return "en";
    }

    private int getStatusBarFallbackPx() {
        int resId = getResources().getIdentifier("status_bar_height", "dimen", "android");
        if (resId > 0) {
            return getResources().getDimensionPixelSize(resId);
        }
        return dp(28);
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value,
            getResources().getDisplayMetrics()
        );
    }
}
