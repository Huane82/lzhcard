import Foundation
import ReplayKit
import Vision
import CoreImage
import CoreVideo
import ImageIO
import Darwin
#if canImport(Translation)
import Translation
#endif

private struct TranslationRuntimeConfig {
    var engine: String = "apple_offline"
    var provider: String = "apple_offline"
    var model: String = "apple_translation"
    var sourceLang: String = "en"
    var targetLang: String = "zh-Hant"
    var workerBaseUrl: String = "https://lzhcard.tomlin980415.workers.dev"
    var authToken: String = ""
    var regionMode: String = "auto"
    var regionX: Double = 0.12
    var regionY: Double = 0.75
    var regionW: Double = 0.76
    var regionH: Double = 0.18
    var portraitRegionMode: String = "auto"
    var portraitRegionX: Double = 0.08
    var portraitRegionY: Double = 0.70
    var portraitRegionW: Double = 0.84
    var portraitRegionH: Double = 0.22
    var landscapeRegionMode: String = "auto"
    var landscapeRegionX: Double = 0.12
    var landscapeRegionY: Double = 0.74
    var landscapeRegionW: Double = 0.76
    var landscapeRegionH: Double = 0.20
    var isPaused: Bool = false
}

class SampleHandler: RPBroadcastSampleHandler {

    private let loopbackHost = "127.0.0.1"
    private let loopbackCandidatePorts: [UInt16] = [49152, 49153, 49154, 49155, 49156]
    private let darwinNotificationName = "com.lzhcard.app.pip.subtitle.updated" as CFString
    private let ipcWakeDarwinNotificationName = "com.lzhcard.app.ipc.wake" as CFString
    private let localBroadcastStartedDarwinName = "com.lzhcard.app.broadcast.started.local" as CFString
    private let localBroadcastFinishedDarwinName = "com.lzhcard.app.broadcast.finished.local" as CFString

    private let ciContext = CIContext(options: [
        .useSoftwareRenderer: false,
        .cacheIntermediates: false,
        .workingColorSpace: NSNull()
    ])
    private let visionQueue = DispatchQueue(label: "com.lzhcard.broadcast.vision", qos: .utility)
    private let ipcQueue = DispatchQueue(label: "com.lzhcard.broadcast.ipc", qos: .userInitiated)
    private let stateLock = NSLock()

    private var resolvedAppGroupId: String?
    private var sharedContainerBridgeFileUrl: URL?
    private var appGroupWritable: Bool = false
    private var appGroupHandshakeVerified: Bool = false
    private var detectedIpcMode: String = "local"
    private var activeLoopbackPort: UInt16 = 49152

    private lazy var loopbackSession: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 1.2
        cfg.timeoutIntervalForResource = 2.0
        cfg.waitsForConnectivity = false
        cfg.httpShouldUsePipelining = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }()

    private lazy var cloudSession: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 2.8
        cfg.timeoutIntervalForResource = 4.0
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()

    private var cachedConfig = TranslationRuntimeConfig()
    private var lastConfigRefreshAt: TimeInterval = 0
    private var isProcessingFrame = false
    private var lastFrameAt: TimeInterval = 0
    private var lastOcrCompletedAt: TimeInterval = 0
    private var lastSignature: [UInt8] = []
    private var lastRecognizedText: String = ""
    private var lastPushedSubtitle: String = ""
    private var ocrSequence: Int = 0
    private var wasSubtitlePaused: Bool = false

    private var sharedDefaults: UserDefaults {
        stateLock.lock()
        let gid = appGroupWritable ? resolvedAppGroupId : nil
        stateLock.unlock()
        if let gid = gid, let suite = UserDefaults(suiteName: gid) {
            return suite
        }
        return UserDefaults.standard
    }

    private func probeAppGroupAndHandshake(expectedHostToken: String? = nil) {
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
        var foundGid: String?
        var foundBridgeUrl: URL?
        var writable = false
        var verified = false

        for gid in candidates where !gid.isEmpty && !seen.contains(gid) {
            seen.insert(gid)
            guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: gid) else {
                continue
            }
            let cachesDir = container.appendingPathComponent("Library/Caches", isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: cachesDir, withIntermediateDirectories: true)
                let probeFile = cachesDir.appendingPathComponent(".lzh_ext_probe_\(UUID().uuidString).tmp")
                let probeToken = "LZH_EXT_\(Date().timeIntervalSince1970)"
                try probeToken.data(using: .utf8)?.write(to: probeFile, options: .atomic)
                let readBack = try String(contentsOf: probeFile, encoding: .utf8)
                try? FileManager.default.removeItem(at: probeFile)
                if readBack == probeToken {
                    foundGid = gid
                    foundBridgeUrl = cachesDir.appendingPathComponent("lzh_pip_bridge.json")
                    writable = true
                    break
                }
            } catch {
                continue
            }
        }

        if writable, let bridgeUrl = foundBridgeUrl,
           let data = try? Data(contentsOf: bridgeUrl),
           let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let bridgeHostToken = (state["hostSessionToken"] as? String) ?? ""
            if let expected = expectedHostToken, !expected.isEmpty {
                verified = (!bridgeHostToken.isEmpty && bridgeHostToken == expected)
            } else {
                verified = !bridgeHostToken.isEmpty
            }
            if let hp = state["hostLoopbackPort"] as? Int, hp > 0 && hp <= 65535 {
                stateLock.lock()
                activeLoopbackPort = UInt16(hp)
                stateLock.unlock()
            }
            if verified && !bridgeHostToken.isEmpty {
                var updated = state
                updated["extAckSessionToken"] = bridgeHostToken
                updated["extAckAt"] = Date().timeIntervalSince1970
                if let out = try? JSONSerialization.data(withJSONObject: updated, options: []) {
                    try? out.write(to: bridgeUrl, options: .atomic)
                }
            }
        }

        stateLock.lock()
        resolvedAppGroupId = foundGid
        sharedContainerBridgeFileUrl = foundBridgeUrl
        appGroupWritable = writable
        appGroupHandshakeVerified = verified
        detectedIpcMode = (writable && verified) ? "app_group" : "local"
        stateLock.unlock()
    }

    private func readSharedBridgeState() -> [String: Any] {
        stateLock.lock()
        let url = sharedContainerBridgeFileUrl
        stateLock.unlock()
        guard let url = url,
              let data = try? Data(contentsOf: url),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return dict
    }

    private func writeSharedBridgeState(merging updates: [String: Any]) {
        stateLock.lock()
        let url = sharedContainerBridgeFileUrl
        stateLock.unlock()
        guard let url = url else { return }
        var state = readSharedBridgeState()
        for (k, v) in updates {
            state[k] = v
        }
        if let data = try? JSONSerialization.data(withJSONObject: state, options: []) {
            try? data.write(to: url, options: .atomic)
        }
    }

    private func postDarwinNotification(_ name: CFString) {
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterPostNotification(center, CFNotificationName(name), nil, nil, true)
    }

    private func getConfigSnapshot() -> TranslationRuntimeConfig {
        stateLock.lock()
        let copy = cachedConfig
        stateLock.unlock()
        return copy
    }

    private func applyConfigDictionary(_ dict: [String: Any]) {
        stateLock.lock()
        var next = cachedConfig
        stateLock.unlock()
        if let eng = dict["engine"] as? String, !eng.isEmpty { next.engine = eng }
        if let prov = dict["provider"] as? String, !prov.isEmpty { next.provider = prov }
        if let mdl = dict["model"] as? String, !mdl.isEmpty { next.model = mdl }
        if let src = dict["sourceLang"] as? String, !src.isEmpty { next.sourceLang = src }
        if let dst = dict["targetLang"] as? String, !dst.isEmpty { next.targetLang = dst }
        if let worker = dict["workerBaseUrl"] as? String, !worker.isEmpty {
            next.workerBaseUrl = worker.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let tok = dict["authToken"] as? String { next.authToken = tok.trimmingCharacters(in: .whitespacesAndNewlines) }
        if let pausedFlag = dict["isPaused"] as? Bool { next.isPaused = pausedFlag }
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
        if let prm = dict["portraitRegionMode"] as? String, !prm.isEmpty { next.portraitRegionMode = prm }
        if let preg = dict["portraitRegion"] as? [String: Any] {
            let pw = (preg["width"] as? NSNumber)?.doubleValue ?? (preg["width"] as? Double) ?? 0
            let ph = (preg["height"] as? NSNumber)?.doubleValue ?? (preg["height"] as? Double) ?? 0
            if pw > 0.05 && ph > 0.05 {
                next.portraitRegionX = (preg["x"] as? NSNumber)?.doubleValue ?? (preg["x"] as? Double) ?? 0.08
                next.portraitRegionY = (preg["y"] as? NSNumber)?.doubleValue ?? (preg["y"] as? Double) ?? 0.70
                next.portraitRegionW = pw
                next.portraitRegionH = ph
            }
        }
        if let lrm = dict["landscapeRegionMode"] as? String, !lrm.isEmpty { next.landscapeRegionMode = lrm }
        if let lreg = dict["landscapeRegion"] as? [String: Any] {
            let lw = (lreg["width"] as? NSNumber)?.doubleValue ?? (lreg["width"] as? Double) ?? 0
            let lh = (lreg["height"] as? NSNumber)?.doubleValue ?? (lreg["height"] as? Double) ?? 0
            if lw > 0.05 && lh > 0.05 {
                next.landscapeRegionX = (lreg["x"] as? NSNumber)?.doubleValue ?? (lreg["x"] as? Double) ?? 0.12
                next.landscapeRegionY = (lreg["y"] as? NSNumber)?.doubleValue ?? (lreg["y"] as? Double) ?? 0.74
                next.landscapeRegionW = lw
                next.landscapeRegionH = lh
            }
        }
        stateLock.lock()
        cachedConfig = next
        stateLock.unlock()
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
        if let prm = defaults.string(forKey: "lzh_portrait_region_mode") { dict["portraitRegionMode"] = prm }
        let pw = defaults.double(forKey: "lzh_portrait_region_w")
        let ph = defaults.double(forKey: "lzh_portrait_region_h")
        if pw > 0.05 && ph > 0.05 {
            dict["portraitRegion"] = [
                "x": defaults.double(forKey: "lzh_portrait_region_x"),
                "y": defaults.double(forKey: "lzh_portrait_region_y"),
                "width": pw,
                "height": ph
            ]
        }
        if let lrm = defaults.string(forKey: "lzh_landscape_region_mode") { dict["landscapeRegionMode"] = lrm }
        let lw = defaults.double(forKey: "lzh_landscape_region_w")
        let lh = defaults.double(forKey: "lzh_landscape_region_h")
        if lw > 0.05 && lh > 0.05 {
            dict["landscapeRegion"] = [
                "x": defaults.double(forKey: "lzh_landscape_region_x"),
                "y": defaults.double(forKey: "lzh_landscape_region_y"),
                "width": lw,
                "height": lh
            ]
        }
        applyConfigDictionary(dict)
    }

    // MARK: - URLSession Loopback Client (Local Mode & Dual-Channel)

    private func sendLoopbackHttp(port: UInt16, method: String, path: String, body: Data?) -> (statusCode: Int, data: Data)? {
        guard let url = URL(string: "http://\(loopbackHost):\(port)\(path)") else {
            return nil
        }

        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1.2)
        req.httpMethod = method
        if let b = body {
            req.httpBody = b
            req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        }

        let sema = DispatchSemaphore(value: 0)
        var statusCode = 0
        var responseData = Data()

        let task = loopbackSession.dataTask(with: req) { data, response, _ in
            if let http = response as? HTTPURLResponse {
                statusCode = http.statusCode
            }
            if let d = data {
                responseData = d
            }
            sema.signal()
        }
        task.resume()
        _ = sema.wait(timeout: .now() + 1.5)

        guard statusCode > 0 else {
            return nil
        }
        return (statusCode, responseData)
    }

    private func performLoopbackRequestAcrossPorts(method: String, path: String, body: Data?) -> (statusCode: Int, data: Data)? {
        stateLock.lock()
        let preferred = activeLoopbackPort
        stateLock.unlock()

        var portsOrder: [UInt16] = [preferred]
        for p in loopbackCandidatePorts where p != preferred {
            portsOrder.append(p)
        }

        for attempt in 0..<2 {
            for port in portsOrder where port > 0 {
                if let resp = sendLoopbackHttp(port: port, method: method, path: path, body: body), resp.statusCode > 0 {
                    stateLock.lock()
                    activeLoopbackPort = port
                    stateLock.unlock()
                    return resp
                }
            }
            if attempt == 0 {
                postDarwinNotification(ipcWakeDarwinNotificationName)
                Thread.sleep(forTimeInterval: 0.12)
            }
        }
        return nil
    }

    private func refreshConfigViaLoopback(completion: (() -> Void)? = nil) {
        loadConfigFromChannelA()
        ipcQueue.async { [weak self] in
            defer { completion?() }
            guard let self = self,
                  let resp = self.performLoopbackRequestAcrossPorts(method: "GET", path: "/config", body: nil),
                  resp.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: resp.data) as? [String: Any] else {
                return
            }
            let hostToken = json["hostSessionToken"] as? String
            self.probeAppGroupAndHandshake(expectedHostToken: hostToken)
            self.visionQueue.async {
                self.applyConfigDictionary(json)
            }
        }
    }

    private func sendLoopbackSubtitleRequest(_ payloadData: Data, retriesLeft: Int) {
        ipcQueue.async { [weak self] in
            guard let self = self else { return }
            if let resp = self.performLoopbackRequestAcrossPorts(method: "POST", path: "/subtitle", body: payloadData),
               resp.statusCode == 200 {
                return
            }
            if retriesLeft > 0 {
                self.ipcQueue.asyncAfter(deadline: .now() + 0.25) {
                    self.sendLoopbackSubtitleRequest(payloadData, retriesLeft: retriesLeft - 1)
                }
            }
        }
    }

    private func pushSubtitleToMainApp(
        _ subtitle: String,
        ocrSourceText: String? = nil,
        isTranslated: Bool = true,
        broadcastActive: Bool = true,
        retryOnFailure: Bool = false
    ) {
        let clean = subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanSrc = (ocrSourceText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty || !cleanSrc.isEmpty else { return }
        if !clean.isEmpty {
            lastPushedSubtitle = clean
        }
        if !cleanSrc.isEmpty {
            LzhSharedEcosystemStore.saveLatestSubtitle(source: cleanSrc, translated: isTranslated ? clean : "")
        }

        stateLock.lock()
        let modeNow = detectedIpcMode
        let agWritableNow = appGroupWritable
        let agVerifiedNow = appGroupHandshakeVerified
        stateLock.unlock()

        // Channel A: App Group UserDefaults + shared container file + Darwin notification (when available)
        if agWritableNow {
            let defaults = sharedDefaults
            if isTranslated && !clean.isEmpty {
                defaults.set(clean, forKey: "lzh_latest_pip_subtitle")
            }
            if !cleanSrc.isEmpty {
                ocrSequence += 1
                defaults.set(cleanSrc, forKey: "lzh_latest_ocr_text")
                defaults.set(ocrSequence, forKey: "lzh_latest_ocr_seq")
            }
            defaults.set(broadcastActive, forKey: "lzh_broadcast_active")
            defaults.synchronize()

            var bridgeUpdates: [String: Any] = [
                "broadcastActive": broadcastActive,
                "subtitleUpdatedAt": Date().timeIntervalSince1970,
                "needsHostTranslation": !isTranslated && !cleanSrc.isEmpty
            ]
            if isTranslated && !clean.isEmpty {
                bridgeUpdates["subtitle"] = clean
            }
            if !cleanSrc.isEmpty {
                bridgeUpdates["ocrText"] = cleanSrc
                bridgeUpdates["ocrSeq"] = ocrSequence
            }
            writeSharedBridgeState(merging: bridgeUpdates)
            postDarwinNotification(darwinNotificationName)
        } else if !cleanSrc.isEmpty {
            ocrSequence += 1
        }

        // Channel B: Local POSIX TCP Loopback (works automatically when sideload strips App Group, and mirrors in App Store mode)
        let payload: [String: Any] = [
            "text": isTranslated ? clean : "",
            "sourceText": cleanSrc,
            "translated": isTranslated && !clean.isEmpty,
            "broadcastActive": broadcastActive,
            "ipcMode": modeNow,
            "appGroupWritable": agWritableNow,
            "appGroupVerified": agVerifiedNow,
            "ts": Date().timeIntervalSince1970
        ]
        if let bodyData = try? JSONSerialization.data(withJSONObject: payload, options: []) {
            sendLoopbackSubtitleRequest(bodyData, retriesLeft: (retryOnFailure || ocrSequence <= 3) ? 3 : 1)
        }
    }

    // MARK: - RPBroadcastSampleHandler Lifecycle

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        signal(SIGPIPE, SIG_IGN)
        lastRecognizedText = ""
        lastPushedSubtitle = ""
        lastSignature = []
        lastFrameAt = 0
        lastOcrCompletedAt = 0
        isProcessingFrame = false

        probeAppGroupAndHandshake()
        postDarwinNotification(localBroadcastStartedDarwinName)

        sharedDefaults.set(true, forKey: "lzh_broadcast_active")
        sharedDefaults.synchronize()
        writeSharedBridgeState(merging: ["broadcastActive": true])

        refreshConfigViaLoopback { [weak self] in
            guard let self = self else { return }
            self.stateLock.lock()
            let modeLabel = self.detectedIpcMode == "app_group" ? "App Group" : "本機模式"
            self.stateLock.unlock()
            self.pushSubtitleToMainApp(
                "LZHCard 廣播已連線（\(modeLabel)），正在偵測畫面字幕...",
                ocrSourceText: nil,
                isTranslated: true,
                broadcastActive: true,
                retryOnFailure: true
            )
        }
    }

    override func broadcastPaused() {
        pushSubtitleToMainApp("螢幕翻譯已暫停", ocrSourceText: nil, isTranslated: true, broadcastActive: true)
    }

    override func broadcastResumed() {
        refreshConfigViaLoopback()
        pushSubtitleToMainApp("螢幕翻譯已恢復，持續偵測字幕...", ocrSourceText: nil, isTranslated: true, broadcastActive: true, retryOnFailure: true)
    }

    override func broadcastFinished() {
        postDarwinNotification(localBroadcastFinishedDarwinName)
        sharedDefaults.set(false, forKey: "lzh_broadcast_active")
        sharedDefaults.synchronize()
        writeSharedBridgeState(merging: ["broadcastActive": false])
        pushSubtitleToMainApp("螢幕翻譯廣播已結束", ocrSourceText: nil, isTranslated: true, broadcastActive: false, retryOnFailure: true)
    }

    // MARK: - Video Frame Processing (0.9s Throttle + Crop-Zone Luma Diff + 1.6s Periodic Rescan)

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video else { return }

        let now = Date().timeIntervalSince1970
        stateLock.lock()
        let busy = isProcessingFrame
        let prevFrame = lastFrameAt
        let prevOcrDone = lastOcrCompletedAt
        if busy && (now - prevFrame) >= 6.0 {
            isProcessingFrame = false
        } else if busy || (now - prevFrame) < 0.90 {
            stateLock.unlock()
            return
        }
        stateLock.unlock()

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        if (now - lastConfigRefreshAt) > 2.0 {
            lastConfigRefreshAt = now
            refreshConfigViaLoopback()
        }
        let activeConfig = getConfigSnapshot()

        let paused = activeConfig.isPaused || LzhSharedEcosystemStore.isSubtitlePaused()
        if paused {
            if !wasSubtitlePaused {
                wasSubtitlePaused = true
                lastSignature = []
                pushSubtitleToMainApp("⏸ 字幕翻譯已暫停（點擊動態島可繼續）", ocrSourceText: nil, isTranslated: true, broadcastActive: true)
            }
            return
        } else if wasSubtitlePaused {
            wasSubtitlePaused = false
            lastSignature = []
            pushSubtitleToMainApp("螢幕翻譯已恢復，持續偵測字幕...", ocrSourceText: nil, isTranslated: true, broadcastActive: true)
        }

        let orientation = extractSampleOrientation(from: sampleBuffer)
        let rawW = CVPixelBufferGetWidth(pixelBuffer)
        let rawH = CVPixelBufferGetHeight(pixelBuffer)
        let swapsAxes = (orientation == .left || orientation == .leftMirrored || orientation == .right || orientation == .rightMirrored)
        let orientedW = swapsAxes ? rawH : rawW
        let orientedH = swapsAxes ? rawW : rawH
        let isPortraitFrame = orientedH >= orientedW

        let cropNorm: CGRect
        if isPortraitFrame {
            if activeConfig.portraitRegionMode == "custom", activeConfig.portraitRegionW > 0.05, activeConfig.portraitRegionH > 0.05 {
                let safeX = max(0.0, min(0.92, activeConfig.portraitRegionX))
                let safeY = max(0.0, min(0.92, activeConfig.portraitRegionY))
                let safeW = max(0.08, min(1.0 - safeX, activeConfig.portraitRegionW))
                let safeH = max(0.08, min(1.0 - safeY, activeConfig.portraitRegionH))
                cropNorm = CGRect(x: safeX, y: safeY, width: safeW, height: safeH)
            } else {
                cropNorm = CGRect(x: 0.08, y: 0.70, width: 0.84, height: 0.22)
            }
        } else {
            if activeConfig.landscapeRegionMode == "custom", activeConfig.landscapeRegionW > 0.05, activeConfig.landscapeRegionH > 0.05 {
                let safeX = max(0.0, min(0.92, activeConfig.landscapeRegionX))
                let safeY = max(0.0, min(0.92, activeConfig.landscapeRegionY))
                let safeW = max(0.08, min(1.0 - safeX, activeConfig.landscapeRegionW))
                let safeH = max(0.08, min(1.0 - safeY, activeConfig.landscapeRegionH))
                cropNorm = CGRect(x: safeX, y: safeY, width: safeW, height: safeH)
            } else {
                cropNorm = CGRect(x: 0.12, y: 0.74, width: 0.76, height: 0.20)
            }
        }

        let signature = computeQuickLumaSignature(pixelBuffer: pixelBuffer, cropNorm: cropNorm)
        let shouldForceRescan = (now - prevOcrDone) >= 1.6
        if !shouldForceRescan && !lastSignature.isEmpty && !hasSignificantVisualChange(prev: lastSignature, curr: signature) {
            stateLock.lock()
            lastFrameAt = now
            stateLock.unlock()
            return
        }

        stateLock.lock()
        isProcessingFrame = true
        lastFrameAt = now
        stateLock.unlock()
        lastSignature = signature

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
            var cropped = ciImage.cropped(to: ciRect)
            if cropped.extent.width > 960.0 {
                let scale = 960.0 / cropped.extent.width
                cropped = cropped.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            }
            croppedCgImage = ciContext.createCGImage(cropped, from: cropped.extent)
        }

        guard let cgImage = croppedCgImage else {
            stateLock.lock()
            isProcessingFrame = false
            stateLock.unlock()
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

            let ocrDoneNow = Date().timeIntervalSince1970
            self.stateLock.lock()
            self.lastOcrCompletedAt = ocrDoneNow
            self.stateLock.unlock()

            if recognizedText.isEmpty || recognizedText == self.lastRecognizedText {
                self.stateLock.lock()
                self.isProcessingFrame = false
                self.stateLock.unlock()
                return
            }
            self.translateTextInExtension(recognizedText, config: activeConfig) { translated in
                defer {
                    self.stateLock.lock()
                    self.isProcessingFrame = false
                    self.stateLock.unlock()
                }
                self.lastRecognizedText = recognizedText
                let cleanTranslated = (translated ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !cleanTranslated.isEmpty {
                    self.pushSubtitleToMainApp(cleanTranslated, ocrSourceText: recognizedText, isTranslated: true, broadcastActive: true, retryOnFailure: self.ocrSequence <= 3)
                } else {
                    // Fallback relay via Channel A + Loopback so host app translates using Apple Translation / Cloud
                    self.pushSubtitleToMainApp("", ocrSourceText: recognizedText, isTranslated: false, broadcastActive: true, retryOnFailure: self.ocrSequence <= 3)
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
        if config.engine == "apple_offline" {
            if #available(iOS 26.0, *) {
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
        let workerBase = config.workerBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !workerBase.isEmpty, let url = URL(string: "\(workerBase)/ai/fast-refine") else {
            translateViaFreeTier1(sourceText, sourceLang: config.sourceLang, completion: completion)
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
        cloudSession.dataTask(with: req) { [weak self] data, _, _ in
            var translated = ""
            if let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let tr = json["translation"] as? String {
                translated = tr.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if !translated.isEmpty {
                completion(translated)
            } else {
                self?.translateViaFreeTier1(sourceText, sourceLang: config.sourceLang, completion: completion)
            }
        }.resume()
    }

    private func translateViaFreeTier1(_ sourceText: String, sourceLang: String, completion: @escaping (String?) -> Void) {
        let sl = sourceLang.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "auto" : sourceLang
        var comps = URLComponents(string: "https://translate.googleapis.com/translate_a/single")
        comps?.queryItems = [
            URLQueryItem(name: "client", value: "gtx"),
            URLQueryItem(name: "sl", value: sl),
            URLQueryItem(name: "tl", value: "zh-TW"),
            URLQueryItem(name: "dt", value: "t"),
            URLQueryItem(name: "q", value: sourceText)
        ]
        guard let url = comps?.url else {
            completion(nil)
            return
        }
        cloudSession.dataTask(with: url) { data, _, _ in
            var translated = ""
            if let data = data,
               let arr = try? JSONSerialization.jsonObject(with: data) as? [Any],
               let segments = arr.first as? [Any] {
                var joined = ""
                for seg in segments {
                    if let parts = seg as? [Any], let chunk = parts.first as? String {
                        joined += chunk
                    }
                }
                translated = joined.trimmingCharacters(in: .whitespacesAndNewlines)
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
                    return core == "a" || core == "A" || core == "I" || Int(core) != nil
                }
                return core.range(of: "[A-Za-z0-9]", options: .regularExpression) != nil
            }
            text = kept.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        }

        let compactCount = text.filter { !$0.isWhitespace }.count
        let meaningfulScalars = text.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.count
        if meaningfulScalars < 2 { return "" }
        if Double(meaningfulScalars) / Double(max(1, compactCount)) < 0.35 { return "" }
        return text
    }

    private func computeQuickLumaSignature(pixelBuffer: CVPixelBuffer, cropNorm: CGRect) -> [UInt8] {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        var sig: [UInt8] = []
        sig.reserveCapacity(64)

        if CVPixelBufferIsPlanar(pixelBuffer), CVPixelBufferGetPlaneCount(pixelBuffer) > 0,
           let yBase = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) {
            let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
            let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
            let bytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
            let ptr = yBase.assumingMemoryBound(to: UInt8.self)

            let startX = max(0, min(width - 1, Int(Double(width) * cropNorm.origin.x)))
            let spanW = max(1, min(width - startX, Int(Double(width) * cropNorm.width)))
            let startY = max(0, min(height - 1, Int(Double(height) * cropNorm.origin.y)))
            let spanH = max(1, min(height - startY, Int(Double(height) * cropNorm.height)))

            for gy in 0..<8 {
                let py = min(height - 1, startY + (gy * spanH) / 8)
                for gx in 0..<8 {
                    let px = min(width - 1, startX + (gx * spanW) / 8)
                    let offset = py * bytesPerRow + px
                    if offset < bytesPerRow * height {
                        sig.append(ptr[offset])
                    }
                }
            }
            return sig
        }

        guard let baseAddr = CVPixelBufferGetBaseAddress(pixelBuffer) else { return [] }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let ptr = baseAddr.assumingMemoryBound(to: UInt8.self)

        let startX = max(0, min(width - 1, Int(Double(width) * cropNorm.origin.x)))
        let spanW = max(1, min(width - startX, Int(Double(width) * cropNorm.width)))
        let startY = max(0, min(height - 1, Int(Double(height) * cropNorm.origin.y)))
        let spanH = max(1, min(height - startY, Int(Double(height) * cropNorm.height)))

        for gy in 0..<8 {
            let py = min(height - 1, startY + (gy * spanH) / 8)
            for gx in 0..<8 {
                let px = min(width - 1, startX + (gx * spanW) / 8)
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
            if abs(Int(prev[i]) - Int(curr[i])) > 14 {
                diffCount += 1
            }
        }
        return Double(diffCount) / Double(curr.count) >= 0.04
    }
}
