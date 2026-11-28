export const DEFAULT_CATEGORY_NAME = '預設字庫';

export function hashStringStableHex(inputStr: string): string {
  const str = String(inputStr || '');
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x9e3779b9 >>> 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= ch + (i + 1) * 31;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function normalizeDeckCategoryName(
  categoryName: unknown,
  fallbackName: string = DEFAULT_CATEGORY_NAME
): string {
  const clean = String(categoryName || '')
    .trim()
    .replace(/\s+/g, ' ');
  return clean || fallbackName;
}

export function normalizeCardWordText(word: unknown): string {
  return String(word || '')
    .trim()
    .replace(/\s+/g, ' ');
}

export function generateDeterministicDeckId(categoryName: unknown): string {
  const cleanCat = normalizeDeckCategoryName(categoryName).toLowerCase();
  return 'deck_' + hashStringStableHex('deck::' + cleanCat);
}

export function generateDeterministicCardId(categoryName: unknown, word: unknown): string {
  const cleanCat = normalizeDeckCategoryName(categoryName).toLowerCase();
  const cleanWord = normalizeCardWordText(word).toLowerCase();
  return 'card_' + hashStringStableHex('card::' + cleanCat + '::' + cleanWord);
}

export function toFiniteInt(val: unknown, fallback = 0, min?: number, max?: number): number {
  const n = Number(val);
  let out = Number.isFinite(n) ? Math.trunc(n) : fallback;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
}

export function toFiniteNumber(val: unknown, fallback = 0): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

export function parseTimestampMs(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return raw < 1e12 ? Math.trunc(raw * 1000) : Math.trunc(raw);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return 0;
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum < 1e12 ? Math.trunc(asNum * 1000) : Math.trunc(asNum);
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.toMillis === 'function') {
      const ms = Number((obj.toMillis as () => number)());
      return Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : 0;
    }
    const sec = obj._seconds ?? obj.seconds;
    if (typeof sec === 'number' && Number.isFinite(sec)) {
      const nsec = typeof (obj._nanoseconds ?? obj.nanoseconds) === 'number'
        ? Number(obj._nanoseconds ?? obj.nanoseconds)
        : 0;
      return Math.max(0, Math.trunc(sec * 1000 + nsec / 1e6));
    }
  }
  return 0;
}

export function msToDateOrNull(ms: unknown): Date | null {
  const parsed = parseTimestampMs(ms);
  return parsed > 0 ? new Date(parsed) : null;
}

export function sanitizeJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.toMillis === 'function') {
      return parseTimestampMs(obj);
    }
    if (Array.isArray(value)) {
      return value.map((v) => sanitizeJsonValue(v));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined && typeof v !== 'function') {
        out[k] = sanitizeJsonValue(v);
      }
    }
    return out;
  }
  return String(value);
}

export interface NormalizedCard {
  clientCardId: string;
  clientDeckId: string;
  category: string;
  word: string;
  pos: string;
  phonetic: string;
  meaning: string;
  sentence: string;
  translation: string;
  lang: string;
  level: number;
  knowStreak: number;
  fsrsState: number;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  lastReviewMs: number;
  nextReviewMs: number;
  freeLevel: number;
  freeStreak: number;
  bossWrongCount: number;
  lastBossWrongAtMs: number;
  diffLevel: number;
  diffLevelManual: boolean;
  updatedAtMs: number;
  extraFields: Record<string, unknown>;
}

const KNOWN_CARD_KEYS = new Set([
  'id',
  'deckId',
  'category',
  'word',
  'pos',
  'phonetic',
  'meaning',
  'sentence',
  'translation',
  'lang',
  'level',
  'knowStreak',
  'state',
  'stability',
  'difficulty',
  'reps',
  'lapses',
  'lastReview',
  'nextReview',
  'freeLevel',
  'freeStreak',
  'bossWrongCount',
  'lastBossWrongAt',
  'diffLevel',
  'diffLevelManual',
  'updatedAt'
]);

export function canonicalizeCard(raw: Record<string, unknown>, fallbackIdx: number): NormalizedCard {
  const category = normalizeDeckCategoryName(raw.category);
  const word = normalizeCardWordText(raw.word);
  const clientDeckId = generateDeterministicDeckId(category);
  const clientCardId = word
    ? generateDeterministicCardId(category, word)
    : (typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `card_empty_${fallbackIdx}`);

  const extraFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!KNOWN_CARD_KEYS.has(k) && v !== undefined && typeof v !== 'function') {
      extraFields[k] = sanitizeJsonValue(v);
    }
  }

  return {
    clientCardId,
    clientDeckId,
    category,
    word: word || String(raw.id || `card_${fallbackIdx}`),
    pos: String(raw.pos || ''),
    phonetic: String(raw.phonetic || ''),
    meaning: String(raw.meaning || ''),
    sentence: String(raw.sentence || ''),
    translation: String(raw.translation || ''),
    lang: String(raw.lang || 'en') || 'en',
    level: toFiniteInt(raw.level, 0, 0),
    knowStreak: toFiniteInt(raw.knowStreak, 0, 0),
    fsrsState: toFiniteInt(raw.state, 0, 0, 10),
    stability: Math.max(0, toFiniteNumber(raw.stability, 0)),
    difficulty: Math.max(0, toFiniteNumber(raw.difficulty, 0)),
    reps: toFiniteInt(raw.reps, 0, 0),
    lapses: toFiniteInt(raw.lapses, 0, 0),
    lastReviewMs: parseTimestampMs(raw.lastReview),
    nextReviewMs: parseTimestampMs(raw.nextReview),
    freeLevel: toFiniteInt(raw.freeLevel, 0, 0),
    freeStreak: toFiniteInt(raw.freeStreak, 0, 0),
    bossWrongCount: toFiniteInt(raw.bossWrongCount, 0, 0),
    lastBossWrongAtMs: parseTimestampMs(raw.lastBossWrongAt),
    diffLevel: toFiniteInt(raw.diffLevel, 0, 0, 6),
    diffLevelManual: Boolean(raw.diffLevelManual),
    updatedAtMs: parseTimestampMs(raw.updatedAt),
    extraFields
  };
}

export function dedupeNormalizedCards(rawCards: Array<Record<string, unknown>>): NormalizedCard[] {
  const byId = new Map<string, NormalizedCard>();
  rawCards.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') return;
    const card = canonicalizeCard(raw, idx);
    const prev = byId.get(card.clientCardId);
    if (!prev) {
      byId.set(card.clientCardId, card);
      return;
    }
    const incomingNewer =
      card.updatedAtMs > prev.updatedAtMs ||
      (card.updatedAtMs === prev.updatedAtMs &&
        (card.reps > prev.reps || card.nextReviewMs > prev.nextReviewMs));
    const winner = incomingNewer ? { ...card } : { ...prev };
    const loser = incomingNewer ? prev : card;
    if (!winner.pos && loser.pos) winner.pos = loser.pos;
    if (!winner.phonetic && loser.phonetic) winner.phonetic = loser.phonetic;
    if (!winner.meaning && loser.meaning) winner.meaning = loser.meaning;
    if (!winner.sentence && loser.sentence) winner.sentence = loser.sentence;
    if (!winner.translation && loser.translation) winner.translation = loser.translation;
    byId.set(card.clientCardId, winner);
  });
  return Array.from(byId.values());
}

export function normalizeStoreDeckCounters(raw: Record<string, unknown>) {
  return {
    likesCount: toFiniteInt(raw.likesCount ?? raw.likes, 0, 0),
    favoritesCount: toFiniteInt(raw.favoritesCount ?? raw.favorites, 0, 0),
    downloadsCount: toFiniteInt(raw.downloads ?? raw.downloadCount, 0, 0),
    viewsCount: toFiniteInt(raw.views ?? raw.viewsCount, 0, 0),
    monthlyViews: toFiniteInt(raw.monthlyViews, 0, 0),
    monthlyDownloads: toFiniteInt(raw.monthlyDownloads, 0, 0),
    statMonthKey: String(raw.monthKey ?? raw.statMonthKey ?? '')
  };
}

export type MembershipTier =
  | 'free'
  | 'supporter_30'
  | 'supporter_90'
  | 'supporter_180'
  | 'teacher_class';

const MEMBERSHIP_TIER_ALIASES: Record<string, MembershipTier> = {
  free: 'free',
  supporter_30: 'supporter_30',
  supporter_90: 'supporter_90',
  supporter_180: 'supporter_180',
  teacher_class: 'teacher_class',
  starter: 'supporter_30',
  plus: 'supporter_90',
  pro: 'supporter_180',
  teacher: 'teacher_class'
};

export function normalizeMembershipTier(rawTier: unknown): MembershipTier {
  if (typeof rawTier !== 'string') return 'free';
  const cleaned = rawTier.trim().toLowerCase();
  if (!cleaned) return 'free';
  return MEMBERSHIP_TIER_ALIASES[cleaned] ?? 'free';
}

