import Foundation
import ReplayKit
import Vision
import CoreImage
import CoreVideo
import ImageIO
#if canImport(Translation)
import Translation
#endif

private struct TranslationRuntimeConfig {
    var engine: String = "apple_offline"
    var provider: String = "apple_offline"
    var model: String = "apple_translation"
    var sourceLang: String = "en"
    var targetLang: String = "zh-Hant"
    var apiKey: String = ""
    var workerBaseUrl: String = "https://lzhcard.tomlin980415.workers.dev"
    var authToken: String = ""
    var regionMode: String = "auto"
    var regionX: Double = 0.12
    var regionY: Double = 0.75
    var regionW: Double = 0.76
    var regionH: Double = 0.18
}

class SampleHandler: RPBroadcastSampleHandler {

    private let loopbackBaseUrl = "http://127.0.0.1:49152"
    private let darwinNotificationName = "com.lzhcard.app.pip.subtitle.updated" as CFString

    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private let visionQueue = DispatchQueue(label: "com.lzhcard.broadcast.vision", qos: .utility)

    private lazy var resolvedAppGroupId: String? = resolveAccessibleAppGroupId()
    private lazy var sharedContainerBridgeFileUrl: URL? = resolveSharedBridgeFileUrl()
    private lazy var loopbackSession: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 2.0
        cfg.timeoutIntervalForResource = 3.0
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()
    private lazy var cloudSession: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 8.0
        cfg.timeoutIntervalForResource = 10.0
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()

    private var cachedConfig = TranslationRuntimeConfig()
    private var lastConfigRefreshAt: TimeInterval = 0
    private var isProcessingFrame = false
    private var lastFrameAt: TimeInterval = 0
    private var lastSignature: [UInt8] = []
    private var lastRecognizedText: String = ""
    private var lastPushedSubtitle: String = ""
    private var ocrSequence: Int = 0

    private var sharedDefaults: UserDefaults {
        if let gid = resolvedAppGroupId, let suite = UserDefaults(suiteName: gid) {
            return suite
        }
        return UserDefaults.standard
    }

    private func resolveAccessibleAppGroupId() -> String? {
        let extBundleId = (Bundle.main.bundleIdentifier ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var candidates: [String] = []

        if let infoGroup = Bundle.main.object(forInfoDictionaryKey: "LZHAppGroupIdentifier") as? String {
            let trimmed = infoGroup.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                candidates.append(trimmed)
            }
        }
        if extBundleId.hasSuffix(".BroadcastUpload") {
            let mainBundleId = String(extBundleId.dropLast(".BroadcastUpload".count))
            if !mainBundleId.isEmpty {
                candidates.append("group.\(mainBundleId)")
            }
        } else if let dotRange = extBundleId.range(of: ".", options: .backwards) {
            let mainBundleId = String(extBundleId[..<dotRange.lowerBound])
            if !mainBundleId.isEmpty {
                candidates.append("group.\(mainBundleId)")
            }
        }
        candidates.append("group.com.lzhcard.app")

        var seen = Set<String>()
        for gid in candidates where !gid.isEmpty && !seen.contains(gid) {
            seen.insert(gid)
            if FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: gid) != nil {
                return gid
            }
        }
        return nil
    }

    private func resolveSharedBridgeFileUrl() -> URL? {
        guard let gid = resolvedAppGroupId,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: gid) else {
            return nil
        }
        let cachesDir = container.appendingPathComponent("Library/Caches", isDirectory: true)
        try? FileManager.default.createDirectory(at: cachesDir, withIntermediateDirectories: true)
        return cachesDir.appendingPathComponent("lzh_pip_bridge.json")
    }

    private func readSharedBridgeState() -> [String: Any] {
        guard let url = sharedContainerBridgeFileUrl,
              let data = try? Data(contentsOf: url),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return dict
    }

    private func writeSharedBridgeState(merging updates: [String: Any]) {
        guard let url = sharedContainerBridgeFileUrl else { return }
        var state = readSharedBridgeState()
        for (k, v) in updates {
            state[k] = v
        }
        if let data = try? JSONSerialization.data(withJSONObject: state, options: []) {
            try? data.write(to: url, options: .atomic)
        }
    }

    private func postDarwinSubtitleNotification() {
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterPostNotification(center, CFNotificationName(darwinNotificationName), nil, nil, true)
    }

    private func applyConfigDictionary(_ dict: [String: Any]) {
        var next = cachedConfig
        if let eng = dict["engine"] as? String, !eng.isEmpty { next.engine = eng }
        if let prov = dict["provider"] as? String, !prov.isEmpty { next.provider = prov }
        if let mdl = dict["model"] as? String, !mdl.isEmpty { next.model = mdl }
        if let src = dict["sourceLang"] as? String, !src.isEmpty { next.sourceLang = src }
        if let dst = dict["targetLang"] as? String, !dst.isEmpty { next.targetLang = dst }
        if let key = dict["apiKey"] as? String { next.apiKey = key.trimmingCharacters(in: .whitespacesAndNewlines) }
        if let worker = dict["workerBaseUrl"] as? String, !worker.isEmpty {
            next.workerBaseUrl = worker.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let tok = dict["authToken"] as? String { next.authToken = tok.trimmingCharacters(in: .whitespacesAndNewlines) }
        if let rm = dict["regionMode"] as? String, !rm.isEmpty { next.regionMode = rm }
        let reg = (dict["cropRect"] as? [String: Any]) ?? (dict["region"] as? [String: Any])
        if let reg = reg {
            let rw = (reg["width"] as? NSNumber)?.doubleValue ?? (reg["width"] as? Double) ?? 0
            let rh = (reg["height"] as? NSNumber)?.doubleValue ?? (reg["height"] as? Double) ?? 0
            if rw > 0.05 && rh > 0.05 {
                next.regionX = (reg["x"] as? NSNumber)?.doubleValue ?? (reg["x"] as? Double) ?? 0.12
                next.regionY = (reg["y"] as? NSNumber)?.doubleValue ?? (reg["y"] as? Double) ?? 0.75
                next.regionW = rw
                next.regionH = rh
            }
        }
        cachedConfig = next
    }

    private func loadConfigFromChannelA() {
        let state = readSharedBridgeState()
        if let cfgDict = state["config"] as? [String: Any] {
            applyConfigDictionary(cfgDict)
            return
        }
        let defaults = sharedDefaults
        var dict: [String: Any] = [:]
        if let eng = defaults.string(forKey: "lzh_translate_engine") { dict["engine"] = eng }
        if let prov = defaults.string(forKey: "lzh_translate_provider") { dict["provider"] = prov }
        if let mdl = defaults.string(forKey: "lzh_translate_model") { dict["model"] = mdl }
        if let src = defaults.string(forKey: "lzh_source_lang") { dict["sourceLang"] = src }
        if let dst = defaults.string(forKey: "lzh_target_lang") { dict["targetLang"] = dst }
        if let key = defaults.string(forKey: "lzh_custom_api_key") { dict["apiKey"] = key }
        if let worker = defaults.string(forKey: "lzh_worker_base_url") { dict["workerBaseUrl"] = worker }
        if let tok = defaults.string(forKey: "lzh_auth_token") { dict["authToken"] = tok }
        if let rm = defaults.string(forKey: "lzh_region_mode") { dict["regionMode"] = rm }
        let rw = defaults.double(forKey: "lzh_region_w")
        let rh = defaults.double(forKey: "lzh_region_h")
        if rw > 0.05 && rh > 0.05 {
            let rect: [String: Double] = [
                "x": defaults.double(forKey: "lzh_region_x"),
                "y": defaults.double(forKey: "lzh_region_y"),
                "width": rw,
                "height": rh
            ]
            dict["region"] = rect
            dict["cropRect"] = rect
        }
        applyConfigDictionary(dict)
    }

    private func refreshConfigViaLoopback(completion: (() -> Void)? = nil) {
        loadConfigFromChannelA()
        guard let url = URL(string: "\(loopbackBaseUrl)/config") else {
            completion?()
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        loopbackSession.dataTask(with: req) { [weak self] data, _, _ in
            defer { completion?() }
            guard let self = self,
                  let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return
            }
            self.visionQueue.async {
                self.applyConfigDictionary(json)
            }
        }.resume()
    }

    private func sendLoopbackSubtitleRequest(_ payloadData: Data, retriesLeft: Int) {
        guard let url = URL(string: "\(loopbackBaseUrl)/subtitle") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = payloadData
        loopbackSession.dataTask(with: req) { [weak self] _, response, error in
            let httpOk = (response as? HTTPURLResponse)?.statusCode == 200
            if (!httpOk || error != nil), retriesLeft > 0 {
                self?.visionQueue.asyncAfter(deadline: .now() + 0.25) {
                    self?.sendLoopbackSubtitleRequest(payloadData, retriesLeft: retriesLeft - 1)
                }
            }
        }.resume()
    }

    private func pushSubtitleToMainApp(_ subtitle: String, ocrSourceText: String? = nil, retryOnFailure: Bool = false) {
        let clean = subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        lastPushedSubtitle = clean

        // Channel A: App Group UserDefaults + shared container file + Darwin notification
        let defaults = sharedDefaults
        defaults.set(clean, forKey: "lzh_latest_pip_subtitle")
        if let src = ocrSourceText, !src.isEmpty {
            ocrSequence += 1
            defaults.set(src, forKey: "lzh_latest_ocr_text")
            defaults.set(ocrSequence, forKey: "lzh_latest_ocr_seq")
        }
        defaults.synchronize()

        var bridgeUpdates: [String: Any] = [
            "subtitle": clean,
            "subtitleUpdatedAt": Date().timeIntervalSince1970
        ]
        if let src = ocrSourceText, !src.isEmpty {
            bridgeUpdates["ocrText"] = src
            bridgeUpdates["ocrSeq"] = ocrSequence
        }
        writeSharedBridgeState(merging: bridgeUpdates)
        postDarwinSubtitleNotification()

        // Channel B: Localhost HTTP Loopback (works even when Sideloadly strips App Group entitlements)
        let payload: [String: Any] = [
            "text": clean,
            "sourceText": ocrSourceText ?? "",
            "ts": Date().timeIntervalSince1970
        ]
        if let bodyData = try? JSONSerialization.data(withJSONObject: payload, options: []) {
            sendLoopbackSubtitleRequest(bodyData, retriesLeft: retryOnFailure ? 2 : 0)
        }
    }

    // MARK: - RPBroadcastSampleHandler Lifecycle

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        lastRecognizedText = ""
        lastPushedSubtitle = ""
        lastSignature = []
        lastFrameAt = 0
        isProcessingFrame = false

        sharedDefaults.set(true, forKey: "lzh_broadcast_active")
        sharedDefaults.synchronize()
        writeSharedBridgeState(merging: ["broadcastActive": true])

        refreshConfigViaLoopback()
        pushSubtitleToMainApp("LZHCard 廣播已連線，正在偵測字幕...", retryOnFailure: true)
    }

    override func broadcastPaused() {
        pushSubtitleToMainApp("螢幕翻譯已暫停")
    }

    override func broadcastResumed() {
        refreshConfigViaLoopback()
        pushSubtitleToMainApp("螢幕翻譯已恢復，持續偵測字幕...", retryOnFailure: true)
    }

    override func broadcastFinished() {
        sharedDefaults.set(false, forKey: "lzh_broadcast_active")
        sharedDefaults.synchronize()
        writeSharedBridgeState(merging: ["broadcastActive": false])
        pushSubtitleToMainApp("螢幕翻譯廣播已結束")
    }

    // MARK: - Video Frame Processing (0.9s Throttle + Autoreleasepool Memory Guard)

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video else { return }

        let now = Date().timeIntervalSince1970
        if isProcessingFrame || (now - lastFrameAt) < 0.9 {
            return
        }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let signature = computeQuickLumaSignature(pixelBuffer: pixelBuffer)
        if !lastSignature.isEmpty && !hasSignificantVisualChange(prev: lastSignature, curr: signature) {
            return
        }

        isProcessingFrame = true
        lastFrameAt = now
        lastSignature = signature

        let orientation = extractSampleOrientation(from: sampleBuffer)
        if (now - lastConfigRefreshAt) > 5.0 {
            lastConfigRefreshAt = now
            refreshConfigViaLoopback()
        }
        let activeConfig = cachedConfig

        let cropNorm: CGRect
        if activeConfig.regionMode == "custom", activeConfig.regionW > 0.05, activeConfig.regionH > 0.05 {
            let safeX = max(0.0, min(0.92, activeConfig.regionX))
            let safeY = max(0.0, min(0.92, activeConfig.regionY))
            let safeW = max(0.08, min(1.0 - safeX, activeConfig.regionW))
            let safeH = max(0.08, min(1.0 - safeY, activeConfig.regionH))
            cropNorm = CGRect(x: safeX, y: safeY, width: safeW, height: safeH)
        } else {
            cropNorm = CGRect(x: 0.12, y: 0.75, width: 0.76, height: 0.18)
        }

        var croppedCgImage: CGImage?
        autoreleasepool {
            var ciImage = CIImage(cvPixelBuffer: pixelBuffer)
            if orientation != .up {
                ciImage = ciImage.oriented(forExifOrientation: Int32(orientation.rawValue))
            }
            let extent = ciImage.extent
            let ciRect = CGRect(
                x: extent.origin.x + cropNorm.origin.x * extent.width,
                y: extent.origin.y + (1.0 - cropNorm.origin.y - cropNorm.height) * extent.height,
                width: cropNorm.width * extent.width,
                height: cropNorm.height * extent.height
            ).intersection(extent)

            guard !ciRect.isEmpty, ciRect.width >= 16, ciRect.height >= 16 else {
                return
            }
            let cropped = ciImage.cropped(to: ciRect)
            croppedCgImage = ciContext.createCGImage(cropped, from: cropped.extent)
        }

        guard let cgImage = croppedCgImage else {
            isProcessingFrame = false
            return
        }

        let sourceLang = activeConfig.sourceLang.lowercased()
        visionQueue.async { [weak self] in
            guard let self = self else { return }

            var recognizedText = ""
            autoreleasepool {
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .accurate
                request.usesLanguageCorrection = true
                if sourceLang.hasPrefix("ja") {
                    request.recognitionLanguages = ["ja-JP"]
                } else if sourceLang.hasPrefix("ko") {
                    request.recognitionLanguages = ["ko-KR"]
                } else if sourceLang.hasPrefix("zh") {
                    request.recognitionLanguages = ["zh-Hant"]
                } else {
                    request.recognitionLanguages = ["en-US"]
                }

                let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
                do {
                    try handler.perform([request])
                    let observations = request.results ?? []
                    let lines: [String] = observations.compactMap { obs in
                        guard let top = obs.topCandidates(1).first, top.confidence >= 0.65 else {
                            return nil
                        }
                        let trimmed = top.string.trimmingCharacters(in: .whitespacesAndNewlines)
                        return trimmed.isEmpty ? nil : trimmed
                    }
                    recognizedText = self.cleanRecognizedSubtitleText(lines.joined(separator: " "), sourceLang: sourceLang)
                } catch {
                    recognizedText = ""
                }
            }

            if recognizedText.isEmpty || recognizedText == self.lastRecognizedText {
                self.isProcessingFrame = false
                return
            }
            self.lastRecognizedText = recognizedText

            self.translateTextInExtension(recognizedText, config: activeConfig) { translated in
                defer { self.isProcessingFrame = false }
                let cleanTranslated = (translated ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !cleanTranslated.isEmpty {
                    self.pushSubtitleToMainApp(cleanTranslated, ocrSourceText: recognizedText)
                } else {
                    // Fallback relay via Channel A + Loopback so host app can translate if needed
                    self.pushSubtitleToMainApp(recognizedText, ocrSourceText: recognizedText)
                }
            }
        }
    }

    private func extractSampleOrientation(from sampleBuffer: CMSampleBuffer) -> CGImagePropertyOrientation {
        if let rawAttachment = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil),
           let num = rawAttachment as? NSNumber,
           let orientation = CGImagePropertyOrientation(rawValue: num.uint32Value) {
            return orientation
        }
        return .up
    }

    // MARK: - In-Extension Translation Pipeline (Apple Offline + Cloud Fallback)

    private func translateTextInExtension(_ sourceText: String, config: TranslationRuntimeConfig, completion: @escaping (String?) -> Void) {
        #if canImport(Translation)
        if config.engine == "apple_offline", #available(iOS 26.0, *) {
            Task {
                if let offline = await self.translateWithAppleOffline(text: sourceText, from: config.sourceLang, to: config.targetLang),
                   !offline.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    completion(offline)
                    return
                }
                self.translateViaCloudApi(sourceText, config: config, completion: completion)
            }
            return
        }
        #endif

        translateViaCloudApi(sourceText, config: config, completion: completion)
    }

    #if canImport(Translation)
    @available(iOS 26.0, *)
    private func translateWithAppleOffline(text: String, from sourceCode: String, to targetCode: String) async -> String? {
        do {
            let srcLocale = Locale.Language(identifier: sourceCode)
            let dstLocale = Locale.Language(identifier: targetCode)
            let session = TranslationSession(installedSource: srcLocale, target: dstLocale)
            let response = try await session.translate(text)
            return response.targetText
        } catch {
            return nil
        }
    }
    #endif

    private func translateViaCloudApi(_ sourceText: String, config: TranslationRuntimeConfig, completion: @escaping (String?) -> Void) {
        let customKey = config.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let provider = config.provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let model = config.model.trimmingCharacters(in: .whitespacesAndNewlines)

        let subtitlePrompt = """
        你是一位即時雙語字幕譯者，請將以下 OCR 擷取文字翻譯成自然道地的繁體中文：
        1. 自動忽略句首或句尾殘留的 OCR 亂碼、孤立符號或雜訊，只針對語意連貫的句子進行翻譯。
        2. 若整段內容皆為無意義雜訊或無法辨識，請僅回傳空字串。
        3. 遇到口語慣用語或俚語時，請依語境自然意譯，切勿死板逐字直譯。
        4. 僅輸出最終繁體中文譯文，勿加引號或解釋。

        原文：
        \(sourceText)
        """

        if customKey.hasPrefix("gsk_") || (provider == "groq" && !customKey.isEmpty) {
            let groqModel = model.isEmpty ? "llama-3.1-8b-instant" : model
            guard let url = URL(string: "https://api.groq.com/openai/v1/chat/completions") else {
                completion(nil)
                return
            }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("Bearer \(customKey)", forHTTPHeaderField: "Authorization")
            let body: [String: Any] = [
                "model": groqModel,
                "temperature": 0.2,
                "messages": [
                    ["role": "user", "content": subtitlePrompt]
                ]
            ]
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            cloudSession.dataTask(with: req) { data, _, _ in
                var translated = ""
                if let data = data,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let choices = json["choices"] as? [[String: Any]],
                   let msg = choices.first?["message"] as? [String: Any],
                   let text = msg["content"] as? String {
                    translated = text.trimmingCharacters(in: .whitespacesAndNewlines)
                }
                completion(translated.isEmpty ? nil : translated)
            }.resume()
            return
        }

        if customKey.hasPrefix("AIza") || (provider == "gemini" && !customKey.isEmpty) {
            let gemModel = (model.isEmpty || !model.lowercased().contains("gemini")) ? "gemini-2.0-flash" : model
            let endpoint = "https://generativelanguage.googleapis.com/v1beta/models/\(gemModel):generateContent?key=\(customKey)"
            guard let url = URL(string: endpoint) else {
                completion(nil)
                return
            }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let body: [String: Any] = ["contents": [["parts": [["text": subtitlePrompt]]]]]
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            cloudSession.dataTask(with: req) { data, _, _ in
                var translated = ""
                if let data = data,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let cands = json["candidates"] as? [[String: Any]],
                   let content = cands.first?["content"] as? [String: Any],
                   let parts = content["parts"] as? [[String: Any]],
                   let text = parts.first?["text"] as? String {
                    translated = text.trimmingCharacters(in: .whitespacesAndNewlines)
                }
                completion(translated.isEmpty ? nil : translated)
            }.resume()
            return
        }

        let workerBase = config.workerBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !workerBase.isEmpty, let url = URL(string: "\(workerBase)/ai/fast-refine") else {
            completion(nil)
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !config.authToken.isEmpty {
            req.setValue("Bearer \(config.authToken)", forHTTPHeaderField: "Authorization")
        }
        let body: [String: Any] = [
            "text": sourceText,
            "sourceLang": config.sourceLang.isEmpty ? "auto" : config.sourceLang,
            "targetLang": "zh-TW",
            "targetLangName": "繁體中文"
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        cloudSession.dataTask(with: req) { data, _, _ in
            var translated = ""
            if let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let tr = json["translation"] as? String {
                translated = tr.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            completion(translated.isEmpty ? nil : translated)
        }.resume()
    }

    // MARK: - OCR Filtering & Luma Diff

    private func cleanRecognizedSubtitleText(_ raw: String, sourceLang: String) -> String {
        var text = raw.replacingOccurrences(of: "[|=~^_`\\\\§©®]+", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return "" }

        if sourceLang.hasPrefix("en") || (!sourceLang.hasPrefix("ja") && !sourceLang.hasPrefix("ko") && !sourceLang.hasPrefix("zh")) {
            let tokens = text.split(separator: " ").map(String.init)
            let kept = tokens.filter { tok in
                let core = tok.trimmingCharacters(in: .punctuationCharacters)
                if core.isEmpty { return false }
                if core.count == 1 {
                    return core == "a" || core == "A" || core == "I"
                }
                return core.range(of: "[A-Za-z0-9]", options: .regularExpression) != nil
            }
            text = kept.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        }

        let meaningfulScalars = text.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.count
        if meaningfulScalars < 2 { return "" }
        if Double(meaningfulScalars) / Double(max(1, text.count)) < 0.45 { return "" }
        return text
    }

    private func computeQuickLumaSignature(pixelBuffer: CVPixelBuffer) -> [UInt8] {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        guard let baseAddr = CVPixelBufferGetBaseAddress(pixelBuffer) else { return [] }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let ptr = baseAddr.assumingMemoryBound(to: UInt8.self)

        var sig: [UInt8] = []
        sig.reserveCapacity(64)
        for gy in 0..<8 {
            let py = min(height - 1, (gy * height) / 8)
            for gx in 0..<8 {
                let px = min(width - 1, (gx * width) / 8)
                let offset = py * bytesPerRow + px * 4
                if offset + 2 < bytesPerRow * height {
                    let b = Int(ptr[offset])
                    let g = Int(ptr[offset + 1])
                    let r = Int(ptr[offset + 2])
                    let luma = UInt8((r * 299 + g * 587 + b * 114) / 1000)
                    sig.append(luma)
                }
            }
        }
        return sig
    }

    private func hasSignificantVisualChange(prev: [UInt8], curr: [UInt8]) -> Bool {
        guard prev.count == curr.count, !curr.isEmpty else { return true }
        var diffCount = 0
        for i in 0..<curr.count {
            if abs(Int(prev[i]) - Int(curr[i])) > 18 {
                diffCount += 1
            }
        }
        return Double(diffCount) / Double(curr.count) >= 0.05
    }
}
