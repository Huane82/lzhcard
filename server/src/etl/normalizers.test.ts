import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeCard,
  dedupeNormalizedCards,
  generateDeterministicCardId,
  generateDeterministicDeckId,
  normalizeMembershipTier,
  normalizeStoreDeckCounters,
  parseTimestampMs
} from './normalizers.js';

test('deterministic IDs stay identical for whitespace and casing variations', () => {
  const deckA = generateDeterministicDeckId('  TOEIC   Core ');
  const deckB = generateDeterministicDeckId('toeic core');
  assert.equal(deckA, deckB);
  assert.match(deckA, /^deck_[0-9a-f]{16}$/);

  const cardA = generateDeterministicCardId('TOEIC Core', '  Resilient ');
  const cardB = generateDeterministicCardId('toeic   core', 'resilient');
  assert.equal(cardA, cardB);
  assert.match(cardA, /^card_[0-9a-f]{16}$/);
});

test('canonicalizeCard preserves all 26+ FSRS, free practice, and boss fields', () => {
  const card = canonicalizeCard(
    {
      word: 'ephemeral',
      category: 'GRE',
      pos: 'adj.',
      phonetic: '/ɪˈfɛmərəl/',
      meaning: '短暫的',
      sentence: 'Fame is ephemeral.',
      translation: '名聲轉瞬即逝。',
      lang: 'en',
      level: 4,
      knowStreak: 3,
      state: 2,
      stability: 12.5,
      difficulty: 4.1,
      reps: 7,
      lapses: 1,
      lastReview: 1790000000000,
      nextReview: 1790500000000,
      freeLevel: 2,
      freeStreak: 5,
      bossWrongCount: 1,
      lastBossWrongAt: 1789999000000,
      diffLevel: 5,
      diffLevelManual: true,
      updatedAt: 1790000123456
    },
    0
  );

  assert.equal(card.word, 'ephemeral');
  assert.equal(card.category, 'GRE');
  assert.equal(card.fsrsState, 2);
  assert.equal(card.stability, 12.5);
  assert.equal(card.diffLevel, 5);
  assert.equal(card.diffLevelManual, true);
  assert.equal(card.bossWrongCount, 1);
  assert.equal(card.updatedAtMs, 1790000123456);
});

test('dedupeNormalizedCards keeps newer updatedAtMs and backfills missing text fields', () => {
  const cards = dedupeNormalizedCards([
    {
      word: 'ubiquitous',
      category: 'TOEFL',
      meaning: '無所不在的',
      phonetic: '/juːˈbɪkwɪtəs/',
      updatedAt: 1700000001000
    },
    {
      word: '  Ubiquitous ',
      category: 'toefl',
      meaning: '無所不在的；普遍存在的',
      reps: 3,
      updatedAt: 1700000002000
    }
  ]);

  assert.equal(cards.length, 1);
  assert.equal(cards[0].updatedAtMs, 1700000002000);
  assert.equal(cards[0].reps, 3);
  assert.equal(cards[0].phonetic, '/juːˈbɪkwɪtəs/');
});

test('normalizeStoreDeckCounters handles store.js and firestore.rules alias mismatch', () => {
  const c1 = normalizeStoreDeckCounters({
    likes: 12,
    favorites: 5,
    downloadCount: 30,
    views: 99,
    statMonthKey: '2026-11'
  });
  assert.deepEqual(c1, {
    likesCount: 12,
    favoritesCount: 5,
    downloadsCount: 30,
    viewsCount: 99,
    monthlyViews: 0,
    monthlyDownloads: 0,
    statMonthKey: '2026-11'
  });

  const c2 = normalizeStoreDeckCounters({
    likesCount: 20,
    favoritesCount: 8,
    downloads: 40,
    monthKey: '2026-12'
  });
  assert.equal(c2.likesCount, 20);
  assert.equal(c2.downloadsCount, 40);
  assert.equal(c2.statMonthKey, '2026-12');
});

test('parseTimestampMs normalizes seconds, milliseconds, ISO strings, and Firestore Timestamps', () => {
  assert.equal(parseTimestampMs(1700000000), 1700000000000);
  assert.equal(parseTimestampMs(1700000000123), 1700000000123);
  assert.equal(parseTimestampMs({ _seconds: 1700000000, _nanoseconds: 500000000 }), 1700000000500);
  assert.equal(parseTimestampMs('2026-11-28T00:00:00.000Z'), Date.parse('2026-11-28T00:00:00.000Z'));
});

test('normalizeMembershipTier safely handles undefined, empty, unknown, and legacy values', () => {
  assert.equal(normalizeMembershipTier(undefined), 'free');
  assert.equal(normalizeMembershipTier(null), 'free');
  assert.equal(normalizeMembershipTier(''), 'free');
  assert.equal(normalizeMembershipTier('   '), 'free');
  assert.equal(normalizeMembershipTier('unknown_tier'), 'free');
  assert.equal(normalizeMembershipTier('supporter_30'), 'supporter_30');
  assert.equal(normalizeMembershipTier('SUPPORTER_90'), 'supporter_90');
  assert.equal(normalizeMembershipTier('supporter_180'), 'supporter_180');
  assert.equal(normalizeMembershipTier('teacher_class'), 'teacher_class');
  assert.equal(normalizeMembershipTier('starter'), 'supporter_30');
});

