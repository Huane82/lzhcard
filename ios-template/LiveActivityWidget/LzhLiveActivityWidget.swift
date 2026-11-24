import WidgetKit
import SwiftUI
#if canImport(ActivityKit)
import ActivityKit
#endif
#if canImport(AppIntents)
import AppIntents
#endif

// MARK: - Live Activity + Interactive Dynamic Island

#if canImport(ActivityKit)
@available(iOS 16.1, *)
struct LzhTranslateLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LzhTranslateActivityAttributes.self) { context in
            // Lock Screen / Notification Banner Live Activity View
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(context.state.isPaused ? Color.orange : (context.state.isActive ? Color.green : Color.gray))
                        .frame(width: 8, height: 8)
                    Text(context.attributes.sessionTitle)
                        .font(.caption2.weight(.bold))
                        .foregroundColor(.white.opacity(0.85))
                    Spacer()
                    Text(context.state.isPaused ? "⏸ 已暫停" : context.state.statusLabel)
                        .font(.caption2.weight(.semibold))
                        .foregroundColor(context.state.isPaused ? .orange : .green.opacity(0.9))
                }

                if !context.state.sourceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(context.state.sourceText)
                        .font(.caption)
                        .foregroundColor(.white.opacity(0.72))
                        .lineLimit(2)
                }

                Text(context.state.translatedText.isEmpty ? "等待偵測畫面字幕..." : context.state.translatedText)
                    .font(.subheadline.weight(.bold))
                    .foregroundColor(.white)
                    .lineLimit(3)

                #if canImport(AppIntents)
                if #available(iOS 17.0, *) {
                    HStack(spacing: 8) {
                        Button(intent: ToggleSubtitlePauseIntent()) {
                            Label(
                                context.state.isPaused ? "繼續" : "暫停",
                                systemImage: context.state.isPaused ? "play.fill" : "pause.fill"
                            )
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(Color.white.opacity(0.14), in: Capsule())
                            .foregroundColor(context.state.isPaused ? .mint : .orange)
                        }
                        .buttonStyle(.plain)

                        Button(intent: SaveCurrentSubtitleCardIntent()) {
                            Label("存單字卡", systemImage: "bookmark.fill")
                                .font(.caption2.weight(.bold))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(Color.mint.opacity(0.22), in: Capsule())
                                .foregroundColor(.mint)
                        }
                        .buttonStyle(.plain)

                        Spacer()
                    }
                    .padding(.top, 2)
                }
                #endif
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .activityBackgroundTint(Color(red: 0.06, green: 0.09, blue: 0.16).opacity(0.92))
            .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(context.state.isPaused ? Color.orange : (context.state.isActive ? Color.green : Color.gray))
                            .frame(width: 7, height: 7)
                        Text(context.state.isPaused ? "暫停" : "字幕")
                            .font(.caption2.weight(.bold))
                            .foregroundColor(.white)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.sourceLang.uppercased())
                        .font(.caption2.weight(.bold))
                        .foregroundColor(.mint)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.isPaused ? "⏸ 已暫停" : context.state.statusLabel)
                        .font(.caption2.weight(.semibold))
                        .foregroundColor(context.state.isPaused ? .orange : .white.opacity(0.85))
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        if !context.state.sourceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text(context.state.sourceText)
                                .font(.caption2)
                                .foregroundColor(.white.opacity(0.68))
                                .lineLimit(2)
                        }
                        Text(context.state.translatedText.isEmpty ? "LZHCard 即時雙語翻譯待命中" : context.state.translatedText)
                            .font(.callout.weight(.bold))
                            .foregroundColor(.white)
                            .lineLimit(3)

                        #if canImport(AppIntents)
                        if #available(iOS 17.0, *) {
                            HStack(spacing: 8) {
                                Button(intent: ToggleSubtitlePauseIntent()) {
                                    Label(
                                        context.state.isPaused ? "繼續" : "暫停",
                                        systemImage: context.state.isPaused ? "play.fill" : "pause.fill"
                                    )
                                    .font(.caption2.weight(.bold))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 5)
                                    .background(Color.white.opacity(0.14), in: Capsule())
                                    .foregroundColor(context.state.isPaused ? .mint : .orange)
                                }
                                .buttonStyle(.plain)

                                Button(intent: SaveCurrentSubtitleCardIntent()) {
                                    Label("存單字", systemImage: "bookmark.fill")
                                        .font(.caption2.weight(.bold))
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 5)
                                        .background(Color.mint.opacity(0.22), in: Capsule())
                                        .foregroundColor(.mint)
                                }
                                .buttonStyle(.plain)

                                Spacer()
                            }
                            .padding(.top, 2)
                        } else {
                            Text("即時雙語字幕識別中")
                                .font(.caption2)
                                .foregroundColor(.white.opacity(0.55))
                        }
                        #endif
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                HStack(spacing: 3) {
                    Image(systemName: context.state.isPaused ? "pause.circle.fill" : (context.state.isActive ? "captions.bubble.fill" : "captions.bubble"))
                        .font(.caption2)
                        .foregroundColor(context.state.isPaused ? .orange : (context.state.isActive ? .mint : .secondary))
                }
            } compactTrailing: {
                Text(context.state.isPaused ? "已暫停" : (context.state.translatedText.isEmpty ? "譯" : String(context.state.translatedText.prefix(8))))
                    .font(.caption2.weight(.semibold))
                    .foregroundColor(context.state.isPaused ? .orange : .white)
                    .lineLimit(1)
            } minimal: {
                Image(systemName: context.state.isPaused ? "pause.fill" : (context.state.isActive ? "captions.bubble.fill" : "captions.bubble"))
                    .font(.caption2)
                    .foregroundColor(context.state.isPaused ? .orange : .mint)
            }
            .keylineTint(context.state.isPaused ? .orange : .mint)
        }
    }
}
#endif

// MARK: - Home & Lock Screen Study Progress Widget

struct LzhStudyEntry: TimelineEntry {
    let date: Date
    let dueCount: Int
    let streakDays: Int
    let totalWords: Int
    let featuredWord: String
    let featuredMeaning: String
}

struct LzhStudyTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> LzhStudyEntry {
        LzhStudyEntry(
            date: Date(),
            dueCount: 12,
            streakDays: 7,
            totalWords: 320,
            featuredWord: "resilient",
            featuredMeaning: "有韌性的、能迅速恢復的"
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (LzhStudyEntry) -> Void) {
        completion(loadCurrentEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<LzhStudyEntry>) -> Void) {
        let entry = loadCurrentEntry()
        let nextRefresh = Calendar.current.date(byAdding: .minute, value: 15, to: Date()) ?? Date().addingTimeInterval(900)
        completion(Timeline(entries: [entry], policy: .after(nextRefresh)))
    }

    private func loadCurrentEntry() -> LzhStudyEntry {
        let snap = LzhSharedEcosystemStore.loadSnapshot()
        return LzhStudyEntry(
            date: Date(),
            dueCount: max(0, snap.dueCount),
            streakDays: max(0, snap.streakDays),
            totalWords: max(0, snap.totalWords),
            featuredWord: snap.featuredWord,
            featuredMeaning: snap.featuredMeaning
        )
    }
}

private extension View {
    @ViewBuilder
    func lzhStudyWidgetContainerBackground() -> some View {
        let bgGradient = LinearGradient(
            colors: [
                Color(red: 0.06, green: 0.10, blue: 0.20),
                Color(red: 0.09, green: 0.15, blue: 0.29)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        if #available(iOS 17.0, *) {
            self.containerBackground(for: .widget) {
                bgGradient
            }
        } else {
            self.background(bgGradient)
        }
    }
}

@available(iOS 16.0, *)
struct LzhStudyProgressWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: LzhStudyEntry

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 1) {
                    Text("\(entry.dueCount)")
                        .font(.system(size: 16, weight: .black, design: .rounded))
                    Text("待複習")
                        .font(.system(size: 9, weight: .bold))
                        .opacity(0.85)
                }
            }
            .widgetURL(URL(string: "lzhcard://review"))

        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Image(systemName: "rectangle.stack.fill")
                        .font(.caption2)
                    Text("LZHCard · 待複習 \(entry.dueCount)")
                        .font(.caption.weight(.bold))
                        .lineLimit(1)
                }
                Text("🔥 連勝 \(entry.streakDays) 天 · 共 \(entry.totalWords) 詞")
                    .font(.caption2)
                    .opacity(0.85)
                    .lineLimit(1)
                if !entry.featuredWord.isEmpty {
                    Text("\(entry.featuredWord) \(entry.featuredMeaning)")
                        .font(.caption2.weight(.semibold))
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .widgetURL(URL(string: "lzhcard://review"))

        case .systemMedium:
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 4) {
                        Image(systemName: "sparkles")
                            .font(.caption2)
                            .foregroundColor(.mint)
                        Text("LZHCard")
                            .font(.caption2.weight(.black))
                            .foregroundColor(.white.opacity(0.85))
                    }
                    Text("\(entry.dueCount)")
                        .font(.system(size: 32, weight: .black, design: .rounded))
                        .foregroundColor(.mint)
                        .lineLimit(1)
                    Text("今日待複習卡片")
                        .font(.caption2.weight(.bold))
                        .foregroundColor(.white.opacity(0.75))
                    Spacer(minLength: 2)
                    HStack(spacing: 6) {
                        Text("🔥 \(entry.streakDays) 天")
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Color.orange.opacity(0.24), in: Capsule())
                            .foregroundColor(.orange)
                        Text("\(entry.totalWords) 詞")
                            .font(.caption2.weight(.bold))
                            .foregroundColor(.white.opacity(0.7))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .leading, spacing: 6) {
                    Text("精選記憶卡")
                        .font(.caption2.weight(.bold))
                        .foregroundColor(.cyan.opacity(0.9))
                    if !entry.featuredWord.isEmpty {
                        Text(entry.featuredWord)
                            .font(.subheadline.weight(.black))
                            .foregroundColor(.white)
                            .lineLimit(2)
                        Text(entry.featuredMeaning.isEmpty ? "點擊前往複習" : entry.featuredMeaning)
                            .font(.caption)
                            .foregroundColor(.white.opacity(0.75))
                            .lineLimit(2)
                    } else {
                        Text("開始今日學習")
                            .font(.subheadline.weight(.bold))
                            .foregroundColor(.white)
                        Text("點擊快速開啟單字卡或即時翻譯")
                            .font(.caption2)
                            .foregroundColor(.white.opacity(0.68))
                    }
                    Spacer(minLength: 2)
                    HStack(spacing: 6) {
                        Link(destination: URL(string: "lzhcard://review")!) {
                            Text("開始複習")
                                .font(.caption2.weight(.bold))
                                .padding(.horizontal, 9)
                                .padding(.vertical, 4)
                                .background(Color.mint, in: Capsule())
                                .foregroundColor(.black)
                        }
                        Link(destination: URL(string: "lzhcard://subtitle-start")!) {
                            Text("字幕")
                                .font(.caption2.weight(.bold))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Color.white.opacity(0.16), in: Capsule())
                                .foregroundColor(.white)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
            }
            .padding(12)
            .lzhStudyWidgetContainerBackground()
            .widgetURL(URL(string: "lzhcard://review"))

        default:
            // .systemSmall
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 4) {
                    Image(systemName: "rectangle.stack.fill")
                        .font(.caption2)
                        .foregroundColor(.mint)
                    Text("LZHCard")
                        .font(.caption2.weight(.black))
                        .foregroundColor(.white.opacity(0.85))
                    Spacer()
                    Text("🔥 \(entry.streakDays)d")
                        .font(.caption2.weight(.bold))
                        .foregroundColor(.orange)
                }
                Spacer(minLength: 2)
                Text("\(entry.dueCount)")
                    .font(.system(size: 34, weight: .black, design: .rounded))
                    .foregroundColor(.mint)
                Text("今日待複習")
                    .font(.caption2.weight(.bold))
                    .foregroundColor(.white.opacity(0.75))
                if !entry.featuredWord.isEmpty {
                    Text(entry.featuredWord)
                        .font(.caption.weight(.bold))
                        .foregroundColor(.white)
                        .lineLimit(1)
                } else {
                    Text("字庫共 \(entry.totalWords) 詞")
                        .font(.caption2)
                        .foregroundColor(.white.opacity(0.65))
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .lzhStudyWidgetContainerBackground()
            .widgetURL(URL(string: "lzhcard://review"))
        }
    }
}

@available(iOS 16.0, *)
struct LzhStudyProgressWidget: Widget {
    let kind: String = "LzhStudyProgressWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: LzhStudyTimelineProvider()) { entry in
            LzhStudyProgressWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("LZHCard 每日學習小工具")
        .description("快速查看今日待複習數、連續學習天數與精選單字卡。")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}

@main
struct LzhLiveActivityWidgetBundle: WidgetBundle {
    var body: some Widget {
        #if canImport(ActivityKit)
        LzhTranslateLiveActivityWidget()
        #endif
        LzhStudyProgressWidget()
    }
}
