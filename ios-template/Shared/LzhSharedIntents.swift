import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif
#if canImport(AppIntents)
import AppIntents

@available(iOS 17.0, *)
public struct ToggleSubtitlePauseIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "暫停／繼續字幕翻譯"
    public static var description = IntentDescription("從動態島或捷徑立即暫停／繼續即時雙語字幕識別。")

    public init() {}

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        let nowPaused = LzhSharedEcosystemStore.toggleSubtitlePaused()
        #if canImport(ActivityKit)
        for act in Activity<LzhTranslateActivityAttributes>.activities {
            let cur = act.content.state
            let nextState = LzhTranslateActivityAttributes.ContentState(
                sourceText: cur.sourceText,
                translatedText: cur.translatedText,
                statusLabel: nowPaused ? "⏸ 已暫停" : "即時字幕識別中",
                isActive: cur.isActive,
                isPaused: nowPaused,
                sourceLang: cur.sourceLang,
                updatedAt: Date().timeIntervalSince1970
            )
            await act.update(using: nextState)
        }
        #endif
        return .result(dialog: nowPaused ? "已暫停即時字幕識別。" : "已繼續即時字幕識別。")
    }
}

@available(iOS 17.0, *)
public struct SaveCurrentSubtitleCardIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "收藏目前字幕為單字卡"
    public static var description = IntentDescription("將動態島顯示的最新雙語字幕加入 LZHCard 待複習單字庫。")

    public init() {}

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        let latest = LzhSharedEcosystemStore.getLatestSubtitle()
        let src = latest.source.trimmingCharacters(in: .whitespacesAndNewlines)
        let tr = latest.translated.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !src.isEmpty || !tr.isEmpty else {
            return .result(dialog: "目前尚無可收藏的字幕內容。")
        }
        LzhSharedEcosystemStore.enqueuePendingSaveCard(sourceText: src, translatedText: tr)
        let preview = src.isEmpty ? tr : src
        return .result(dialog: "已將「\(preview)」加入 LZHCard 字幕收藏清單。")
    }
}

@available(iOS 16.0, *)
public struct StartSubtitleRecognitionIntent: AppIntent {
    public static var title: LocalizedStringResource = "啟動 LZHCard 字幕識別"
    public static var description = IntentDescription("開啟 LZHCard 子母畫面（PiP）與螢幕即時雙語字幕識別。")
    public static var openAppWhenRun: Bool = true

    public init() {}

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        LzhSharedEcosystemStore.setSubtitlePaused(false)
        LzhSharedEcosystemStore.dispatchShortcutAction("start_subtitle_recognition")
        return .result(dialog: "正在啟動 LZHCard 即時字幕識別。")
    }
}

@available(iOS 16.0, *)
public struct StopSubtitleRecognitionIntent: AppIntent {
    public static var title: LocalizedStringResource = "停止 LZHCard 字幕識別"
    public static var description = IntentDescription("關閉目前的子母畫面即時字幕與動態島翻譯活動。")
    public static var openAppWhenRun: Bool = false

    public init() {}

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        LzhSharedEcosystemStore.setSubtitlePaused(false)
        LzhSharedEcosystemStore.dispatchShortcutAction("stop_subtitle_recognition")
        return .result(dialog: "已停止 LZHCard 字幕識別。")
    }
}

@available(iOS 16.0, *)
public struct ToggleFloatingTranslatorIntent: AppIntent {
    public static var title: LocalizedStringResource = "切換 LZHCard 懸浮球"
    public static var description = IntentDescription("顯示或隱藏 LZHCard App 內角落可拖曳懸浮翻譯球。")
    public static var openAppWhenRun: Bool = true

    public init() {}

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        LzhSharedEcosystemStore.dispatchShortcutAction("toggle_inapp_floating")
        return .result(dialog: "已切換 LZHCard 角落懸浮球顯示狀態。")
    }
}

@available(iOS 16.0, *)
public struct StartReviewSessionIntent: AppIntent {
    public static var title: LocalizedStringResource = "開始今日複習"
    public static var description = IntentDescription("立即開啟 LZHCard 記憶卡片複習模式。")
    public static var openAppWhenRun: Bool = true

    public init() {}

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        LzhSharedEcosystemStore.dispatchShortcutAction("start_review_session")
        return .result(dialog: "正在開啟 LZHCard 今日單字複習。")
    }
}

@available(iOS 16.0, *)
public struct QuickTranslateWordIntent: AppIntent {
    public static var title: LocalizedStringResource = "快速拍照／懸浮查字"
    public static var description = IntentDescription("開啟 LZHCard 即時翻譯與查字面板。")
    public static var openAppWhenRun: Bool = true

    public init() {}

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        LzhSharedEcosystemStore.dispatchShortcutAction("open_quick_translate")
        return .result(dialog: "正在開啟 LZHCard 翻譯面板。")
    }
}

@available(iOS 16.0, *)
public struct CheckDailyStudyStatusIntent: AppIntent {
    public static var title: LocalizedStringResource = "查詢今日待複習單字"
    public static var description = IntentDescription("不用開啟 App 即可透過 Siri 播報目前待複習數與連續學習天數。")
    public static var openAppWhenRun: Bool = false

    public init() {}

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        let snap = LzhSharedEcosystemStore.loadSnapshot()
        if snap.totalWords == 0 {
            return .result(dialog: "你的 LZHCard 目前共 0 個單字，快新增或從字幕收藏單字吧！")
        }
        var msg = "LZHCard 目前有 \(snap.dueCount) 張單字卡待複習，總字庫 \(snap.totalWords) 個單字，已連續學習 \(snap.streakDays) 天。"
        if !snap.featuredWord.isEmpty {
            let mPart = snap.featuredMeaning.isEmpty ? "" : "，意思是「\(snap.featuredMeaning)」"
            msg += " 今日精選複習單字是 \(snap.featuredWord)\(mPart)。"
        }
        return .result(dialog: "\(msg)")
    }
}

@available(iOS 16.0, *)
public struct SaveLatestSubtitleShortcutIntent: AppIntent {
    public static var title: LocalizedStringResource = "收藏最新字幕單字"
    public static var description = IntentDescription("把剛剛翻譯的最新一句螢幕字幕存成 LZHCard 單字卡。")
    public static var openAppWhenRun: Bool = false

    public init() {}

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        let latest = LzhSharedEcosystemStore.getLatestSubtitle()
        let src = latest.source.trimmingCharacters(in: .whitespacesAndNewlines)
        let tr = latest.translated.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !src.isEmpty || !tr.isEmpty else {
            return .result(dialog: "目前沒有暫存的即時字幕可供收藏。")
        }
        LzhSharedEcosystemStore.enqueuePendingSaveCard(sourceText: src, translatedText: tr)
        let preview = src.isEmpty ? tr : src
        return .result(dialog: "已收藏字幕「\(preview)」至 LZHCard。")
    }
}

@available(iOS 16.0, *)
public struct LzhShortcutsProvider: AppShortcutsProvider {
    public static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartSubtitleRecognitionIntent(),
            phrases: [
                "啟動 \(.applicationName) 字幕識別",
                "開啟 \(.applicationName) 螢幕翻譯"
            ],
            shortTitle: "啟動字幕識別",
            systemImageName: "captions.bubble.fill"
        )
        AppShortcut(
            intent: StopSubtitleRecognitionIntent(),
            phrases: [
                "停止 \(.applicationName) 字幕識別",
                "關閉 \(.applicationName) 螢幕翻譯"
            ],
            shortTitle: "停止字幕識別",
            systemImageName: "stop.circle"
        )
        AppShortcut(
            intent: ToggleFloatingTranslatorIntent(),
            phrases: [
                "切換 \(.applicationName) 懸浮球",
                "切換 \(.applicationName) 懸浮翻譯"
            ],
            shortTitle: "切換懸浮球",
            systemImageName: "circle.dashed"
        )
        AppShortcut(
            intent: StartReviewSessionIntent(),
            phrases: [
                "開始 \(.applicationName) 複習",
                "用 \(.applicationName) 複習單字"
            ],
            shortTitle: "今日複習",
            systemImageName: "rectangle.stack.fill"
        )
        AppShortcut(
            intent: QuickTranslateWordIntent(),
            phrases: [
                "用 \(.applicationName) 查單字",
                "開啟 \(.applicationName) 拍照翻譯"
            ],
            shortTitle: "快速翻譯",
            systemImageName: "camera.viewfinder"
        )
        AppShortcut(
            intent: CheckDailyStudyStatusIntent(),
            phrases: [
                "查詢 \(.applicationName) 待複習",
                "\(.applicationName) 今天要複習幾個單字"
            ],
            shortTitle: "待複習進度",
            systemImageName: "chart.bar.fill"
        )
        AppShortcut(
            intent: SaveLatestSubtitleShortcutIntent(),
            phrases: [
                "收藏 \(.applicationName) 字幕",
                "用 \(.applicationName) 記下這句字幕"
            ],
            shortTitle: "收藏字幕",
            systemImageName: "bookmark.fill"
        )
    }
}
#endif
