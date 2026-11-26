/**
 * LZHCard - AI 萬能多語系解析模組 (AI Core Engine - 雲端會員配額 & 班級共享通道)
 */

// 🌐 Cloudflare Worker 共用後端中繼站網址
const SHARED_BACKEND_URL = "https://lzhcard.tomlin980415.workers.dev";

try {
    localStorage.removeItem('lzhcard_groq_key_v1');
    localStorage.removeItem('flashcard_gemini_key_v1');
    localStorage.removeItem('lzhcard_api_mode');
} catch (e) {}

function safeT(key, params, fallbackStr) {
    if (typeof t === 'function') {
        try {
            const res = t(key, params);
            if (res && res !== key) return res;
        } catch (e) {}
    }
    if (!fallbackStr) fallbackStr = key;
    if (params && typeof params === 'object') {
        Object.keys(params).forEach(k => {
            fallbackStr = fallbackStr.replace(new RegExp(`{\\s*${k}\\s*}`, 'g'), params[k]);
        });
    }
    return fallbackStr;
}

const AI_PRIVACY_CONSENT_KEY = 'lzhcard_ai_privacy_consent_v1';
let _aiConsentPendingResolve = null;

function hasAiPrivacyConsent() {
    try {
        return localStorage.getItem(AI_PRIVACY_CONSENT_KEY) === 'granted';
    } catch (e) {
        return false;
    }
}

function openPrivacyPolicyModal() {
    if (typeof document === 'undefined') return false;
    const modal = document.getElementById('privacyPolicyModal');
    if (!modal) return false;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    if (typeof applyLanguageUI === 'function') applyLanguageUI();
    return true;
}

function closePrivacyPolicyModal() {
    if (typeof document === 'undefined') return;
    const modal = document.getElementById('privacyPolicyModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function _finishAiPrivacyModal(granted) {
    const modal = typeof document !== 'undefined' ? document.getElementById('aiPrivacyConsentModal') : null;
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
    const resolver = _aiConsentPendingResolve;
    _aiConsentPendingResolve = null;
    if (typeof resolver === 'function') {
        resolver(Boolean(granted));
    }
}

function grantAiPrivacyConsent() {
    try {
        localStorage.setItem(AI_PRIVACY_CONSENT_KEY, 'granted');
    } catch (e) {}
    _finishAiPrivacyModal(true);
    if (typeof showToast === 'function') {
        showToast(safeT('toastAiConsentGranted', null, '已同意 AI 資料隱私授權，可隨時於「設定 → 隱私設定」調整。'), 'success');
    }
}

function declineAiPrivacyConsent() {
    try {
        localStorage.setItem(AI_PRIVACY_CONSENT_KEY, 'declined');
    } catch (e) {}
    _finishAiPrivacyModal(false);
    if (typeof showToast === 'function') {
        showToast(safeT('toastAiConsentDeclined', null, '已維持僅離線／本機模式，不會傳送影像或字詞至雲端 AI。'), 'info');
    }
}

async function ensureAiPrivacyConsent(options = {}) {
    const forceOpen = Boolean(options && options.forceOpen);
    if (!forceOpen && hasAiPrivacyConsent()) return true;
    if (typeof document === 'undefined') return false;

    const modal = document.getElementById('aiPrivacyConsentModal');
    if (!modal) return true;

    if (typeof applyLanguageUI === 'function') applyLanguageUI();

    if (_aiConsentPendingResolve) {
        try { _aiConsentPendingResolve(false); } catch (e) {}
        _aiConsentPendingResolve = null;
    }

    return new Promise((resolve) => {
        _aiConsentPendingResolve = resolve;
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    });
}

if (typeof window !== 'undefined') {
    window.AI_PRIVACY_CONSENT_KEY = AI_PRIVACY_CONSENT_KEY;
    window.hasAiPrivacyConsent = hasAiPrivacyConsent;
    window.ensureAiPrivacyConsent = ensureAiPrivacyConsent;
    window.grantAiPrivacyConsent = grantAiPrivacyConsent;
    window.declineAiPrivacyConsent = declineAiPrivacyConsent;
    window.openPrivacyPolicyModal = openPrivacyPolicyModal;
    window.closePrivacyPolicyModal = closePrivacyPolicyModal;
}

async function getOptionalFirebaseIdToken() {
    try {
        if (typeof firebase !== 'undefined' && firebase.auth) {
            const user = firebase.auth().currentUser;
            if (user && !user.isAnonymous && typeof user.getIdToken === 'function') {
                return await user.getIdToken(false);
            }
        }
    } catch (e) {}
    return '';
}

function resolveAiFeatureName(options = {}) {
    if (options && typeof options.feature === 'string' && options.feature.trim()) {
        return options.feature.trim();
    }
    if (options && ((options.inlineData && options.inlineData.data) || (Array.isArray(options.inlineDataList) && options.inlineDataList.length > 0))) {
        return 'vision_ocr';
    }
    return 'def_fill';
}

function hasInlineMediaPayload(options = {}) {
    if (!options || typeof options !== 'object') return false;
    if (options.inlineData && options.inlineData.data) return true;
    if (Array.isArray(options.inlineDataList) && options.inlineDataList.some(item => item && item.data)) return true;
    if (Array.isArray(options.parts) && options.parts.some(p => p && p.inlineData && p.inlineData.data)) return true;
    return false;
}

function createQuotaExceededError(message, feature, serverData = null) {
    const err = new Error(message || 'AI 配額已達上限');
    err.code = 'QUOTA_EXCEEDED';
    err.status = 429;
    err.feature = feature;
    err.fallbackTier1 = true;
    err.serverData = serverData;
    return err;
}

/**
 * 🧩 組裝 Gemini API 多模態 contents 結構（向後相容純文字與圖片 inlineData）
 */
function buildGeminiContents(promptText, options = {}) {
    if (options && Array.isArray(options.parts) && options.parts.length > 0) {
        return [{ parts: options.parts }];
    }

    const parts = [];
    if (promptText !== undefined && promptText !== null && String(promptText).length > 0) {
        parts.push({ text: String(promptText) });
    }

    if (options && options.inlineData && options.inlineData.data) {
        parts.push({
            inlineData: {
                mimeType: options.inlineData.mimeType || 'image/jpeg',
                data: options.inlineData.data
            }
        });
    }

    if (options && Array.isArray(options.inlineDataList)) {
        options.inlineDataList.forEach(item => {
            if (item && item.data) {
                parts.push({
                    inlineData: {
                        mimeType: item.mimeType || 'image/jpeg',
                        data: item.data
                    }
                });
            }
        });
    }

    if (parts.length === 0) {
        parts.push({ text: '' });
    }

    return [{ parts }];
}

function resolveClassroomGroupIdForAi(options = {}) {
    if (options && typeof options.classGroupId === 'string' && options.classGroupId.trim()) {
        return options.classGroupId.trim();
    }
    try {
        if (typeof window !== 'undefined' && window.ClassroomEngine && typeof window.ClassroomEngine.getSponsorGroupId === 'function') {
            return String(window.ClassroomEngine.getSponsorGroupId() || '').trim();
        }
    } catch (e) {}
    return '';
}

/**
 * 🌐 全域底層 AI 呼叫函式（經 Cloudflare Worker 驗證會員配額或班級教師共享配額）
 */
async function callGeminiApi(promptText, options = {}) {
    const silent = Boolean(options && options.silent);
    const skipPrivacyPrompt = Boolean(options && options.skipPrivacyPrompt);
    if (!skipPrivacyPrompt && !hasAiPrivacyConsent()) {
        if (silent) {
            throw new Error('AI_PRIVACY_CONSENT_REQUIRED');
        }
        const consentOk = await ensureAiPrivacyConsent({ feature: resolveAiFeatureName(options) });
        if (!consentOk) {
            throw new Error('使用者選擇僅使用離線與本機功能');
        }
    }
    return await fetchViaSharedProxy(promptText, options);
}

async function fetchViaSharedProxy(promptText, options = {}) {
    const silent = Boolean(options && options.silent);
    const feature = resolveAiFeatureName(options);
    const classGroupId = resolveClassroomGroupIdForAi(options);

    // 若未帶入班級共享群組且本地快取已知無資格，快速阻斷節省網路往返
    if (!classGroupId && typeof MembershipEngine !== 'undefined' && typeof MembershipEngine.canConsumeAiQuota === 'function') {
        const check = MembershipEngine.canConsumeAiQuota(feature, { classGroupId });
        if (!check.allowed && check.dailyLimit === 0) {
            const errMsg = safeT('toastQuotaFeaturePaidOnly', { feat: feature }, '此雲端 AI 進階功能需會員方案或由班級教師方案提供！');
            if (!silent && typeof MembershipEngine.showQuotaUpgradePrompt === 'function') {
                MembershipEngine.showQuotaUpgradePrompt(feature);
            }
            throw createQuotaExceededError(errMsg, feature, null);
        }
    }

    const contentsPayload = buildGeminiContents(promptText, options);
    const idToken = await getOptionalFirebaseIdToken();
    const headers = {
        'Content-Type': 'application/json',
        'X-AI-Feature': feature
    };
    if (idToken) {
        headers['Authorization'] = `Bearer ${idToken}`;
    }
    if (classGroupId) {
        headers['X-Class-Group-Id'] = classGroupId;
    }

    const bodyPayload = {
        feature,
        contents: contentsPayload
    };
    if (classGroupId) {
        bodyPayload.classGroupId = classGroupId;
    }

    try {
        const res = await fetch(SHARED_BACKEND_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify(bodyPayload)
        });

        if (res.ok) {
            const data = await res.json();
            if (!data._classroomSponsor) {
                if (data && data._quota && typeof MembershipEngine !== 'undefined' && typeof MembershipEngine.syncQuotaFromServer === 'function') {
                    MembershipEngine.syncQuotaFromServer(data._quota);
                } else if (typeof MembershipEngine !== 'undefined' && typeof MembershipEngine.consumeLocalQuota === 'function') {
                    MembershipEngine.consumeLocalQuota(feature);
                }
            }
            return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } else if (res.status === 429) {
            const errData = await res.json().catch(() => ({}));
            if (errData && errData.quota && typeof MembershipEngine !== 'undefined' && typeof MembershipEngine.syncQuotaFromServer === 'function') {
                MembershipEngine.syncQuotaFromServer(errData.quota);
            } else if (typeof LZHEntitlements !== 'undefined' && typeof LZHEntitlements.notifyStateChange === 'function') {
                LZHEntitlements.notifyStateChange('quota_exhausted_429', { feature });
            }
            if (!silent) {
                if (typeof MembershipEngine !== 'undefined' && typeof MembershipEngine.showQuotaUpgradePrompt === 'function') {
                    MembershipEngine.showQuotaUpgradePrompt(feature);
                } else if (typeof showToast === 'function') {
                    showToast(errData.error || "雲端 AI 配額已達上限或需升級會員方案！", "warning");
                }
            }
            throw createQuotaExceededError(errData.error || "雲端 AI 配額已達上限 (429)", feature, errData);
        } else {
            const errData = await res.json().catch(() => ({}));
            if (res.status === 403 && errData && errData.code === 'ACCOUNT_BANNED') {
                if (typeof AdminConsole !== 'undefined' && typeof AdminConsole.showBanNoticeModal === 'function') {
                    AdminConsole.showBanNoticeModal(errData.ban || { isBanned: true, reason: errData.error });
                }
            }
            const errorMsg = errData.error || `伺服器回應異常 (${res.status})`;
            console.error('[Shared API Proxy Error]:', errorMsg);
            throw new Error(errorMsg);
        }
    } catch (e) {
        if (e && e.code === 'QUOTA_EXCEEDED') throw e;
        console.error('[Shared API Proxy Exception]:', e);
        const failMessage = e.message === 'Failed to fetch'
            ? '網路連線失敗或 Worker CORS 跨域遭阻擋'
            : e.message;
        throw new Error(failMessage);
    }
}

async function requestFastRefineWithAuth(payload) {
    const cleanPayload = { ...(payload || {}) };
    const classGroupId = resolveClassroomGroupIdForAi(cleanPayload);
    const idToken = await getOptionalFirebaseIdToken();
    const headers = { 'Content-Type': 'application/json' };
    if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
    if (classGroupId) {
        headers['X-Class-Group-Id'] = classGroupId;
        cleanPayload.classGroupId = classGroupId;
    }

    const resp = await fetch(`${SHARED_BACKEND_URL}/ai/fast-refine`, {
        method: 'POST',
        headers,
        body: JSON.stringify(cleanPayload)
    });

    if (resp.status === 429) {
        const errData = await resp.json().catch(() => ({}));
        if (errData && errData.quota && typeof MembershipEngine !== 'undefined' && typeof MembershipEngine.syncQuotaFromServer === 'function') {
            MembershipEngine.syncQuotaFromServer(errData.quota);
        }
        throw createQuotaExceededError(errData.error || '字幕精修額度已用畢', 'fast_refine', errData);
    }

    if (!resp.ok) {
        if (resp.status === 403) {
            const errData = await resp.json().catch(() => ({}));
            if (errData && errData.code === 'ACCOUNT_BANNED' && typeof AdminConsole !== 'undefined' && typeof AdminConsole.showBanNoticeModal === 'function') {
                AdminConsole.showBanNoticeModal(errData.ban || { isBanned: true, reason: errData.error });
            }
        }
        throw new Error(`HTTP ${resp.status}`);
    }

    const data = await resp.json();
    if (data && data.quota && typeof MembershipEngine !== 'undefined' && typeof MembershipEngine.syncQuotaFromServer === 'function') {
        MembershipEngine.syncQuotaFromServer(data.quota);
    }
    return String((data && data.translation) || '').trim();
}

function safeParseJSON(rawText) {
    if (!rawText) return null;

    let cleaned = rawText
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();

    const firstBracket = cleaned.indexOf('[');
    const firstBrace = cleaned.indexOf('{');

    if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
        const lastBracket = cleaned.lastIndexOf(']');
        cleaned = lastBracket > firstBracket
            ? cleaned.slice(firstBracket, lastBracket + 1)
            : cleaned.slice(firstBracket);
    } else if (firstBrace !== -1) {
        const lastBrace = cleaned.lastIndexOf('}');
        cleaned = lastBrace > firstBrace
            ? cleaned.slice(firstBrace, lastBrace + 1)
            : cleaned.slice(firstBrace);
    }

    try { return JSON.parse(cleaned); } catch (e1) {}

    try {
        const fixedNewlines = cleaned.replace(/(?<!\\)\n/g, "\\n");
        return JSON.parse(fixedNewlines);
    } catch (e2) {}

    if (cleaned.startsWith('[')) {
        const lastCompleteObjEnd = cleaned.lastIndexOf('}');
        if (lastCompleteObjEnd !== -1) {
            const salvagedArray = cleaned.slice(0, lastCompleteObjEnd + 1) + ']';
            try { return JSON.parse(salvagedArray); } catch (e3) {}
        }
    }

    let repaired = cleaned;
    const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) repaired += '"';

    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;
    if (openBraces > closeBraces) repaired += '}'.repeat(openBraces - closeBraces);

    const openBrackets = (repaired.match(/\[/g) || []).length;
    const closeBrackets = (repaired.match(/\]/g) || []).length;
    if (openBrackets > closeBrackets) repaired += ']'.repeat(openBrackets - closeBrackets);

    try { return JSON.parse(repaired); } catch (e4) {}

    const objects = [];
    const matches = cleaned.match(/\{[^{}]*\}/g) || [];
    for (const m of matches) {
        try {
            const parsed = JSON.parse(m);
            if (parsed && parsed.word) objects.push(parsed);
        } catch (e) {}
    }

    if (objects.length > 0) return objects;
    return null;
}

/**
 * 🛡️ 增強版欄位完整性與語言錯植檢查
 */
function isFieldIncomplete(val, fieldType = '') {
    if (!val) return true;
    const str = String(val).trim();
    if (str === '' || str === '-' || str === 'N/A' || str === 'EMPTY' || str === '""' || str === 'undefined' || str === 'null') return true;

    const pendingKeywords = [
        '解析中', 'parsing', '尚未填寫', '未入力', '待補齊',
        'no definition', 'pending', '自動解析', 'no sentence',
        '無例句', '未設定例句', '無翻譯', '未設定', 'empty',
        '無母語釋意', '無母語釋義', '無釋意', '無釋義', '無中文釋義', '無中文釋意', '尚無釋義', '暫無釋義'
    ];

    if (pendingKeywords.some(keyword => str.toLowerCase().includes(keyword.toLowerCase()))) {
        return true;
    }

    const targetLang = localStorage.getItem('lzhcard_target_lang') || 'en';
    const nativeLang = localStorage.getItem('lzhcard_native_lang') || 'zh-TW';

    if (fieldType === 'sentence') {
        if (targetLang === 'en' && /[\u3040-\u30ff\u4e00-\u9fff]/.test(str)) {
            return true;
        }
        if (targetLang === 'ja' && !/[\u3040-\u30ff\u4e00-\u9fff]/.test(str) && /[a-zA-Z]/.test(str)) {
            return true;
        }
        if ((targetLang === 'zh-TW' || targetLang === 'zh') && !/[\u4e00-\u9fff]/.test(str) && /[a-zA-Z]/.test(str)) {
            return true;
        }
    }

    if (fieldType === 'meaning' || fieldType === 'translation') {
        if ((nativeLang === 'zh-TW' || nativeLang === 'zh') && !/[\u4e00-\u9fff]/.test(str) && /[a-zA-Z]/.test(str)) {
            return true;
        }
        if (nativeLang === 'ja' && !/[\u3040-\u30ff\u4e00-\u9fff]/.test(str) && /[a-zA-Z]/.test(str)) {
            return true;
        }
        if (nativeLang === 'en' && /[\u3040-\u30ff\u4e00-\u9fff]/.test(str)) {
            return true;
        }
    }

    return false;
}

function getLanguageConfig() {
    const targetLang = localStorage.getItem('lzhcard_target_lang') || 'en';
    const nativeLang = localStorage.getItem('lzhcard_native_lang') || 'zh-TW';
    const customTarget = (localStorage.getItem('lzhcard_custom_target') || '').trim();
    const customNative = (localStorage.getItem('lzhcard_custom_native') || '').trim();

    const langNameMap = {
        'en': 'English',
        'ja': 'Japanese (日本語)',
        'zh-TW': 'Traditional Chinese (繁體中文, 臺灣標準)',
        'custom': ''
    };

    const targetName = targetLang === 'custom'
        ? (customTarget || 'English')
        : (langNameMap[targetLang] || 'English');

    const nativeName = nativeLang === 'custom'
        ? (customNative || 'Auto-Detect Native Language')
        : (langNameMap[nativeLang] || 'Traditional Chinese (繁體中文)');

    return { targetLang, nativeLang, targetName, nativeName };
}

function sanitizeWordAndPos(rawWord, rawPos, rawMeaning) {
    let word = (rawWord || '').trim();
    let pos = (rawPos || '').trim();
    let meaning = (rawMeaning || '').trim();

    word = word.replace(/[\(\[（【]?\s*(?:無母語釋意|無母語釋義|無釋意|無釋義|無中文釋義|無中文釋意|解析中|自動解析中\.\.\.)\s*[\)\]）】]?/gi, '').trim();

    const posUnit = '(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|art|phr|名詞|代名詞|動詞|他動詞|自動詞|形容詞|形容動詞|副詞|助詞|感動詞|連體詞|接続詞)';
    const multiPosRegex = new RegExp(
        `(?:[\\(\\[\\{]\\s*${posUnit}(?:[\\s\\.\\,\\/\\\\&|]+${posUnit})*[\\.\\s]*[\\)\\]\\}])` +
        `|(?:\\b${posUnit}\\.(?:[\\s\\,\\/\\\\&|]*${posUnit}\\.)*)` +
        `|(?:\\b(?:名詞|代名詞|動詞|他動詞|自動詞|形容詞|形容動詞|副詞|助詞|感動詞|連體詞|接続詞)(?:[\\s\\,\\/\\\\&|]+(?:名詞|代名詞|動詞|他動詞|自動詞|形容詞|形容動詞|副詞|助詞|感動詞|連體詞|接続詞))*\\b)`,
        'gi'
    );

    if (word) {
        const match = word.match(multiPosRegex);
        if (match && match[0].length < word.length) {
            if (!pos) pos = match[0].replace(/[\(\[\{\)\]\}]/g, '').trim();
            word = word.replace(match[0], '').trim();
        }
    }

    if (meaning) {
        const match = meaning.match(multiPosRegex);
        if (match && match[0].length < meaning.length) {
            if (!pos) pos = match[0].replace(/[\(\[\{\)\]\}]/g, '').trim();
            meaning = meaning.replace(match[0], '').trim();
        }
    }

    return { word, pos, meaning };
}

async function autoFillWithAI(word) {
    const cleaned = sanitizeWordAndPos(word, '', '');
    const cleanWord = cleaned.word;
    const { targetLang, targetName, nativeName } = getLanguageConfig();
    const phoneticRule = targetLang === 'ja'
        ? 'Pure Hiragana reading ONLY (純平假名讀音, e.g. はじめ; NEVER use Romaji like [hajime] or IPA)'
        : 'IPA or pronunciation guide for the corrected word';

    const prompt = `You are a professional lexicographer.
Input Term: "${cleanWord}"
Target Language: ${targetName}
User Native Language: ${nativeName}

MANDATORY INSTRUCTIONS:
1. "word": Automatically fix any common spelling typos in "${cleanWord}" (e.g. "enviroment" -> "environment", "recieve" -> "receive"). If the spelling is already valid (including valid phrases, idioms, Japanese words, or proper nouns), keep it unchanged.
2. "phonetic": ${phoneticRule} (MUST NOT BE EMPTY).
3. "pos": Parts of speech translated in ${nativeName} (MUST NOT BE EMPTY).
4. "meaning": Precise definition strictly in ${nativeName} (MUST NOT BE EMPTY).
5. "sentence": A natural example sentence written strictly in ${targetName} using the corrected word (MUST NOT BE EMPTY).
6. "translation": Example sentence translation strictly written in ${nativeName} (MUST NOT BE EMPTY).

Return ONLY a valid raw JSON object:
{
  "word": "corrected spelling of ${cleanWord}",
  "phonetic": "Pronunciation",
  "pos": "POS in ${nativeName}",
  "meaning": "Definition in ${nativeName}",
  "sentence": "Example sentence in ${targetName}",
  "translation": "Translation in ${nativeName}"
}`;

    try {
        const rawResponse = await callGeminiApi(prompt, { feature: 'def_fill' });
        const parsed = safeParseJSON(rawResponse);
        if (parsed && parsed.word) {
            const wordInputElem = document.getElementById('formWord');
            if (wordInputElem && parsed.word.trim() && parsed.word.trim() !== cleanWord) {
                wordInputElem.value = parsed.word.trim();
            }
        }
        return parsed;
    } catch (e) {
        if (e && e.code !== 'QUOTA_EXCEEDED' && typeof showToast === 'function') {
            showToast("AI 解析失敗：" + e.message, "error");
        }
        return null;
    }
}

/**
 * 🤖 批次 AI 欄位補充核心邏輯
 */
async function runBatchAiAutoFill(targetList, progressCallback, forceOverwrite = false) {
    const resolveLiveItem = (item) => {
        if (item && item.id && typeof wordList !== 'undefined' && Array.isArray(wordList)) {
            return wordList.find(w => w.id === item.id) || item;
        }
        return item;
    };

    const initialLiveList = targetList.map(resolveLiveItem);
    const targetItems = forceOverwrite ? initialLiveList : initialLiveList.filter(item =>
        isFieldIncomplete(item.meaning, 'meaning') ||
        isFieldIncomplete(item.pos, 'pos') ||
        isFieldIncomplete(item.sentence, 'sentence') ||
        isFieldIncomplete(item.translation, 'translation') ||
        isFieldIncomplete(item.phonetic, 'phonetic')
    );

    const total = targetItems.length;
    if (total === 0) return 0;

    const { targetLang, targetName, nativeName } = getLanguageConfig();
    const phoneticRule = targetLang === 'ja'
        ? 'MUST provide Pure Hiragana reading ONLY (純平假名讀音, e.g. はじめ; NEVER use Romaji or IPA).'
        : 'MUST provide IPA pronunciation guide for the corrected word (DO NOT LEAVE EMPTY).';

    const batchSize = 20;
    let completedCount = 0;
    let successUpdatedCount = 0;
    let lastBatchError = '';
    const updatedKeys = new Set();

    const normalizeWord = str => (str || '').toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf]/g, '');

    const buildBatchPrompt = (cleanInputs) => `You are an expert lexicographer.
Input Terms (JSON array with index and term): ${JSON.stringify(cleanInputs)}
Target Language: ${targetName}
User Native Language: ${nativeName}

CRITICAL RULES (STRICT COMPLIANCE REQUIRED):
1. "index": MUST keep the exact integer "index" from the input item so each result maps back 1-to-1.
2. "word": Automatically correct any common spelling typos in the input term (e.g., "enviroment" -> "environment"). If the term is already valid (including Japanese words, phrases, or idioms), keep it unchanged.
3. "phonetic": ${phoneticRule}
4. "pos": MUST provide part of speech strictly in ${nativeName}.
5. "meaning": MUST provide clear definition strictly in ${nativeName}.
6. "sentence": MUST provide a complete example sentence strictly in ${targetName} (DO NOT LEAVE EMPTY).
7. "translation": MUST provide translation of sentence strictly in ${nativeName} (DO NOT LEAVE EMPTY).

Return ONLY a valid JSON array with no markdown or extra text:
[
  {
    "index": 0,
    "word": "term",
    "pos": "POS in ${nativeName}",
    "phonetic": "hiragana or IPA",
    "meaning": "definition in ${nativeName}",
    "sentence": "example sentence in ${targetName}",
    "translation": "translation in ${nativeName}"
  }
]`;

    const applyResultsToChunk = (chunk, results) => {
        let chunkMatched = 0;
        results.forEach((resItem, resIdx) => {
            if (!resItem || typeof resItem !== 'object') return;

            let matched = null;
            const parsedIndex = (resItem.index !== undefined && resItem.index !== null && resItem.index !== '')
                ? Number(resItem.index)
                : NaN;

            if (!Number.isNaN(parsedIndex) && chunk[parsedIndex]) {
                matched = chunk[parsedIndex];
            }

            const cleanRes = normalizeWord(resItem.word || '');
            if (!matched && cleanRes) {
                matched = chunk.find(p => p && p.word && normalizeWord(p.word) === cleanRes);
            }
            if (!matched && results.length === chunk.length && chunk[resIdx]) {
                matched = chunk[resIdx];
            }

            if (matched) {
                const target = resolveLiveItem(matched);
                const sanitizedRes = sanitizeWordAndPos(resItem.word || target.word, resItem.pos || '', resItem.meaning || '');
                const correctedWord = (sanitizedRes.word || String(resItem.word || target.word)).trim();

                if (correctedWord && !isFieldIncomplete(correctedWord)) {
                    target.word = correctedWord;
                }

                if ((forceOverwrite || isFieldIncomplete(target.pos, 'pos')) && sanitizedRes.pos) target.pos = sanitizedRes.pos;
                if ((forceOverwrite || isFieldIncomplete(target.phonetic, 'phonetic')) && resItem.phonetic) target.phonetic = String(resItem.phonetic).trim();
                if ((forceOverwrite || isFieldIncomplete(target.meaning, 'meaning')) && sanitizedRes.meaning) target.meaning = sanitizedRes.meaning;
                if ((forceOverwrite || isFieldIncomplete(target.sentence, 'sentence')) && resItem.sentence) target.sentence = String(resItem.sentence).trim();
                if ((forceOverwrite || isFieldIncomplete(target.translation, 'translation')) && resItem.translation) target.translation = String(resItem.translation).trim();

                target.updatedAt = Date.now();
                const trackKey = target.id || target;
                if (!updatedKeys.has(trackKey)) {
                    updatedKeys.add(trackKey);
                    successUpdatedCount++;
                }
                chunkMatched++;
            }
        });
        return chunkMatched;
    };

    const executeChunkWithRetry = async (chunk, allowSplit = true) => {
        const cleanChunkInputs = chunk.map((item, idx) => {
            const live = resolveLiveItem(item);
            const sanitized = sanitizeWordAndPos(live.word || '', '', '');
            const cleanTerm = sanitized.word || String(live.word || '').trim();
            return { index: idx, word: cleanTerm };
        });

        const prompt = buildBatchPrompt(cleanChunkInputs);
        let parsedArray = null;
        let attempt = 0;
        const maxAttempts = 2;

        while (!parsedArray && attempt < maxAttempts) {
            attempt++;
            try {
                const rawResponse = await callGeminiApi(prompt, { feature: 'def_fill' });
                const parsed = safeParseJSON(rawResponse);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    parsedArray = parsed;
                } else {
                    lastBatchError = 'AI 回傳 JSON 格式異常或被截斷';
                    console.warn(`[AI Batch Parse Retry] 第 ${attempt} 次解析未取得有效陣列，原始前 120 字:`, String(rawResponse || '').slice(0, 120));
                }
            } catch (err) {
                lastBatchError = err.message;
                if (err.code === 'QUOTA_EXCEEDED' || (err.message && (err.message.includes('API Key') || err.message.includes('限流') || err.message.includes('配額')))) {
                    throw err;
                }
            }

            if (!parsedArray && attempt < maxAttempts) {
                await new Promise(r => setTimeout(r, 1500));
            }
        }

        if (parsedArray) {
            applyResultsToChunk(chunk, parsedArray);
            if (typeof saveStorage === 'function') saveStorage();
            if (typeof renderWordList === 'function') renderWordList(false);
            return;
        }

        if (allowSplit && chunk.length > 5) {
            console.warn(`[AI Batch Split] 批次解析失敗 (${lastBatchError})，自動拆分為 5 字小批重試...`);
            const mid = Math.ceil(chunk.length / 2);
            await executeChunkWithRetry(chunk.slice(0, mid), false);
            await executeChunkWithRetry(chunk.slice(mid), false);
            return;
        }

        console.error(`[AI Batch Error] 子批次處理失敗 (${lastBatchError}):`, cleanChunkInputs);
        if (successUpdatedCount === 0 && completedCount === 0) {
            throw new Error(lastBatchError || '連線至 AI 伺服器失敗');
        }
    };

    for (let i = 0; i < total; i += batchSize) {
        const chunk = targetItems.slice(i, i + batchSize);
        await executeChunkWithRetry(chunk, true);

        completedCount += chunk.length;
        if (progressCallback) {
            progressCallback(completedCount, total);
        }

        if (i + batchSize < total) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    const currentLiveItems = targetItems.map(resolveLiveItem);
    const missedItems = currentLiveItems.filter(item =>
        !updatedKeys.has(item.id || item) ||
        isFieldIncomplete(item.meaning, 'meaning') ||
        isFieldIncomplete(item.pos, 'pos') ||
        isFieldIncomplete(item.sentence, 'sentence') ||
        isFieldIncomplete(item.translation, 'translation') ||
        isFieldIncomplete(item.phonetic, 'phonetic')
    );

    if (missedItems.length > 0 && missedItems.length < total) {
        console.log(`[AI Batch Sweep] 偵測到 ${missedItems.length} 筆漏網單字，啟動 5 字小批自動補掃...`);
        const sweepSize = 5;
        for (let j = 0; j < missedItems.length; j += sweepSize) {
            const sweepChunk = missedItems.slice(j, j + sweepSize);
            try {
                await executeChunkWithRetry(sweepChunk, false);
                await new Promise(resolve => setTimeout(resolve, 800));
            } catch (sweepErr) {
                lastBatchError = sweepErr.message;
                console.warn('[AI Batch Sweep Warning]:', sweepErr);
                if (sweepErr.code === 'QUOTA_EXCEEDED') break;
            }
        }
    }

    if (successUpdatedCount === 0) {
        throw new Error(lastBatchError || "AI 未能成功解析任何單字，請稍後再試");
    }

    if (successUpdatedCount < total && lastBatchError && typeof showToast === 'function') {
        showToast(`部分單字未完成 (${successUpdatedCount}/${total})，原因：${lastBatchError}`, 'warning');
    }

    return successUpdatedCount;
}

/**
 * 🔊 跨平台單字與語句語音引擎（Android 原生 TextToSpeech 優先 -> Web speechSynthesis 監看 -> 線上詞典/TTS 音訊串流備援）
 */
(function initLzhUnifiedAudioTts(global) {
    if (!global || global.LZHAudioTts) return;

    let ttsPlaySeq = 0;
    let activeHtmlAudio = null;

    function getCapacitorPlatformName() {
        try {
            if (global.Capacitor && typeof global.Capacitor.getPlatform === 'function') {
                return String(global.Capacitor.getPlatform() || '').toLowerCase();
            }
        } catch (e) {}
        const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '';
        if (/android/i.test(ua)) return 'android';
        if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
        return 'web';
    }

    function normalizeTtsLocale(langCode) {
        const raw = String(langCode || '').trim().toLowerCase();
        if (!raw) return 'en-US';
        if (raw.startsWith('ja')) return 'ja-JP';
        if (raw.startsWith('ko')) return 'ko-KR';
        if (raw.startsWith('zh')) return 'zh-TW';
        if (raw === 'en-gb') return 'en-GB';
        if (raw.startsWith('en')) return 'en-US';
        return String(langCode);
    }

    function buildOnlineAudioFallbackUrls(text, locale) {
        const encoded = encodeURIComponent(text);
        const lower = locale.toLowerCase();
        if (lower.startsWith('ja')) {
            return [
                `https://dict.youdao.com/dictvoice?audio=${encoded}&le=jap`,
                `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=ja&q=${encoded}`
            ];
        }
        if (lower.startsWith('ko')) {
            return [
                `https://dict.youdao.com/dictvoice?audio=${encoded}&le=ko`,
                `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=ko&q=${encoded}`
            ];
        }
        if (lower.startsWith('zh')) {
            return [
                `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=zh-TW&q=${encoded}`
            ];
        }
        return [
            `https://dict.youdao.com/dictvoice?audio=${encoded}&type=2`,
            `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${encoded}`
        ];
    }

    function stopAllAudio() {
        ttsPlaySeq++;
        if (activeHtmlAudio) {
            try {
                activeHtmlAudio.pause();
                activeHtmlAudio.removeAttribute('src');
                activeHtmlAudio.load();
            } catch (e) {}
            activeHtmlAudio = null;
        }
        try {
            const nativeTts = global.Capacitor?.Plugins?.NativeTts;
            if (nativeTts && typeof nativeTts.stop === 'function') {
                nativeTts.stop().catch(() => {});
            }
        } catch (e) {}
        try {
            const capTts = global.Capacitor?.Plugins?.TextToSpeech;
            if (capTts && typeof capTts.stop === 'function') {
                capTts.stop().catch(() => {});
            }
        } catch (e) {}
        try {
            if (typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.speechSynthesis.cancel === 'function') {
                window.speechSynthesis.cancel();
            }
        } catch (e) {}
    }

    async function tryWebSpeechWithWatchdog(text, locale, mySeq) {
        if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
            return false;
        }
        return await new Promise((resolve) => {
            let settled = false;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(watchdog);
                resolve(Boolean(ok));
            };

            const watchdog = setTimeout(() => {
                // 小米 HyperOS / Android WebView 常發生 speechSynthesis.speak 靜默不觸發事件也不發音
                try {
                    if (window.speechSynthesis.speaking) {
                        finish(true);
                        return;
                    }
                    window.speechSynthesis.cancel();
                } catch (e) {}
                finish(false);
            }, 900);

            try {
                window.speechSynthesis.cancel();
                const u = new SpeechSynthesisUtterance(text);
                u.lang = locale;
                u.onstart = () => finish(true);
                u.onend = () => finish(true);
                u.onerror = () => finish(false);
                if (mySeq !== ttsPlaySeq) {
                    finish(true);
                    return;
                }
                window.speechSynthesis.speak(u);
            } catch (e) {
                finish(false);
            }
        });
    }

    async function tryOnlineAudioStreamFallback(text, locale, mySeq) {
        if (typeof Audio === 'undefined') return false;
        const urls = buildOnlineAudioFallbackUrls(text, locale);
        for (const url of urls) {
            if (mySeq !== ttsPlaySeq) return true;
            const played = await new Promise((resolve) => {
                let done = false;
                const finish = (ok) => {
                    if (done) return;
                    done = true;
                    resolve(Boolean(ok));
                };
                try {
                    const audio = new Audio();
                    audio.preload = 'auto';
                    audio.src = url;
                    activeHtmlAudio = audio;
                    const timeout = setTimeout(() => finish(false), 4500);
                    audio.onended = () => {
                        clearTimeout(timeout);
                        if (activeHtmlAudio === audio) activeHtmlAudio = null;
                        finish(true);
                    };
                    audio.onerror = () => {
                        clearTimeout(timeout);
                        if (activeHtmlAudio === audio) activeHtmlAudio = null;
                        finish(false);
                    };
                    const playPromise = audio.play();
                    if (playPromise && typeof playPromise.then === 'function') {
                        playPromise.then(() => {
                            clearTimeout(timeout);
                            finish(true);
                        }).catch(() => {
                            clearTimeout(timeout);
                            if (activeHtmlAudio === audio) activeHtmlAudio = null;
                            finish(false);
                        });
                    }
                } catch (e) {
                    finish(false);
                }
            });
            if (played) return true;
        }
        return false;
    }

    async function speakText(text, langCode = 'en-US', options = {}) {
        const clean = String(text || '').trim();
        if (!clean) return false;
        const locale = normalizeTtsLocale(langCode);
        const platform = getCapacitorPlatformName();
        const isNative = typeof global.isNativeApp === 'function'
            ? Boolean(global.isNativeApp())
            : (platform === 'android' || platform === 'ios');

        if (!options.keepPrevious) {
            stopAllAudio();
        }
        const mySeq = ttsPlaySeq;
        const rate = Number(options.rate) || 1.0;
        const pitch = Number(options.pitch) || 1.0;

        // 1. Android 原生優先：呼叫 NativeTtsPlugin（支援 AudioAttributes / AudioFocus / 缺語音包明確 reject）
        const nativeTts = global.Capacitor?.Plugins?.NativeTts;
        if (platform === 'android' && nativeTts && typeof nativeTts.speak === 'function') {
            try {
                await nativeTts.speak({ text: clean, lang: locale, rate, pitch });
                return true;
            } catch (nativeErr) {
                console.warn('[LZHAudioTts] Android NativeTts failed, triggering fallback:', nativeErr);
            }
        }
        if (mySeq !== ttsPlaySeq) return true;

        // 2. Capacitor TextToSpeech 外掛（iOS 主力 / Android 備援）
        const capTts = global.Capacitor?.Plugins?.TextToSpeech;
        if (isNative && capTts && typeof capTts.speak === 'function') {
            try {
                await capTts.speak({
                    text: clean,
                    lang: locale,
                    rate,
                    pitch,
                    volume: 1.0,
                    category: 'ambient'
                });
                return true;
            } catch (capErr) {
                console.warn('[LZHAudioTts] Capacitor TextToSpeech failed, triggering fallback:', capErr);
            }
        }
        if (mySeq !== ttsPlaySeq) return true;

        // 3. 瀏覽器 Web Speech API（非 Android 原生優先，或 Android 原生無語音包時之備援）
        const webSpoken = await tryWebSpeechWithWatchdog(clean, locale, mySeq);
        if (webSpoken) return true;
        if (mySeq !== ttsPlaySeq) return true;

        // 4. 線上詞典 / TTS 音訊串流最終備援（解決 HyperOS 無系統 TTS 語音包之靜音問題）
        return await tryOnlineAudioStreamFallback(clean, locale, mySeq);
    }

    global.LZHAudioTts = {
        speak: speakText,
        stop: stopAllAudio
    };
    global.speakText = (text, langCode, options) => speakText(text, langCode, options);
})(typeof window !== 'undefined' ? window : globalThis);

