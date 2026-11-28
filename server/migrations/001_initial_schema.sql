-- Lzhcard PostgreSQL 18 Initial Schema (Stage 1)
-- Preserves all 11 functional domains across Web, PWA, Android, iOS, and Electron.
-- Enforces UUID PKs + per-user deterministic client ID uniqueness, immutable coin_ledger,
-- buyer deck snapshots surviving author deletion, and zero-forged historical state.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. AUTHENTICATION, IDENTITIES, TOKENS & VERIFICATION
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid TEXT UNIQUE,
  email TEXT UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash TEXT,
  password_algo TEXT CHECK (password_algo IS NULL OR password_algo IN ('argon2id', 'firebase_scrypt')),
  password_salt TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  ban_reason TEXT NOT NULL DEFAULT '',
  banned_at TIMESTAMPTZ,
  banned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ban_expires_at TIMESTAMPTZ,
  unbanned_at TIMESTAMPTZ,
  unbanned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  coins_balance INTEGER NOT NULL DEFAULT 0 CHECK (coins_balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users (role) WHERE role = 'admin';
CREATE INDEX IF NOT EXISTS idx_users_banned ON users (is_banned) WHERE is_banned = TRUE;
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'apple', 'email')),
  provider_subject TEXT NOT NULL,
  provider_email TEXT NOT NULL DEFAULT '',
  raw_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_user_identities_user_id ON user_identities (user_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('web', 'pwa', 'android', 'ios', 'electron', 'legacy_worker')),
  user_agent TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by_id UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active
  ON refresh_tokens (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('email_verify', 'password_reset', 'email_change')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_verification_email_purpose
  ON auth_verification_tokens (LOWER(email), purpose, expires_at DESC)
  WHERE used_at IS NULL;

-- ============================================================================
-- 2. PROFILES, SETTINGS, PROGRESSION & DAILY ACTIVITY
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL DEFAULT '學習者',
  nickname_lower TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  is_stats_public BOOLEAN NOT NULL DEFAULT TRUE,
  hide_on_leaderboard BOOLEAN NOT NULL DEFAULT FALSE,
  privacy_hide_status BOOLEAN NOT NULL DEFAULT FALSE,
  cosmetic_frame TEXT NOT NULL DEFAULT 'default',
  cosmetic_banner TEXT NOT NULL DEFAULT 'default',
  cosmetic_title TEXT NOT NULL DEFAULT 'newcomer',
  unlocked_frames JSONB NOT NULL DEFAULT '[]'::jsonb,
  unlocked_banners JSONB NOT NULL DEFAULT '[]'::jsonb,
  unlocked_titles JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  native_lang TEXT NOT NULL DEFAULT 'zh-TW',
  target_lang TEXT NOT NULL DEFAULT 'en',
  custom_native TEXT NOT NULL DEFAULT '',
  custom_target TEXT NOT NULL DEFAULT '',
  display_mode TEXT NOT NULL DEFAULT 'target_front',
  phonetic_pos TEXT NOT NULL DEFAULT 'front',
  theme TEXT NOT NULL DEFAULT 'system',
  study_mode TEXT NOT NULL DEFAULT 'fsrs' CHECK (study_mode IN ('fsrs', 'free')),
  auto_play_audio BOOLEAN NOT NULL DEFAULT FALSE,
  show_sentence_front BOOLEAN NOT NULL DEFAULT FALSE,
  show_morphemes BOOLEAN NOT NULL DEFAULT TRUE,
  notif_friend_msg BOOLEAN NOT NULL DEFAULT TRUE,
  notif_announcements BOOLEAN NOT NULL DEFAULT TRUE,
  notif_friend_requests BOOLEAN NOT NULL DEFAULT TRUE,
  notif_team_invites BOOLEAN NOT NULL DEFAULT TRUE,
  onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
  onboarding_v2_done BOOLEAN NOT NULL DEFAULT FALSE,
  selected_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  chat_prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
  extra_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_progression (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  xp BIGINT NOT NULL DEFAULT 0 CHECK (xp >= 0),
  level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  streak_days INTEGER NOT NULL DEFAULT 0 CHECK (streak_days >= 0),
  streak_shields INTEGER NOT NULL DEFAULT 0 CHECK (streak_shields >= 0 AND streak_shields <= 3),
  last_active_date TEXT NOT NULL DEFAULT '',
  rank_tier TEXT NOT NULL DEFAULT '青銅 III',
  rank_points INTEGER NOT NULL DEFAULT 0 CHECK (rank_points >= 0),
  duel_wins INTEGER NOT NULL DEFAULT 0 CHECK (duel_wins >= 0),
  duel_total INTEGER NOT NULL DEFAULT 0 CHECK (duel_total >= 0),
  quiz_correct INTEGER NOT NULL DEFAULT 0 CHECK (quiz_correct >= 0),
  quiz_total INTEGER NOT NULL DEFAULT 0 CHECK (quiz_total >= 0),
  quiz_updated_at BIGINT NOT NULL DEFAULT 0,
  last_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_progression_leaderboard
  ON user_progression (rank_points DESC, level DESC, xp DESC);

-- Preserves historical dailyActivity[YYYY-MM-DD] verbatim; never fabricates review logs.
CREATE TABLE IF NOT EXISTS daily_study_activity (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_date DATE NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, activity_date)
);

-- ============================================================================
-- 3. FSRS DECKS, 26+ FIELD WORD CARDS & 90-DAY SYNC TOMBSTONES
-- ============================================================================

CREATE TABLE IF NOT EXISTS decks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_deck_id TEXT NOT NULL,
  category TEXT NOT NULL,
  deck_hash TEXT NOT NULL DEFAULT '',
  card_count INTEGER NOT NULL DEFAULT 0 CHECK (card_count >= 0),
  updated_at_ms BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_deck_id),
  UNIQUE (user_id, category)
);

CREATE TABLE IF NOT EXISTS word_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deck_id UUID NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  client_card_id TEXT NOT NULL,
  client_deck_id TEXT NOT NULL,
  category TEXT NOT NULL,
  word TEXT NOT NULL,
  pos TEXT NOT NULL DEFAULT '',
  phonetic TEXT NOT NULL DEFAULT '',
  meaning TEXT NOT NULL DEFAULT '',
  sentence TEXT NOT NULL DEFAULT '',
  translation TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'en',
  level INTEGER NOT NULL DEFAULT 0,
  know_streak INTEGER NOT NULL DEFAULT 0,
  fsrs_state SMALLINT NOT NULL DEFAULT 0,
  stability DOUBLE PRECISION NOT NULL DEFAULT 0,
  difficulty DOUBLE PRECISION NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  last_review_ms BIGINT NOT NULL DEFAULT 0,
  next_review_ms BIGINT NOT NULL DEFAULT 0,
  free_level INTEGER NOT NULL DEFAULT 0,
  free_streak INTEGER NOT NULL DEFAULT 0,
  boss_wrong_count INTEGER NOT NULL DEFAULT 0,
  last_boss_wrong_at_ms BIGINT NOT NULL DEFAULT 0,
  diff_level SMALLINT NOT NULL DEFAULT 0 CHECK (diff_level BETWEEN 0 AND 6),
  diff_level_manual BOOLEAN NOT NULL DEFAULT FALSE,
  extra_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at_ms BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_card_id)
);

CREATE INDEX IF NOT EXISTS idx_word_cards_user_deck ON word_cards (user_id, deck_id);
CREATE INDEX IF NOT EXISTS idx_word_cards_user_next_review ON word_cards (user_id, next_review_ms);
CREATE INDEX IF NOT EXISTS idx_word_cards_user_updated_ms ON word_cards (user_id, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS sync_tombstones (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('deck', 'card')),
  client_entity_id TEXT NOT NULL,
  deleted_at_ms BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, entity_type, client_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_tombstones_expires ON sync_tombstones (expires_at);

-- ============================================================================
-- 4. BILLING, IMMUTABLE COIN LEDGER, MEMBERSHIPS, AI QUOTAS & COSMETICS
-- ============================================================================

CREATE TABLE IF NOT EXISTS iap_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  firebase_uid_snapshot TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web', 'legacy')),
  tx_doc_id TEXT NOT NULL UNIQUE,
  external_transaction_id TEXT NOT NULL,
  external_order_id TEXT,
  purchase_token_hash TEXT,
  package_or_bundle_id TEXT NOT NULL DEFAULT '',
  product_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('coins', 'membership', 'other')),
  price_ntd INTEGER NOT NULL DEFAULT 0 CHECK (price_ntd >= 0),
  coins_granted INTEGER NOT NULL DEFAULT 0 CHECK (coins_granted >= 0),
  tier_granted TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL DEFAULT 'Production',
  verification_status TEXT NOT NULL CHECK (
    verification_status IN ('verified', 'legacy_migrated', 'refunded', 'revoked', 'disputed')
  ),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_iap_tx_platform_order_unique
  ON iap_transactions (platform, external_order_id)
  WHERE external_order_id IS NOT NULL AND external_order_id <> '';

CREATE INDEX IF NOT EXISTS idx_iap_tx_user ON iap_transactions (user_id, processed_at DESC);

CREATE TABLE IF NOT EXISTS coin_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  delta INTEGER NOT NULL CHECK (delta <> 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  reason TEXT NOT NULL CHECK (
    reason IN (
      'legacy_opening_balance',
      'iap_grant',
      'store_purchase_debit',
      'store_royalty_credit',
      'coin_redeem_debit',
      'cosmetic_debit',
      'shield_debit',
      'admin_adjust',
      'iap_refund_clawback',
      'quest_or_game_reward'
    )
  ),
  ref_type TEXT NOT NULL DEFAULT '',
  ref_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT UNIQUE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coin_ledger_user_created ON coin_ledger (user_id, created_at DESC, id DESC);

-- Enforce strict append-only immutability on coin_ledger at database engine level
CREATE OR REPLACE FUNCTION prevent_coin_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'coin_ledger is strictly append-only; UPDATE and DELETE are prohibited';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_coin_ledger_immutable ON coin_ledger;
CREATE TRIGGER trg_coin_ledger_immutable
  BEFORE UPDATE OR DELETE ON coin_ledger
  FOR EACH ROW
  EXECUTE FUNCTION prevent_coin_ledger_mutation();

CREATE TABLE IF NOT EXISTS user_memberships (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tier TEXT NOT NULL DEFAULT 'free' CHECK (
    tier IN ('free', 'supporter_30', 'supporter_90', 'supporter_180', 'teacher_class')
  ),
  tier_price_ntd INTEGER NOT NULL DEFAULT 0 CHECK (tier_price_ntd >= 0),
  billing_cycle TEXT NOT NULL DEFAULT 'monthly',
  started_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  total_donated_ntd INTEGER NOT NULL DEFAULT 0 CHECK (total_donated_ntd >= 0),
  auto_downgraded_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT '',
  last_order_id TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_memberships_active
  ON user_memberships (tier, expires_at)
  WHERE tier <> 'free';

CREATE TABLE IF NOT EXISTS membership_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier TEXT NOT NULL,
  price_ntd INTEGER NOT NULL DEFAULT 0,
  billing_cycle TEXT NOT NULL DEFAULT 'monthly',
  started_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT '',
  order_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_membership_history_user
  ON membership_history (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_ai_quotas (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  daily_date TEXT NOT NULL DEFAULT '',
  monthly_key TEXT NOT NULL DEFAULT '',
  daily_def_fill INTEGER NOT NULL DEFAULT 0 CHECK (daily_def_fill >= 0),
  daily_article_gen INTEGER NOT NULL DEFAULT 0 CHECK (daily_article_gen >= 0),
  daily_vision_ocr INTEGER NOT NULL DEFAULT 0 CHECK (daily_vision_ocr >= 0),
  daily_fast_refine INTEGER NOT NULL DEFAULT 0 CHECK (daily_fast_refine >= 0),
  monthly_def_fill INTEGER NOT NULL DEFAULT 0 CHECK (monthly_def_fill >= 0),
  monthly_article_gen INTEGER NOT NULL DEFAULT 0 CHECK (monthly_article_gen >= 0),
  monthly_vision_ocr INTEGER NOT NULL DEFAULT 0 CHECK (monthly_vision_ocr >= 0),
  monthly_fast_refine INTEGER NOT NULL DEFAULT 0 CHECK (monthly_fast_refine >= 0),
  trial_tier TEXT NOT NULL DEFAULT 'free',
  trial_expires_at TIMESTAMPTZ,
  credit_def_fill INTEGER NOT NULL DEFAULT 0 CHECK (credit_def_fill >= 0),
  credit_article_gen INTEGER NOT NULL DEFAULT 0 CHECK (credit_article_gen >= 0),
  credit_vision_ocr INTEGER NOT NULL DEFAULT 0 CHECK (credit_vision_ocr >= 0),
  credit_fast_refine INTEGER NOT NULL DEFAULT 0 CHECK (credit_fast_refine >= 0),
  last_redeemed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_owned_cosmetics (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cosmetic_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'coin_shop',
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, cosmetic_id)
);

-- ============================================================================
-- 5. COMMUNITY STORE DECKS, REACTIONS & IMMUTABLE PURCHASE SNAPSHOTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS store_decks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_firestore_id TEXT UNIQUE,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  author_uid_snapshot TEXT NOT NULL DEFAULT '',
  author_name_snapshot TEXT NOT NULL DEFAULT '創作者',
  author_avatar_snapshot TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  target_lang TEXT NOT NULL DEFAULT 'en',
  native_lang TEXT NOT NULL DEFAULT 'zh-TW',
  is_paid BOOLEAN NOT NULL DEFAULT FALSE,
  price_coins INTEGER NOT NULL DEFAULT 0 CHECK (price_coins >= 0),
  card_count INTEGER NOT NULL DEFAULT 0 CHECK (card_count >= 0),
  cards_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  cards_preview_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  likes_count INTEGER NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
  favorites_count INTEGER NOT NULL DEFAULT 0 CHECK (favorites_count >= 0),
  downloads_count INTEGER NOT NULL DEFAULT 0 CHECK (downloads_count >= 0),
  views_count INTEGER NOT NULL DEFAULT 0 CHECK (views_count >= 0),
  monthly_views INTEGER NOT NULL DEFAULT 0 CHECK (monthly_views >= 0),
  monthly_downloads INTEGER NOT NULL DEFAULT 0 CHECK (monthly_downloads >= 0),
  stat_month_key TEXT NOT NULL DEFAULT '',
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_store_decks_active_popular
  ON store_decks (downloads_count DESC, likes_count DESC)
  WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_store_decks_author
  ON store_decks (author_user_id)
  WHERE is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS store_deck_reactions (
  store_deck_id UUID NOT NULL REFERENCES store_decks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction_type TEXT NOT NULL CHECK (reaction_type IN ('like', 'favorite', 'download')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store_deck_id, user_id, reaction_type)
);

-- Buyer retains full snapshot even if author deletes deck or deletes account.
CREATE TABLE IF NOT EXISTS store_deck_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  store_deck_id UUID REFERENCES store_decks(id) ON DELETE SET NULL,
  deck_key TEXT NOT NULL,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  author_uid_snapshot TEXT NOT NULL DEFAULT '',
  price_coins_paid INTEGER NOT NULL DEFAULT 0 CHECK (price_coins_paid >= 0),
  author_royalty_coins INTEGER NOT NULL DEFAULT 0 CHECK (author_royalty_coins >= 0),
  deck_title_snapshot TEXT NOT NULL DEFAULT '',
  deck_snapshot_json JSONB NOT NULL,
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (buyer_user_id, deck_key)
);

CREATE INDEX IF NOT EXISTS idx_store_purchases_buyer ON store_deck_purchases (buyer_user_id, purchased_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_purchases_author ON store_deck_purchases (author_user_id, purchased_at DESC);

-- ============================================================================
-- 6. SOCIAL, FRIENDS, CHAT, ANNOUNCEMENTS & 50-MEMBER CLASSROOM
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CHECK (blocker_user_id <> blocked_user_id)
);

CREATE TABLE IF NOT EXISTS friend_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id TEXT UNIQUE,
  from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_user_id <> to_user_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_to_pending
  ON friend_requests (to_user_id, created_at DESC)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS friendships (
  user_low_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_thread_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_low_id, user_high_id),
  CHECK (user_low_id < user_high_id)
);

CREATE TABLE IF NOT EXISTS friend_removal_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  removed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  removed_by_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_friend_removals_unacked
  ON friend_removal_events (target_user_id)
  WHERE acknowledged_at IS NULL;

CREATE TABLE IF NOT EXISTS chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id TEXT UNIQUE,
  thread_type TEXT NOT NULL CHECK (thread_type IN ('public', 'direct', 'group')),
  name TEXT NOT NULL DEFAULT '',
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  teacher_mode BOOLEAN NOT NULL DEFAULT FALSE,
  max_members INTEGER NOT NULL DEFAULT 50 CHECK (max_members >= 2 AND max_members <= 200),
  classroom_mute_all BOOLEAN NOT NULL DEFAULT FALSE,
  classroom_progress_visibility TEXT NOT NULL DEFAULT 'teacher_only',
  muted_uids JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_message_preview TEXT NOT NULL DEFAULT '',
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_members (
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'teacher', 'member')),
  last_read_at TIMESTAMPTZ,
  is_muted BOOLEAN NOT NULL DEFAULT FALSE,
  is_deleted_local BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members (user_id, thread_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  legacy_rtdb_id TEXT,
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sender_name_snapshot TEXT NOT NULL DEFAULT '',
  sender_avatar_snapshot TEXT NOT NULL DEFAULT '',
  sender_frame_snapshot TEXT NOT NULL DEFAULT 'default',
  msg_type TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_legacy_unique
  ON chat_messages (thread_id, legacy_rtdb_id)
  WHERE legacy_rtdb_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_created
  ON chat_messages (thread_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS group_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id TEXT UNIQUE,
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS classroom_daily_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  legacy_task_id TEXT NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (thread_id, legacy_task_id)
);

CREATE TABLE IF NOT EXISTS classroom_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  legacy_challenge_id TEXT NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  current_question_index INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (thread_id, legacy_challenge_id)
);

CREATE TABLE IF NOT EXISTS classroom_challenge_responses (
  challenge_id UUID NOT NULL REFERENCES classroom_challenges(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL DEFAULT 0,
  answers_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, user_id)
);

CREATE TABLE IF NOT EXISTS classroom_student_snapshots (
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id TEXT UNIQUE,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  author_name_snapshot TEXT NOT NULL DEFAULT '官方管理員',
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

-- ============================================================================
-- 7. MULTIPLAYER, AUTHORITATIVE DUEL/RAID SETTLEMENT, RP LEDGER & SEASONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS duel_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'playing', 'finished', 'abandoned')),
  host_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  guest_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  winner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  is_draw BOOLEAN NOT NULL DEFAULT FALSE,
  forfeited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  host_score INTEGER NOT NULL DEFAULT 0,
  guest_score INTEGER NOT NULL DEFAULT 0,
  tug_position INTEGER NOT NULL DEFAULT 50 CHECK (tug_position BETWEEN 0 AND 100),
  questions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS raid_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raid_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'playing', 'cleared', 'failed', 'abandoned')),
  host_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  boss_name TEXT NOT NULL DEFAULT '',
  boss_hp INTEGER NOT NULL DEFAULT 0,
  boss_max_hp INTEGER NOT NULL DEFAULT 0,
  questions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  cleared_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raid_participants (
  raid_id UUID NOT NULL REFERENCES raid_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  damage INTEGER NOT NULL DEFAULT 0 CHECK (damage >= 0),
  hits INTEGER NOT NULL DEFAULT 0 CHECK (hits >= 0),
  reward_claimed BOOLEAN NOT NULL DEFAULT FALSE,
  reward_claimed_at TIMESTAMPTZ,
  PRIMARY KEY (raid_id, user_id)
);

CREATE TABLE IF NOT EXISTS ghost_snapshots (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  rank_tier TEXT NOT NULL DEFAULT '青銅 III',
  membership_tier TEXT NOT NULL DEFAULT 'free',
  membership_expires_at BIGINT NOT NULL DEFAULT 0,
  total_score INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  timeline_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  questions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS player_rp_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL DEFAULT 1,
  source_type TEXT NOT NULL CHECK (
    source_type IN ('duel_win', 'duel_loss', 'duel_draw', 'admin_adjust', 'season_reset')
  ),
  source_ref_id TEXT NOT NULL,
  rp_delta INTEGER NOT NULL,
  rp_before INTEGER NOT NULL,
  rp_after INTEGER NOT NULL CHECK (rp_after >= 0),
  tier_before TEXT NOT NULL,
  tier_after TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_type, source_ref_id)
);

CREATE INDEX IF NOT EXISTS idx_player_rp_ledger_user ON player_rp_ledger (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS season_resets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  season_number INTEGER NOT NULL UNIQUE,
  reset_users_count INTEGER NOT NULL DEFAULT 0,
  triggered_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  trigger_mode TEXT NOT NULL CHECK (trigger_mode IN ('manual', 'auto_schedule')),
  reset_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 8. MODERATION, APPEALS, AUDIT LOGS & MIGRATION / ETL TRACKING
-- ============================================================================

CREATE TABLE IF NOT EXISTS moderation_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_firestore_id TEXT UNIQUE,
  reporter_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL DEFAULT 'message',
  target_id TEXT NOT NULL DEFAULT '',
  chat_id TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  content_preview TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_moderation_reports_status ON moderation_reports (status, created_at DESC);

CREATE TABLE IF NOT EXISTS ban_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_firestore_id TEXT UNIQUE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  email_snapshot TEXT NOT NULL DEFAULT '',
  nickname_snapshot TEXT NOT NULL DEFAULT '',
  ban_reason_snapshot TEXT NOT NULL DEFAULT '',
  ban_expires_at TIMESTAMPTZ,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ban_appeals_status ON ban_appeals (status, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  diff_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS etl_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode TEXT NOT NULL CHECK (mode IN ('full', 'incremental', 'verify_only')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  source_watermarks JSONB NOT NULL DEFAULT '{}'::jsonb,
  reconciliation_report JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

COMMIT;
