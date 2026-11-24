import Foundation
import Darwin

/// Foundation-only cross-target shared store for App, LiveActivityWidget, and BroadcastUpload.
/// IMPORTANT: Keep this file strictly Foundation-only (do NOT import WidgetKit, AppIntents, UIKit, or ActivityKit).
public enum LzhSharedEcosystemStore {
    public static let darwinSubtitleUpdated = "com.lzhcard.app.pip.subtitle.updated" as CFString
    public static let darwinShortcutCommand = "com.lzhcard.app.shortcut.command" as CFString
    public static let darwinPauseToggled = "com.lzhcard.app.subtitle.pause.toggled" as CFString
    public static let darwinSaveSubtitleRequested = "com.lzhcard.app.subtitle.save.requested" as CFString

    private static let kPendingActionKey = "lzh_pending_shortcut_action"
    private static let kPendingActionTsKey = "lzh_pending_shortcut_ts"
    private static let kSubtitlePausedKey = "lzh_subtitle_paused"
    private static let kLatestSourceKey = "lzh_latest_subtitle_source_shared"
    private static let kLatestTranslatedKey = "lzh_latest_subtitle_translated_shared"
    private static let kSnapshotDueCountKey = "lzh_eco_due_count"
    private static let kSnapshotStreakDaysKey = "lzh_eco_streak_days"
    private static let kSnapshotTotalWordsKey = "lzh_eco_total_words"
    private static let kSnapshotFeaturedWordKey = "lzh_eco_featured_word"
    private static let kSnapshotFeaturedMeaningKey = "lzh_eco_featured_meaning"
    private static let kSnapshotUpdatedAtKey = "lzh_eco_updated_at"
    private static let kPendingSaveCardsKey = "lzh_pending_save_subtitle_cards_v1"

    public struct StudySnapshot: Codable, Equatable {
        public var dueCount: Int
        public var streakDays: Int
        public var totalWords: Int
        public var featuredWord: String
        public var featuredMeaning: String
        public var updatedAt: TimeInterval

        public init(
            dueCount: Int = 0,
            streakDays: Int = 0,
            totalWords: Int = 0,
            featuredWord: String = "",
            featuredMeaning: String = "",
            updatedAt: TimeInterval = Date().timeIntervalSince1970
        ) {
            self.dueCount = dueCount
            self.streakDays = streakDays
            self.totalWords = totalWords
            self.featuredWord = featuredWord
            self.featuredMeaning = featuredMeaning
            self.updatedAt = updatedAt
        }
    }

    public struct PendingSaveCard: Codable, Equatable {
        public var sourceText: String
        public var translatedText: String
        public var createdAt: TimeInterval

        public init(sourceText: String, translatedText: String, createdAt: TimeInterval = Date().timeIntervalSince1970) {
            self.sourceText = sourceText
            self.translatedText = translatedText
            self.createdAt = createdAt
        }
    }

    public static func candidateAppGroupIds() -> [String] {
        var candidates: [String] = []
        if let infoGroup = Bundle.main.object(forInfoDictionaryKey: "LZHAppGroupIdentifier") as? String {
            let trimmed = infoGroup.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                candidates.append(trimmed)
            }
        }
        let rawBundleId = (Bundle.main.bundleIdentifier ?? "com.lzhcard.app").trimmingCharacters(in: .whitespacesAndNewlines)
        if rawBundleId.hasSuffix(".BroadcastUpload") {
            let mainId = String(rawBundleId.dropLast(".BroadcastUpload".count))
            if !mainId.isEmpty { candidates.append("group.\(mainId)") }
        } else if rawBundleId.hasSuffix(".LiveActivityWidget") {
            let mainId = String(rawBundleId.dropLast(".LiveActivityWidget".count))
            if !mainId.isEmpty { candidates.append("group.\(mainId)") }
        } else if !rawBundleId.isEmpty {
            candidates.append("group.\(rawBundleId)")
        }
        candidates.append("group.com.lzhcard.app")

        var seen = Set<String>()
        return candidates.filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    public static func resolveSharedContainerCachesDirectory() -> URL? {
        for gid in candidateAppGroupIds() {
            if let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: gid) {
                let caches = container.appendingPathComponent("Library/Caches", isDirectory: true)
                try? FileManager.default.createDirectory(at: caches, withIntermediateDirectories: true)
                if FileManager.default.isWritableFile(atPath: caches.path) {
                    return caches
                }
            }
        }
        return nil
    }

    public static func resolveUserDefaultsTargets() -> [UserDefaults] {
        var list: [UserDefaults] = []
        for gid in candidateAppGroupIds() {
            if let suite = UserDefaults(suiteName: gid) {
                list.append(suite)
            }
        }
        list.append(UserDefaults.standard)
        return list
    }

    public static func primaryUserDefaults() -> UserDefaults {
        for gid in candidateAppGroupIds() {
            if FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: gid) != nil,
               let suite = UserDefaults(suiteName: gid) {
                return suite
            }
        }
        return UserDefaults.standard
    }

    public static func postDarwinNotification(_ name: CFString) {
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterPostNotification(center, CFNotificationName(name), nil, nil, true)
    }

    private static func ecosystemSnapshotFileUrl() -> URL? {
        guard let dir = resolveSharedContainerCachesDirectory() else { return nil }
        return dir.appendingPathComponent("lzh_ecosystem_snapshot.json")
    }

    public static func saveSnapshot(_ snapshot: StudySnapshot) {
        for ud in resolveUserDefaultsTargets() {
            ud.set(snapshot.dueCount, forKey: kSnapshotDueCountKey)
            ud.set(snapshot.streakDays, forKey: kSnapshotStreakDaysKey)
            ud.set(snapshot.totalWords, forKey: kSnapshotTotalWordsKey)
            ud.set(snapshot.featuredWord, forKey: kSnapshotFeaturedWordKey)
            ud.set(snapshot.featuredMeaning, forKey: kSnapshotFeaturedMeaningKey)
            ud.set(snapshot.updatedAt, forKey: kSnapshotUpdatedAtKey)
            ud.synchronize()
        }
        if let fileUrl = ecosystemSnapshotFileUrl(),
           let data = try? JSONEncoder().encode(snapshot) {
            try? data.write(to: fileUrl, options: .atomic)
        }
    }

    public static func loadSnapshot() -> StudySnapshot {
        if let fileUrl = ecosystemSnapshotFileUrl(),
           let data = try? Data(contentsOf: fileUrl),
           let decoded = try? JSONDecoder().decode(StudySnapshot.self, from: data) {
            return decoded
        }
        for ud in resolveUserDefaultsTargets() {
            let ts = ud.double(forKey: kSnapshotUpdatedAtKey)
            let due = ud.integer(forKey: kSnapshotDueCountKey)
            let streak = ud.integer(forKey: kSnapshotStreakDaysKey)
            let total = ud.integer(forKey: kSnapshotTotalWordsKey)
            let word = ud.string(forKey: kSnapshotFeaturedWordKey) ?? ""
            let meaning = ud.string(forKey: kSnapshotFeaturedMeaningKey) ?? ""
            if ts > 0 || total > 0 || !word.isEmpty {
                return StudySnapshot(
                    dueCount: due,
                    streakDays: streak,
                    totalWords: total,
                    featuredWord: word,
                    featuredMeaning: meaning,
                    updatedAt: ts
                )
            }
        }
        return StudySnapshot()
    }

    public static func isSubtitlePaused() -> Bool {
        for ud in resolveUserDefaultsTargets() {
            if ud.object(forKey: kSubtitlePausedKey) != nil {
                return ud.bool(forKey: kSubtitlePausedKey)
            }
        }
        return false
    }

    public static func setSubtitlePaused(_ paused: Bool) {
        for ud in resolveUserDefaultsTargets() {
            ud.set(paused, forKey: kSubtitlePausedKey)
            ud.synchronize()
        }
        postDarwinNotification(darwinPauseToggled)
    }

    @discardableResult
    public static func toggleSubtitlePaused() -> Bool {
        let next = !isSubtitlePaused()
        setSubtitlePaused(next)
        return next
    }

    public static func saveLatestSubtitle(source: String, translated: String) {
        let cleanSrc = source.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanTr = translated.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanSrc.isEmpty || !cleanTr.isEmpty else { return }
        for ud in resolveUserDefaultsTargets() {
            if !cleanSrc.isEmpty { ud.set(cleanSrc, forKey: kLatestSourceKey) }
            if !cleanTr.isEmpty { ud.set(cleanTr, forKey: kLatestTranslatedKey) }
            ud.synchronize()
        }
    }

    public static func getLatestSubtitle() -> (source: String, translated: String) {
        var src = ""
        var tr = ""
        for ud in resolveUserDefaultsTargets() {
            if src.isEmpty, let s = ud.string(forKey: kLatestSourceKey), !s.isEmpty {
                src = s
            }
            if tr.isEmpty, let t = ud.string(forKey: kLatestTranslatedKey), !t.isEmpty {
                tr = t
            }
            if src.isEmpty, let legacyOcr = ud.string(forKey: "lzh_latest_ocr_text"), !legacyOcr.isEmpty {
                src = legacyOcr
            }
            if tr.isEmpty, let legacyPip = ud.string(forKey: "lzh_latest_pip_subtitle"), !legacyPip.isEmpty {
                tr = legacyPip
            }
        }
        return (src, tr)
    }

    public static func enqueuePendingSaveCard(sourceText: String, translatedText: String) {
        let cleanSrc = sourceText.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanTr = translatedText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanSrc.isEmpty || !cleanTr.isEmpty else { return }
        let entry = PendingSaveCard(sourceText: cleanSrc, translatedText: cleanTr)
        let ud = primaryUserDefaults()
        var current: [PendingSaveCard] = []
        if let data = ud.data(forKey: kPendingSaveCardsKey),
           let decoded = try? JSONDecoder().decode([PendingSaveCard].self, from: data) {
            current = decoded
        }
        current.append(entry)
        if current.count > 25 {
            current = Array(current.suffix(25))
        }
        if let encoded = try? JSONEncoder().encode(current) {
            for targetUd in resolveUserDefaultsTargets() {
                targetUd.set(encoded, forKey: kPendingSaveCardsKey)
                targetUd.synchronize()
            }
        }
        postDarwinNotification(darwinSaveSubtitleRequested)
    }

    public static func drainPendingSaveCards() -> [[String: Any]] {
        var collected: [PendingSaveCard] = []
        for ud in resolveUserDefaultsTargets() {
            if let data = ud.data(forKey: kPendingSaveCardsKey),
               let decoded = try? JSONDecoder().decode([PendingSaveCard].self, from: data),
               !decoded.isEmpty {
                collected.append(contentsOf: decoded)
                ud.removeObject(forKey: kPendingSaveCardsKey)
                ud.synchronize()
            }
        }
        var seen = Set<String>()
        var result: [[String: Any]] = []
        for item in collected {
            let sig = "\(item.sourceText.lowercased())|\(item.translatedText.lowercased())"
            if seen.insert(sig).inserted {
                result.append([
                    "sourceText": item.sourceText,
                    "translatedText": item.translatedText,
                    "createdAt": item.createdAt
                ])
            }
        }
        return result
    }

    public static func dispatchShortcutAction(_ action: String) {
        let clean = action.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        let now = Date().timeIntervalSince1970
        for ud in resolveUserDefaultsTargets() {
            ud.set(clean, forKey: kPendingActionKey)
            ud.set(now, forKey: kPendingActionTsKey)
            ud.synchronize()
        }
        postDarwinNotification(darwinShortcutCommand)
    }
}
