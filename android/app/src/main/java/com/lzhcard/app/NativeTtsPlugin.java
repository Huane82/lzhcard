package com.lzhcard.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(name = "NativeTts")
public class NativeTtsPlugin extends Plugin implements TextToSpeech.OnInitListener {

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<String, PluginCall> pendingUtteranceCalls = new ConcurrentHashMap<>();

    private TextToSpeech tts;
    private volatile boolean isInitializing = false;
    private volatile boolean isReady = false;
    private volatile int lastInitStatus = TextToSpeech.ERROR;

    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private final AudioManager.OnAudioFocusChangeListener focusChangeListener = focusChange -> {};

    @Override
    public void load() {
        super.load();
        Context ctx = getContext();
        if (ctx != null) {
            audioManager = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        }
        initTtsEngine();
    }

    private synchronized void initTtsEngine() {
        Context ctx = getContext();
        if (ctx == null || isInitializing) return;
        if (tts != null && isReady) return;

        isInitializing = true;
        isReady = false;
        mainHandler.post(() -> {
            try {
                if (tts != null) {
                    try { tts.shutdown(); } catch (Exception ignored) {}
                    tts = null;
                }
                tts = new TextToSpeech(ctx.getApplicationContext(), this);
            } catch (Exception e) {
                isInitializing = false;
                isReady = false;
                lastInitStatus = TextToSpeech.ERROR;
            }
        });
    }

    @Override
    public void onInit(int status) {
        isInitializing = false;
        lastInitStatus = status;
        if (status == TextToSpeech.SUCCESS && tts != null) {
            isReady = true;
            AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
            tts.setAudioAttributes(attrs);
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {}

                @Override
                public void onDone(String utteranceId) {
                    abandonFocusSafely();
                    PluginCall call = utteranceId != null ? pendingUtteranceCalls.remove(utteranceId) : null;
                    if (call != null) {
                        JSObject ret = new JSObject();
                        ret.put("spoken", true);
                        call.resolve(ret);
                    }
                }

                @Override
                public void onError(String utteranceId) {
                    handleUtteranceFailure(utteranceId, "TTS_UTTERANCE_ERROR");
                }

                @Override
                public void onError(String utteranceId, int errorCode) {
                    handleUtteranceFailure(utteranceId, "TTS_UTTERANCE_ERROR_" + errorCode);
                }
            });
        } else {
            isReady = false;
        }
    }

    private void handleUtteranceFailure(String utteranceId, String code) {
        abandonFocusSafely();
        PluginCall call = utteranceId != null ? pendingUtteranceCalls.remove(utteranceId) : null;
        if (call != null) {
            call.reject("Android TextToSpeech playback failed", code);
        }
    }

    private boolean requestSpeechAudioFocus() {
        if (audioManager == null) return true;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();
                audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(attrs)
                    .setOnAudioFocusChangeListener(focusChangeListener)
                    .build();
                int res = audioManager.requestAudioFocus(audioFocusRequest);
                return res == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
            } else {
                int res = audioManager.requestAudioFocus(
                    focusChangeListener,
                    AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
                );
                return res == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
            }
        } catch (Exception e) {
            return true;
        }
    }

    private void abandonFocusSafely() {
        if (audioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
                audioManager.abandonAudioFocusRequest(audioFocusRequest);
            } else {
                audioManager.abandonAudioFocus(focusChangeListener);
            }
        } catch (Exception ignored) {}
    }

    private Locale resolveLocale(String rawLang) {
        if (rawLang == null || rawLang.trim().isEmpty()) {
            return Locale.US;
        }
        String norm = rawLang.trim().replace('_', '-');
        String lower = norm.toLowerCase(Locale.ROOT);
        if (lower.startsWith("ja")) return Locale.JAPAN;
        if (lower.startsWith("ko")) return Locale.KOREA;
        if (lower.equals("zh-tw") || lower.equals("zh-hant") || lower.contains("hant")) {
            return Locale.TRADITIONAL_CHINESE;
        }
        if (lower.startsWith("zh")) return Locale.TRADITIONAL_CHINESE;
        if (lower.equals("en-gb")) return Locale.UK;
        if (lower.startsWith("en")) return Locale.US;
        Locale parsed = Locale.forLanguageTag(norm);
        return (parsed != null && !parsed.getLanguage().isEmpty()) ? parsed : Locale.US;
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            call.reject("Text is empty", "TTS_EMPTY_TEXT");
            return;
        }
        String cleanText = text.trim();
        String lang = call.getString("lang", "en-US");
        float rate = call.getFloat("rate", 1.0f);
        float pitch = call.getFloat("pitch", 1.0f);

        if (!isReady || tts == null) {
            initTtsEngine();
            waitAndSpeak(call, cleanText, lang, rate, pitch, 0);
            return;
        }
        executeSpeak(call, cleanText, lang, rate, pitch);
    }

    private void waitAndSpeak(PluginCall call, String text, String lang, float rate, float pitch, int attempt) {
        if (isReady && tts != null) {
            executeSpeak(call, text, lang, rate, pitch);
            return;
        }
        if (attempt >= 12) {
            call.reject("Android TextToSpeech engine unavailable (status=" + lastInitStatus + ")", "TTS_NOT_READY");
            return;
        }
        mainHandler.postDelayed(() -> waitAndSpeak(call, text, lang, rate, pitch, attempt + 1), 120);
    }

    private void executeSpeak(PluginCall call, String text, String lang, float rate, float pitch) {
        mainHandler.post(() -> {
            if (tts == null || !isReady) {
                call.reject("Android TextToSpeech engine unavailable", "TTS_NOT_READY");
                return;
            }

            Locale targetLocale = resolveLocale(lang);
            int langResult = tts.setLanguage(targetLocale);
            if (langResult == TextToSpeech.LANG_MISSING_DATA || langResult == TextToSpeech.LANG_NOT_SUPPORTED) {
                if ("en".equalsIgnoreCase(targetLocale.getLanguage()) && !Locale.US.equals(targetLocale)) {
                    langResult = tts.setLanguage(Locale.US);
                }
            }

            if (langResult == TextToSpeech.LANG_MISSING_DATA || langResult == TextToSpeech.LANG_NOT_SUPPORTED) {
                call.reject(
                    "Voice data missing or unsupported for locale: " + targetLocale.toLanguageTag(),
                    "TTS_LANGUAGE_UNAVAILABLE"
                );
                return;
            }

            tts.setSpeechRate(Math.max(0.4f, Math.min(2.0f, rate)));
            tts.setPitch(Math.max(0.5f, Math.min(2.0f, pitch)));
            requestSpeechAudioFocus();

            String utteranceId = "lzh_tts_" + UUID.randomUUID();
            for (Map.Entry<String, PluginCall> entry : pendingUtteranceCalls.entrySet()) {
                PluginCall prev = pendingUtteranceCalls.remove(entry.getKey());
                if (prev != null) {
                    JSObject cancelled = new JSObject();
                    cancelled.put("spoken", false);
                    cancelled.put("interrupted", true);
                    prev.resolve(cancelled);
                }
            }
            pendingUtteranceCalls.put(utteranceId, call);

            Bundle params = new Bundle();
            params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC);
            params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f);

            int speakStatus = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, utteranceId);
            if (speakStatus == TextToSpeech.ERROR) {
                pendingUtteranceCalls.remove(utteranceId);
                abandonFocusSafely();
                call.reject("TextToSpeech.speak returned ERROR", "TTS_SPEAK_ERROR");
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        mainHandler.post(() -> {
            try {
                if (tts != null) {
                    tts.stop();
                }
            } catch (Exception ignored) {}
            for (String key : pendingUtteranceCalls.keySet()) {
                PluginCall prev = pendingUtteranceCalls.remove(key);
                if (prev != null) {
                    JSObject res = new JSObject();
                    res.put("spoken", false);
                    prev.resolve(res);
                }
            }
            abandonFocusSafely();
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        abandonFocusSafely();
        pendingUtteranceCalls.clear();
        if (tts != null) {
            try {
                tts.stop();
                tts.shutdown();
            } catch (Exception ignored) {}
            tts = null;
        }
        isReady = false;
    }
}
