import Foundation
#if canImport(ActivityKit)
import ActivityKit

@available(iOS 16.1, *)
public struct LzhTranslateActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var sourceText: String
        public var translatedText: String
        public var statusLabel: String
        public var isActive: Bool
        public var isPaused: Bool
        public var sourceLang: String
        public var updatedAt: TimeInterval

        public init(
            sourceText: String,
            translatedText: String,
            statusLabel: String,
            isActive: Bool,
            isPaused: Bool = false,
            sourceLang: String,
            updatedAt: TimeInterval
        ) {
            self.sourceText = sourceText
            self.translatedText = translatedText
            self.statusLabel = statusLabel
            self.isActive = isActive
            self.isPaused = isPaused
            self.sourceLang = sourceLang
            self.updatedAt = updatedAt
        }
    }

    public var sessionTitle: String

    public init(sessionTitle: String = "LZHCard 即時字幕") {
        self.sessionTitle = sessionTitle
    }
}
#endif
