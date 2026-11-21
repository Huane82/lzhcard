import Foundation
import Capacitor
import UIKit
import AVKit
import AVFoundation
import ReplayKit
import CoreMedia
import CoreVideo
import Network
import SwiftUI
#if canImport(Translation)
import Translation
#endif

@objc(IosScreenTranslatePlugin)
public class IosScreenTranslatePlugin: CAPPlugin, CAPBridgedPlugin, AVPictureInPictureControllerDelegate, AVPictureInPictureSampleBufferPlaybackDelegate {

    public let identifier = "IosScreenTranslatePlugin"
    public let jsName = "IosScreenTranslate"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareOfflineLanguages", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveConfig", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startScreenTranslate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showBroadcastPicker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startPipSubtitle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopPipSubtitle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updatePipText", returnType: CAPPluginReturnPromise)
    ]

    private let loopbackHost = "127.0.0.1"
    private let loopbackPort: UInt16 = 49152
    private let darwinNotificationName = "com.lzhcard.app.pip.subtitle.updated" as CFString
    private let pipWidthPx = 680
    private let pipHeightPx = 192
    private let defaultInitialText = "LZHCard 預覽浮窗（可拖曳移動），點選開始廣播後切換畫面"

    private lazy var resolvedAppGroupId: String? = resolveAccessibleAppGroupId()
    private lazy var sharedContainerBridgeFileUrl: URL? = resolveSharedBridgeFileUrl()

    private var pipController: AVPictureInPictureController?
    private var sampleLayer: AVSampleBufferDisplayLayer?
    private var pipHostView: UIView?
    private var pipPreviewBorderLayer: CAShapeLayer?
    private var pipHostCloseButton: UIButton?
    private var pipHostCustomOrigin: CGPoint?
    private var pipPanStartOrigin: CGPoint = .zero
    private var pipPossibleObservation: NSKeyValueObservation?
    private var pipPollFallbackTimer: Timer?
    private var pipHeartbeatTimer: Timer?
    private var pipStartDeadlineAt: Date?
    private var isAwaitingPipStart = false
    private var shouldTriggerPickerAfterPip = false
    private var hasTriggeredBroadcastPicker = false
    private var pickerFallbackTimer: DispatchWorkItem?
    private var audioInterruptionObserver: NSObjectProtocol?

    private var silentAudioPlayer: AVAudioPlayer?
    private var pollTimer: Timer?
    private var lastHandledOcrSeq: Int = -1
    private var lastHandledBridgeSeq: Int = -1
    private var lastRenderedSubtitle: String = ""
    private var isTranslatingOcr: Bool = false

    private let ipcQueue = DispatchQueue(label: "com.lzhcard.app.loopback.ipc", qos: .userInitiated)
    private var loopbackListener: NWListener?
    private var darwinObserverRegistered = false

    private var runtimeConfig: [String: Any] = [
        "engine": "apple_offline",
        "provider": "apple_offline",
        "model": "apple_translation",
        "sourceLang": "en",
        "targetLang": "zh-Hant",
        "apiKey": "",
        "workerBaseUrl": "https://lzhcard.tomlin980415.workers.dev",
        "authToken": "",
        "regionMode": "auto",
        "region": [
            "x": 0.05,
            "y": 0.50,
            "width": 0.90,
            "height": 0.42
        ],
        "cropRect": [
            "x": 0.05,
            "y": 0.50,
            "width": 0.90,
            "height": 0.42
        ]
    ]

    deinit {
        cancelPendingPipStartObservers()
        pickerFallbackTimer?.cancel()
        pickerFallbackTimer = nil
        pollTimer?.invalidate()
        pollTimer = nil
        pipHeartbeatTimer?.invalidate()
        pipHeartbeatTimer = nil
        if let obs = audioInterruptionObserver {
            NotificationCenter.default.removeObserver(obs)
            audioInterruptionObserver = nil
        }
        unregisterDarwinObserver()
        stopLoopbackServer()
    }

    private func resolveAccessibleAppGroupId() -> String? {
        let mainBundleId = (Bundle.main.bundleIdentifier ?? "com.lzhcard.app").trimmingCharacters(in: .whitespacesAndNewlines)
        var candidates: [String] = []

        if let infoGroup = Bundle.main.object(forInfoDictionaryKey: "LZHAppGroupIdentifier") as? String {
            let trimmed = infoGroup.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                candidates.append(trimmed)
            }
        }
        if !mainBundleId.isEmpty {
            candidates.append("group.\(mainBundleId)")
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

    private var sharedDefaults: UserDefaults {
        if let gid = resolvedAppGroupId, let suite = UserDefaults(suiteName: gid) {
            return suite
        }
        return UserDefaults.standard
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

    private func registerDarwinObserverIfNeeded() {
        guard !darwinObserverRegistered else { return }
        darwinObserverRegistered = true
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(
            center,
            observer,
            { _, observerPtr, _, _, _ in
                guard let observerPtr = observerPtr else { return }
                let plugin = Unmanaged<IosScreenTranslatePlugin>.fromOpaque(observerPtr).takeUnretainedValue()
                DispatchQueue.main.async {
                    plugin.checkSharedSubtitleUpdates()
                }
            },
            darwinNotificationName,
            nil,
            .deliverImmediately
        )
    }

    private func unregisterDarwinObserver() {
        guard darwinObserverRegistered else { return }
        darwinObserverRegistered = false
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterRemoveObserver(center, observer, CFNotificationName(darwinNotificationName), nil)
    }

    private func broadcastExtensionBundleIdFallback() -> String {
        "\(Bundle.main.bundleIdentifier ?? "com.lzhcard.app").BroadcastUpload"
    }

    // MARK: - Channel B: Local 127.0.0.1:49152 Loopback HTTP Server

    private func startLoopbackServerIfNeeded() {
        ipcQueue.async { [weak self] in
            guard let self = self else { return }
            if let existing = self.loopbackListener {
                switch existing.state {
                case .ready, .setup, .waiting:
                    return
                case .failed, .cancelled:
                    existing.cancel()
                    self.loopbackListener = nil
                @unknown default:
                    return
                }
            }

            guard let port = NWEndpoint.Port(rawValue: self.loopbackPort) else { return }
            let params = NWParameters.tcp
            if let ipOpts = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
                ipOpts.version = .v4
            }
            params.allowLocalEndpointReuse = true
            params.requiredLocalEndpoint = NWEndpoint.hostPort(
                host: NWEndpoint.Host.ipv4(.loopback),
                port: port
            )

            do {
                let listener = try NWListener(using: params)
                listener.stateUpdateHandler = { [weak self] state in
                    if case .failed = state {
                        self?.ipcQueue.async {
                            if self?.loopbackListener === listener {
                                listener.cancel()
                                self?.loopbackListener = nil
                            }
                        }
                    } else if case .cancelled = state {
                        self?.ipcQueue.async {
                            if self?.loopbackListener === listener {
                                self?.loopbackListener = nil
                            }
                        }
                    }
                }
                listener.newConnectionHandler = { [weak self] conn in
                    self?.handleLoopbackConnection(conn)
                }
                self.loopbackListener = listener
                listener.start(queue: self.ipcQueue)
            } catch {
                self.loopbackListener = nil
            }
        }
    }

    private func stopLoopbackServer() {
        ipcQueue.async { [weak self] in
            self?.loopbackListener?.cancel()
            self?.loopbackListener = nil
        }
    }

    private func handleLoopbackConnection(_ conn: NWConnection) {
        conn.stateUpdateHandler = { state in
            switch state {
            case .failed, .cancelled:
                conn.cancel()
            default:
                break
            }
        }
        conn.start(queue: ipcQueue)
        receiveLoopbackHttpRequest(on: conn, accumulated: Data())
    }

    private func receiveLoopbackHttpRequest(on conn: NWConnection, accumulated: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self else {
                conn.cancel()
                return
            }
            var buffer = accumulated
            if let data = data, !data.isEmpty {
                buffer.append(data)
            }

            if let parsed = self.tryParseHttpRequest(buffer) {
                self.routeLoopbackRequest(method: parsed.method, path: parsed.path, body: parsed.body, on: conn)
                return
            }

            if isComplete || error != nil || buffer.count > 262144 {
                self.sendHttpResponse(on: conn, statusCode: 400, jsonBody: ["ok": false, "error": "invalid_request"])
                return
            }

            self.receiveLoopbackHttpRequest(on: conn, accumulated: buffer)
        }
    }

    private func tryParseHttpRequest(_ data: Data) -> (method: String, path: String, body: Data)? {
        guard let separatorRange = data.range(of: Data("\r\n\r\n".utf8)) else {
            return nil
        }
        let headerData = data.subdata(in: 0..<separatorRange.lowerBound)
        guard let headerStr = String(data: headerData, encoding: .utf8) else {
            return nil
        }
        let lines = headerStr.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else {
            return nil
        }
        let parts = requestLine.split(separator: " ", omittingEmptySubsequences: true)
        guard parts.count >= 2 else {
            return nil
        }
        let method = String(parts[0]).uppercased()
        let rawTarget = String(parts[1])
        let path = rawTarget.split(separator: "?", maxSplits: 1).first.map(String.init) ?? rawTarget

        var contentLength = 0
        for line in lines.dropFirst() {
            let kv = line.split(separator: ":", maxSplits: 1)
            if kv.count == 2, kv[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" {
                contentLength = Int(kv[1].trimmingCharacters(in: .whitespaces)) ?? 0
            }
        }

        let bodyStart = separatorRange.upperBound
        let availableBody = data.count - bodyStart
        if availableBody < contentLength {
            return nil
        }
        let bodyEnd = min(data.count, bodyStart + max(0, contentLength))
        let bodyData = contentLength > 0 ? data.subdata(in: bodyStart..<bodyEnd) : Data()
        return (method, path, bodyData)
    }

    private func routeLoopbackRequest(method: String, path: String, body: Data, on conn: NWConnection) {
        if method == "GET" && path == "/config" {
            let cfgSnapshot = currentConfigDictionary()
            sendHttpResponse(on: conn, statusCode: 200, jsonBody: cfgSnapshot)
            return
        }

        if method == "POST" && path == "/subtitle" {
            var incomingText = ""
            if let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                incomingText = String((json["text"] as? String) ?? (json["subtitle"] as? String) ?? "")
            } else if let rawText = String(data: body, encoding: .utf8) {
                incomingText = rawText
            }
            let clean = incomingText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !clean.isEmpty {
                DispatchQueue.main.async { [weak self] in
                    guard let self = self else { return }
                    self.sharedDefaults.set(clean, forKey: "lzh_latest_pip_subtitle")
                    self.sharedDefaults.synchronize()
                    self.writeSharedBridgeState(merging: [
                        "subtitle": clean,
                        "subtitleUpdatedAt": Date().timeIntervalSince1970
                    ])
                    self.renderSubtitleTextToPip(clean)
                }
            }
            sendHttpResponse(on: conn, statusCode: 200, jsonBody: ["ok": true])
            return
        }

        if method == "GET" && path == "/health" {
            sendHttpResponse(on: conn, statusCode: 200, jsonBody: [
                "ok": true,
                "appGroup": resolvedAppGroupId ?? ""
            ])
            return
        }

        sendHttpResponse(on: conn, statusCode: 404, jsonBody: ["ok": false, "error": "not_found"])
    }

    private func sendHttpResponse(on conn: NWConnection, statusCode: Int, jsonBody: [String: Any]) {
        let statusText = statusCode == 200 ? "OK" : (statusCode == 404 ? "Not Found" : "Bad Request")
        let bodyData = (try? JSONSerialization.data(withJSONObject: jsonBody, options: [])) ?? Data("{}".utf8)
        let header = "HTTP/1.1 \(statusCode) \(statusText)\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(bodyData.count)\r\nConnection: close\r\n\r\n"
        var responseData = Data(header.utf8)
        responseData.append(bodyData)

        conn.send(content: responseData, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    private func currentConfigDictionary() -> [String: Any] {
        var cfg = runtimeConfig
        let defaults = sharedDefaults
        if let eng = defaults.string(forKey: "lzh_translate_engine"), !eng.isEmpty {
            cfg["engine"] = eng
        }
        if let prov = defaults.string(forKey: "lzh_translate_provider"), !prov.isEmpty {
            cfg["provider"] = prov
        }
        if let mdl = defaults.string(forKey: "lzh_translate_model"), !mdl.isEmpty {
            cfg["model"] = mdl
        }
        if let src = defaults.string(forKey: "lzh_source_lang"), !src.isEmpty {
            cfg["sourceLang"] = src
        }
        if let dst = defaults.string(forKey: "lzh_target_lang"), !dst.isEmpty {
            cfg["targetLang"] = dst
        }
        if let key = defaults.string(forKey: "lzh_custom_api_key") {
            cfg["apiKey"] = key
        }
        if let worker = defaults.string(forKey: "lzh_worker_base_url"), !worker.isEmpty {
            cfg["workerBaseUrl"] = worker
        }
        if let tok = defaults.string(forKey: "lzh_auth_token") {
            cfg["authToken"] = tok
        }
        if let regMode = defaults.string(forKey: "lzh_region_mode"), !regMode.isEmpty {
            cfg["regionMode"] = regMode
        }
        let rw = defaults.double(forKey: "lzh_region_w")
        let rh = defaults.double(forKey: "lzh_region_h")
        if rw > 0.05 && rh > 0.05 {
            let reg: [String: Double] = [
                "x": defaults.double(forKey: "lzh_region_x"),
                "y": defaults.double(forKey: "lzh_region_y"),
                "width": rw,
                "height": rh
            ]
            cfg["region"] = reg
            cfg["cropRect"] = reg
        }
        return cfg
    }

    // MARK: - Capacitor Plugin Methods

    @objc func getCapabilities(_ call: CAPPluginCall) {
        let ver = ProcessInfo.processInfo.operatingSystemVersion
        let supportsOfflineSheet = ver.majorVersion >= 26
        let supportsTranslationSession = ver.majorVersion >= 26
        let pipSupported = AVPictureInPictureController.isPictureInPictureSupported()

        call.resolve([
            "supported": true,
            "iosMajor": ver.majorVersion,
            "iosMinor": ver.minorVersion,
            "supportsOfflineTranslation": supportsOfflineSheet,
            "supportsTranslationSession": supportsTranslationSession,
            "pipSupported": pipSupported,
            "appGroupId": resolvedAppGroupId ?? "",
            "loopbackPort": Int(loopbackPort)
        ])
    }

    @objc func prepareOfflineLanguages(_ call: CAPPluginCall) {
        let sourceLang = call.getString("sourceLang") ?? "en"
        let targetLang = call.getString("targetLang") ?? "zh-Hant"

        guard #available(iOS 26.0, *) else {
            call.resolve([
                "supported": false,
                "fallbackSuggested": true,
                "reason": "目前系統版本將自動使用雲端高速翻譯通道；iOS 26 以上提供 Apple 原生離線語言包。"
            ])
            return
        }

        #if canImport(Translation)
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let presenter = self.bridge?.viewController else {
                call.reject("Unable to access root viewController")
                return
            }

            var finished = false
            let finishOnce: ([String: Any]) -> Void = { payload in
                guard !finished else { return }
                finished = true
                call.resolve(payload)
            }

            let helperView = AppleTranslationDownloadHelperView(
                sourceLang: sourceLang,
                targetLang: targetLang,
                onComplete: { ok, message in
                    presenter.dismiss(animated: true) {
                        finishOnce([
                            "supported": true,
                            "ready": ok,
                            "message": message
                        ])
                    }
                }
            )
            let hc = UIHostingController(rootView: helperView)
            hc.modalPresentationStyle = .overCurrentContext
            hc.view.backgroundColor = UIColor.black.withAlphaComponent(0.32)
            presenter.present(hc, animated: true)
        }
        #else
        call.resolve([
            "supported": false,
            "fallbackSuggested": true,
            "reason": "Translation framework unavailable in current Xcode SDK."
        ])
        #endif
    }

    @objc func saveConfig(_ call: CAPPluginCall) {
        let engine = call.getString("engine") ?? "apple_offline"
        let provider = call.getString("provider") ?? (engine == "apple_offline" ? "apple_offline" : "worker")
        let model = call.getString("model") ?? (engine == "apple_offline" ? "apple_translation" : "gemini-2.0-flash")
        let sourceLang = call.getString("sourceLang") ?? "en"
        let targetLang = call.getString("targetLang") ?? "zh-Hant"
        let apiKey = call.getString("apiKey") ?? ""
        let workerBaseUrl = call.getString("workerBaseUrl") ?? "https://lzhcard.tomlin980415.workers.dev"
        let authToken = call.getString("authToken") ?? ""
        let regionMode = call.getString("regionMode") ?? "auto"

        let defaults = sharedDefaults
        defaults.set(engine, forKey: "lzh_translate_engine")
        defaults.set(provider, forKey: "lzh_translate_provider")
        defaults.set(model, forKey: "lzh_translate_model")
        defaults.set(sourceLang, forKey: "lzh_source_lang")
        defaults.set(targetLang, forKey: "lzh_target_lang")
        defaults.set(apiKey, forKey: "lzh_custom_api_key")
        defaults.set(workerBaseUrl, forKey: "lzh_worker_base_url")
        defaults.set(authToken, forKey: "lzh_auth_token")
        defaults.set(regionMode, forKey: "lzh_region_mode")

        var regDict: [String: Double] = [
            "x": defaults.double(forKey: "lzh_region_x"),
            "y": defaults.double(forKey: "lzh_region_y"),
            "width": defaults.double(forKey: "lzh_region_w"),
            "height": defaults.double(forKey: "lzh_region_h")
        ]
        let rectSource = call.getObject("cropRect") ?? call.getObject("region")
        if let region = rectSource {
            let rx = (region["x"] as? NSNumber)?.doubleValue ?? (region["x"] as? Double) ?? 0.05
            let ry = (region["y"] as? NSNumber)?.doubleValue ?? (region["y"] as? Double) ?? 0.50
            let rw = (region["width"] as? NSNumber)?.doubleValue ?? (region["width"] as? Double) ?? 0.90
            let rh = (region["height"] as? NSNumber)?.doubleValue ?? (region["height"] as? Double) ?? 0.42
            defaults.set(rx, forKey: "lzh_region_x")
            defaults.set(ry, forKey: "lzh_region_y")
            defaults.set(rw, forKey: "lzh_region_w")
            defaults.set(rh, forKey: "lzh_region_h")
            regDict = ["x": rx, "y": ry, "width": rw, "height": rh]
        }
        defaults.synchronize()

        let updatedCfg: [String: Any] = [
            "engine": engine,
            "provider": provider,
            "model": model,
            "sourceLang": sourceLang,
            "targetLang": targetLang,
            "apiKey": apiKey,
            "workerBaseUrl": workerBaseUrl,
            "authToken": authToken,
            "regionMode": regionMode,
            "region": regDict,
            "cropRect": regDict
        ]
        ipcQueue.async { [weak self] in
            self?.runtimeConfig = updatedCfg
        }
        writeSharedBridgeState(merging: [
            "config": updatedCfg,
            "configUpdatedAt": Date().timeIntervalSince1970
        ])

        call.resolve(["saved": true])
    }

    private func resolveBroadcastExtensionBundleId() -> String {
        let fallbackId = broadcastExtensionBundleIdFallback()
        guard let plugInsUrl = Bundle.main.builtInPlugInsURL else {
            return fallbackId
        }
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(at: plugInsUrl, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else {
            return fallbackId
        }
        for url in items where url.pathExtension.lowercased() == "appex" {
            let plistUrl = url.appendingPathComponent("Info.plist")
            let info = Bundle(url: url)?.infoDictionary ?? (NSDictionary(contentsOf: plistUrl) as? [String: Any])
            if let nsExt = info?["NSExtension"] as? [String: Any],
               let pointId = nsExt["NSExtensionPointIdentifier"] as? String,
               pointId == "com.apple.broadcast-services-upload",
               let bundleId = info?["CFBundleIdentifier"] as? String,
               !bundleId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return bundleId.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return fallbackId
    }

    private func findButton(in view: UIView) -> UIButton? {
        if let button = view as? UIButton {
            return button
        }
        for subview in view.subviews {
            if let found = findButton(in: subview) {
                return found
            }
        }
        return nil
    }

    @discardableResult
    private func triggerSystemBroadcastPicker(in rootView: UIView) -> Bool {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        picker.preferredExtension = resolveBroadcastExtensionBundleId()
        picker.showsMicrophoneButton = false
        picker.alpha = 0.01
        rootView.addSubview(picker)
        picker.layoutIfNeeded()

        var triggered = false
        if let button = findButton(in: picker) {
            button.sendActions(for: .touchUpInside)
            triggered = true
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            picker.removeFromSuperview()
        }
        return triggered
    }

    private func triggerPickerIfPending() {
        pickerFallbackTimer?.cancel()
        pickerFallbackTimer = nil
        guard shouldTriggerPickerAfterPip, !hasTriggeredBroadcastPicker else { return }
        hasTriggeredBroadcastPicker = true
        shouldTriggerPickerAfterPip = false
        guard let rootView = bridge?.viewController?.view else { return }
        triggerSystemBroadcastPicker(in: rootView)
    }

    @objc func startScreenTranslate(_ call: CAPPluginCall) {
        let initialText = (call.getString("initialText") ?? defaultInitialText).trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveInitial = initialText.isEmpty ? defaultInitialText : initialText

        DispatchQueue.main.async { [weak self] in
            guard let self = self, let rootView = self.bridge?.viewController?.view else {
                call.reject("Root view unavailable")
                return
            }

            self.startLoopbackServerIfNeeded()
            self.registerDarwinObserverIfNeeded()
            self.shouldTriggerPickerAfterPip = true
            self.hasTriggeredBroadcastPicker = false

            var pipStarted = false
            if AVPictureInPictureController.isPictureInPictureSupported() {
                self.setupAudioSessionAndKeepAlive()
                self.setupPipControllerIfNeeded(initialText: effectiveInitial)
                self.sharedDefaults.set(effectiveInitial, forKey: "lzh_latest_pip_subtitle")
                self.sharedDefaults.synchronize()
                self.writeSharedBridgeState(merging: [
                    "subtitle": effectiveInitial,
                    "subtitleUpdatedAt": Date().timeIntervalSince1970
                ])
                self.renderSubtitleTextToPip(effectiveInitial)
                self.startPollingSharedSubtitle()
                self.requestStartPictureInPictureWhenPossible()
                pipStarted = true

                // Allow sufficient time for AVPictureInPictureController to detach cleanly before system Broadcast picker appears
                self.pickerFallbackTimer?.cancel()
                let work = DispatchWorkItem { [weak self] in
                    self?.triggerPickerIfPending()
                }
                self.pickerFallbackTimer = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.15, execute: work)
            } else {
                self.hasTriggeredBroadcastPicker = true
                self.shouldTriggerPickerAfterPip = false
                self.triggerSystemBroadcastPicker(in: rootView)
            }

            call.resolve([
                "started": pipStarted,
                "triggered": true,
                "pipSupported": AVPictureInPictureController.isPictureInPictureSupported()
            ])
        }
    }

    @objc func showBroadcastPicker(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let rootView = self.bridge?.viewController?.view else {
                call.reject("Root view unavailable")
                return
            }

            self.startLoopbackServerIfNeeded()
            let triggered = self.triggerSystemBroadcastPicker(in: rootView)
            call.resolve(["triggered": triggered])
        }
    }

    @objc func startPipSubtitle(_ call: CAPPluginCall) {
        let initialText = (call.getString("initialText") ?? defaultInitialText).trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveInitial = initialText.isEmpty ? defaultInitialText : initialText

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard AVPictureInPictureController.isPictureInPictureSupported() else {
                call.reject("此裝置不支援子母畫面 (PiP)", "PIP_UNSUPPORTED")
                return
            }

            self.startLoopbackServerIfNeeded()
            self.registerDarwinObserverIfNeeded()
            self.shouldTriggerPickerAfterPip = false
            self.setupAudioSessionAndKeepAlive()
            self.setupPipControllerIfNeeded(initialText: effectiveInitial)
            self.sharedDefaults.set(effectiveInitial, forKey: "lzh_latest_pip_subtitle")
            self.sharedDefaults.synchronize()
            self.writeSharedBridgeState(merging: [
                "subtitle": effectiveInitial,
                "subtitleUpdatedAt": Date().timeIntervalSince1970
            ])
            self.renderSubtitleTextToPip(effectiveInitial)
            self.startPollingSharedSubtitle()
            self.requestStartPictureInPictureWhenPossible()
            call.resolve(["started": true])
        }
    }

    @objc func stopPipSubtitle(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.teardownPip()
            call.resolve(["stopped": true])
        }
    }

    @objc func updatePipText(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.sharedDefaults.set(text, forKey: "lzh_latest_pip_subtitle")
            self.sharedDefaults.synchronize()
            self.writeSharedBridgeState(merging: [
                "subtitle": text,
                "subtitleUpdatedAt": Date().timeIntervalSince1970
            ])
            self.renderSubtitleTextToPip(text)
            call.resolve(["updated": true])
        }
    }

    private func setupAudioSessionAndKeepAlive() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
            try session.setActive(true)
        } catch {
            // Continue gracefully
        }

        if audioInterruptionObserver == nil {
            audioInterruptionObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: nil,
                queue: .main
            ) { [weak self] notification in
                guard let self = self,
                      let info = notification.userInfo,
                      let typeVal = info[AVAudioSessionInterruptionTypeKey] as? UInt,
                      let type = AVAudioSession.InterruptionType(rawValue: typeVal) else {
                    return
                }
                if type == .ended {
                    try? AVAudioSession.sharedInstance().setActive(true)
                    if let player = self.silentAudioPlayer, !player.isPlaying {
                        player.play()
                    }
                }
            }
        }

        if silentAudioPlayer == nil, let wavData = makeSilentWavData() {
            do {
                let player = try AVAudioPlayer(data: wavData)
                player.numberOfLoops = -1
                player.volume = 0.0
                player.prepareToPlay()
                player.play()
                silentAudioPlayer = player
            } catch {
                silentAudioPlayer = nil
            }
        } else if let player = silentAudioPlayer, !player.isPlaying {
            player.play()
        }
    }

    private func computeVisiblePreviewFrame(in rootView: UIView) -> CGRect {
        let bounds = rootView.bounds
        let safeInsets = rootView.safeAreaInsets
        let maxW = max(240.0, bounds.width - max(32.0, safeInsets.left + safeInsets.right + 24.0))
        let previewW = min(332.0, maxW)
        let previewH: CGFloat = 96.0
        let minX = max(8.0, safeInsets.left + 8.0)
        let maxX = max(minX, bounds.width - max(8.0, safeInsets.right + 8.0) - previewW)
        let minY = max(safeInsets.top, 44.0) + 12.0
        let bottomClearance = max(safeInsets.bottom, 20.0) + 16.0
        let maxY = max(minY, bounds.height - bottomClearance - previewH)

        if let custom = pipHostCustomOrigin {
            let clampedX = min(maxX, max(minX, custom.x))
            let clampedY = min(maxY, max(minY, custom.y))
            return CGRect(x: clampedX, y: clampedY, width: previewW, height: previewH)
        }

        let defaultX = floor((bounds.width - previewW) / 2.0)
        let defaultY = max(minY, min(maxY, floor(minY + 12.0)))
        return CGRect(x: defaultX, y: defaultY, width: previewW, height: previewH)
    }

    @objc private func handlePipHostPan(_ gesture: UIPanGestureRecognizer) {
        guard let host = pipHostView, let rootView = host.superview else { return }
        switch gesture.state {
        case .began:
            pipPanStartOrigin = host.frame.origin
        case .changed:
            let translation = gesture.translation(in: rootView)
            let safeInsets = rootView.safeAreaInsets
            let minX = max(8.0, safeInsets.left + 8.0)
            let maxX = max(minX, rootView.bounds.width - max(8.0, safeInsets.right + 8.0) - host.bounds.width)
            let minY = max(safeInsets.top, 44.0) + 8.0
            let maxY = max(minY, rootView.bounds.height - max(safeInsets.bottom, 16.0) - host.bounds.height - 8.0)
            let nx = min(maxX, max(minX, pipPanStartOrigin.x + translation.x))
            let ny = min(maxY, max(minY, pipPanStartOrigin.y + translation.y))
            host.frame.origin = CGPoint(x: nx, y: ny)
            pipHostCustomOrigin = host.frame.origin
        default:
            pipHostCustomOrigin = host.frame.origin
        }
    }

    @objc private func handleInlinePipCloseTapped() {
        teardownPip()
    }

    private func setupPipControllerIfNeeded(initialText: String) {
        guard let rootView = bridge?.viewController?.view else { return }

        if pipHostView == nil {
            let frame = computeVisiblePreviewFrame(in: rootView)
            let host = UIView(frame: frame)
            host.isHidden = false
            host.alpha = 1.0
            host.isUserInteractionEnabled = true
            host.backgroundColor = UIColor(red: 0.06, green: 0.09, blue: 0.16, alpha: 0.96)
            host.layer.cornerRadius = 18.0
            host.layer.masksToBounds = true
            host.autoresizingMask = [.flexibleLeftMargin, .flexibleRightMargin, .flexibleBottomMargin]
            rootView.addSubview(host)
            rootView.bringSubviewToFront(host)
            pipHostView = host

            let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePipHostPan(_:)))
            host.addGestureRecognizer(pan)

            let layer = AVSampleBufferDisplayLayer()
            layer.frame = host.bounds
            layer.videoGravity = .resizeAspect
            layer.backgroundColor = UIColor(red: 0.06, green: 0.09, blue: 0.16, alpha: 0.96).cgColor
            var timebase: CMTimebase?
            CMTimebaseCreateWithSourceClock(
                allocator: kCFAllocatorDefault,
                sourceClock: CMClockGetHostTimeClock(),
                timebaseOut: &timebase
            )
            if let tb = timebase {
                CMTimebaseSetTime(tb, time: CMClockGetTime(CMClockGetHostTimeClock()))
                CMTimebaseSetRate(tb, rate: 1.0)
                layer.controlTimebase = tb
            }
            host.layer.addSublayer(layer)
            sampleLayer = layer

            let dashed = CAShapeLayer()
            dashed.frame = host.bounds
            dashed.path = UIBezierPath(roundedRect: host.bounds.insetBy(dx: 2.0, dy: 2.0), cornerRadius: 16.0).cgPath
            dashed.fillColor = UIColor.clear.cgColor
            dashed.strokeColor = UIColor(red: 0.20, green: 0.83, blue: 0.60, alpha: 0.72).cgColor
            dashed.lineWidth = 1.5
            dashed.lineDashPattern = [6, 4]
            host.layer.addSublayer(dashed)
            pipPreviewBorderLayer = dashed

            let closeBtn = UIButton(type: .system)
            closeBtn.frame = CGRect(x: host.bounds.width - 32.0, y: 6.0, width: 26.0, height: 26.0)
            closeBtn.setTitle("✕", for: .normal)
            closeBtn.titleLabel?.font = UIFont.systemFont(ofSize: 12, weight: .bold)
            closeBtn.setTitleColor(.white, for: .normal)
            closeBtn.backgroundColor = UIColor.white.withAlphaComponent(0.16)
            closeBtn.layer.cornerRadius = 13.0
            closeBtn.autoresizingMask = [.flexibleLeftMargin, .flexibleBottomMargin]
            closeBtn.addTarget(self, action: #selector(handleInlinePipCloseTapped), for: .touchUpInside)
            host.addSubview(closeBtn)
            pipHostCloseButton = closeBtn
        } else if let host = pipHostView {
            host.frame = computeVisiblePreviewFrame(in: rootView)
            host.isHidden = false
            host.alpha = 1.0
            host.isUserInteractionEnabled = true
            rootView.bringSubviewToFront(host)
            sampleLayer?.frame = host.bounds
            if let dashed = pipPreviewBorderLayer {
                dashed.frame = host.bounds
                dashed.path = UIBezierPath(roundedRect: host.bounds.insetBy(dx: 2.0, dy: 2.0), cornerRadius: 16.0).cgPath
            }
            pipHostCloseButton?.isHidden = false
        }

        // Enqueue an initial frame synchronously before creating/starting AVPictureInPictureController
        renderSubtitleTextToPip(initialText)
        startPipHeartbeatTimer()

        if pipController == nil, let layer = sampleLayer {
            let contentSource = AVPictureInPictureController.ContentSource(
                sampleBufferDisplayLayer: layer,
                playbackDelegate: self
            )
            let pip = AVPictureInPictureController(contentSource: contentSource)
            pip.delegate = self
            pip.canStartPictureInPictureAutomaticallyFromInline = true
            if #available(iOS 14.2, *) {
                pip.requiresLinearPlayback = true
            }
            pipController = pip
        }
    }

    private func startPipHeartbeatTimer() {
        pipHeartbeatTimer?.invalidate()
        pipHeartbeatTimer = Timer.scheduledTimer(withTimeInterval: 0.85, repeats: true) { [weak self] _ in
            guard let self = self, !self.lastRenderedSubtitle.isEmpty else { return }
            self.renderSubtitleTextToPip(self.lastRenderedSubtitle)
        }
    }

    private func cancelPendingPipStartObservers() {
        pipPossibleObservation?.invalidate()
        pipPossibleObservation = nil
        pipPollFallbackTimer?.invalidate()
        pipPollFallbackTimer = nil
        pipStartDeadlineAt = nil
        isAwaitingPipStart = false
    }

    private func requestStartPictureInPictureWhenPossible() {
        cancelPendingPipStartObservers()
        guard let pip = pipController else { return }
        if pip.isPictureInPictureActive {
            triggerPickerIfPending()
            return
        }

        if let host = pipHostView {
            host.isHidden = false
            host.alpha = 1.0
            host.superview?.bringSubviewToFront(host)
        }

        if pip.isPictureInPicturePossible {
            pip.startPictureInPicture()
            return
        }

        isAwaitingPipStart = true
        pipStartDeadlineAt = Date().addingTimeInterval(1.5)

        pipPossibleObservation = pip.observe(\.isPictureInPicturePossible, options: [.initial, .new]) { [weak self] controller, _ in
            DispatchQueue.main.async {
                guard let self = self, self.isAwaitingPipStart else { return }
                if controller.isPictureInPicturePossible {
                    self.cancelPendingPipStartObservers()
                    if !controller.isPictureInPictureActive {
                        controller.startPictureInPicture()
                    }
                }
            }
        }

        pipPollFallbackTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            guard self.isAwaitingPipStart, let pip = self.pipController else {
                self.cancelPendingPipStartObservers()
                return
            }

            if pip.isPictureInPicturePossible {
                self.cancelPendingPipStartObservers()
                if !pip.isPictureInPictureActive {
                    pip.startPictureInPicture()
                }
                return
            }

            if !self.lastRenderedSubtitle.isEmpty {
                self.renderSubtitleTextToPip(self.lastRenderedSubtitle)
            }

            if let deadline = self.pipStartDeadlineAt, Date() >= deadline {
                self.cancelPendingPipStartObservers()
                if pip.isPictureInPicturePossible && !pip.isPictureInPictureActive {
                    pip.startPictureInPicture()
                } else {
                    self.triggerPickerIfPending()
                    self.notifyListeners("pipError", data: [
                        "message": "子母畫面仍在準備中，請確認已允許畫中畫權限或再次點擊啟動"
                    ])
                }
            }
        }
    }

    private func teardownPip() {
        cancelPendingPipStartObservers()
        pickerFallbackTimer?.cancel()
        pickerFallbackTimer = nil
        shouldTriggerPickerAfterPip = false
        pollTimer?.invalidate()
        pollTimer = nil
        pipHeartbeatTimer?.invalidate()
        pipHeartbeatTimer = nil
        unregisterDarwinObserver()
        stopLoopbackServer()
        if let pip = pipController, pip.isPictureInPictureActive {
            pip.stopPictureInPicture()
        }
        pipController = nil
        pipHostCloseButton?.removeFromSuperview()
        pipHostCloseButton = nil
        pipPreviewBorderLayer?.removeFromSuperlayer()
        pipPreviewBorderLayer = nil
        sampleLayer?.removeFromSuperlayer()
        sampleLayer = nil
        pipHostView?.removeFromSuperview()
        pipHostView = nil
        silentAudioPlayer?.stop()
        silentAudioPlayer = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        notifyListeners("pipStateChanged", data: ["active": false])
    }

    private func startPollingSharedSubtitle() {
        pollTimer?.invalidate()
        lastHandledOcrSeq = sharedDefaults.integer(forKey: "lzh_latest_ocr_seq")
        let bridgeState = readSharedBridgeState()
        lastHandledBridgeSeq = (bridgeState["ocrSeq"] as? Int) ?? -1
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] _ in
            self?.checkSharedSubtitleUpdates()
        }
    }

    private func checkSharedSubtitleUpdates() {
        let bridgeState = readSharedBridgeState()
        if let bridgeSubtitle = (bridgeState["subtitle"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !bridgeSubtitle.isEmpty,
           bridgeSubtitle != lastRenderedSubtitle {
            renderSubtitleTextToPip(bridgeSubtitle)
        }

        if let bridgeSeq = bridgeState["ocrSeq"] as? Int,
           bridgeSeq > lastHandledBridgeSeq,
           let bridgeOcr = (bridgeState["ocrText"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !bridgeOcr.isEmpty,
           !isTranslatingOcr {
            lastHandledBridgeSeq = bridgeSeq
            translateCapturedTextForPip(bridgeOcr)
            return
        }

        let defaults = sharedDefaults
        let seq = defaults.integer(forKey: "lzh_latest_ocr_seq")
        let ocrText = (defaults.string(forKey: "lzh_latest_ocr_text") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        if seq > lastHandledOcrSeq, !ocrText.isEmpty, !isTranslatingOcr {
            lastHandledOcrSeq = seq
            translateCapturedTextForPip(ocrText)
            return
        }

        let latestPip = (defaults.string(forKey: "lzh_latest_pip_subtitle") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !latestPip.isEmpty && latestPip != lastRenderedSubtitle {
            renderSubtitleTextToPip(latestPip)
        }
    }

    private func translateCapturedTextForPip(_ sourceText: String) {
        isTranslatingOcr = true
        let cfg = currentConfigDictionary()
        let engine = (cfg["engine"] as? String) ?? "apple_offline"
        let sourceLang = (cfg["sourceLang"] as? String) ?? "en"
        let targetLang = (cfg["targetLang"] as? String) ?? "zh-Hant"

        #if canImport(Translation)
        if engine == "apple_offline", #available(iOS 26.0, *) {
            Task { [weak self] in
                guard let self = self else { return }
                let translated = await self.translateWithAppleOffline(text: sourceText, from: sourceLang, to: targetLang)
                await MainActor.run {
                    self.isTranslatingOcr = false
                    if let out = translated, !out.isEmpty {
                        self.sharedDefaults.set(out, forKey: "lzh_latest_pip_subtitle")
                        self.renderSubtitleTextToPip(out)
                    } else {
                        self.translateViaCloudFallback(sourceText)
                    }
                }
            }
            return
        }
        #endif

        translateViaCloudFallback(sourceText)
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

    private func translateViaCloudFallback(_ sourceText: String) {
        let cfg = currentConfigDictionary()
        let workerUrl = ((cfg["workerBaseUrl"] as? String) ?? "https://lzhcard.tomlin980415.workers.dev").trimmingCharacters(in: .whitespacesAndNewlines)
        let customKey = ((cfg["apiKey"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let provider = ((cfg["provider"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let model = ((cfg["model"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let authToken = ((cfg["authToken"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let sourceLang = (cfg["sourceLang"] as? String) ?? "auto"

        let subtitlePrompt = """
        你是一位即時雙語字幕譯者，請將以下 OCR 擷取文字翻譯成自然道地的繁體中文：
        1. 自動忽略句首或句尾殘留的 OCR 亂碼、孤立符號或雜訊（如 `| ar Ss = 5` 等），只針對語意連貫的句子進行翻譯。
        2. 若整段內容皆為無意義雜訊或無法辨識，請僅回傳空字串。
        3. 遇到口語慣用語或俚語時，請依語境自然意譯，切勿死板逐字直譯（例如 `"new whip"` 應譯為「新車／座駕」）。
        4. 僅輸出最終繁體中文譯文，勿加引號或解釋。

        原文：
        \(sourceText)
        """

        if customKey.hasPrefix("gsk_") || (provider == "groq" && !customKey.isEmpty) {
            let groqModel = model.isEmpty ? "llama-3.1-8b-instant" : model
            guard let url = URL(string: "https://api.groq.com/openai/v1/chat/completions") else {
                isTranslatingOcr = false
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
            URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
                var translated = ""
                if let data = data,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let choices = json["choices"] as? [[String: Any]],
                   let msg = choices.first?["message"] as? [String: Any],
                   let text = msg["content"] as? String {
                    translated = text.trimmingCharacters(in: .whitespacesAndNewlines)
                }
                DispatchQueue.main.async {
                    self?.isTranslatingOcr = false
                    if !translated.isEmpty {
                        self?.sharedDefaults.set(translated, forKey: "lzh_latest_pip_subtitle")
                        self?.renderSubtitleTextToPip(translated)
                    }
                }
            }.resume()
            return
        }

        if customKey.hasPrefix("AIza") || (provider == "gemini" && !customKey.isEmpty) {
            let gemModel = (model.isEmpty || !model.lowercased().contains("gemini")) ? "gemini-2.0-flash" : model
            let endpoint = "https://generativelanguage.googleapis.com/v1beta/models/\(gemModel):generateContent?key=\(customKey)"
            guard let url = URL(string: endpoint) else { isTranslatingOcr = false; return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let body: [String: Any] = ["contents": [["parts": [["text": subtitlePrompt]]]]]
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
                var translated = ""
                if let data = data,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let cands = json["candidates"] as? [[String: Any]],
                   let content = cands.first?["content"] as? [String: Any],
                   let parts = content["parts"] as? [[String: Any]],
                   let text = parts.first?["text"] as? String {
                    translated = text.trimmingCharacters(in: .whitespacesAndNewlines)
                }
                DispatchQueue.main.async {
                    self?.isTranslatingOcr = false
                    if !translated.isEmpty {
                        self?.sharedDefaults.set(translated, forKey: "lzh_latest_pip_subtitle")
                        self?.renderSubtitleTextToPip(translated)
                    }
                }
            }.resume()
            return
        }

        guard let url = URL(string: "\(workerUrl)/ai/fast-refine") else {
            translateViaFreeTier1Fallback(sourceText, sourceLang: sourceLang)
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !authToken.isEmpty {
            req.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        let body: [String: Any] = [
            "text": sourceText,
            "sourceLang": sourceLang,
            "targetLang": "zh-TW",
            "targetLangName": "繁體中文"
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            var translated = ""
            if let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let tr = json["translation"] as? String {
                translated = tr.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if !translated.isEmpty {
                DispatchQueue.main.async {
                    self?.isTranslatingOcr = false
                    self?.sharedDefaults.set(translated, forKey: "lzh_latest_pip_subtitle")
                    self?.renderSubtitleTextToPip(translated)
                }
            } else {
                self?.translateViaFreeTier1Fallback(sourceText, sourceLang: sourceLang)
            }
        }.resume()
    }

    private func translateViaFreeTier1Fallback(_ sourceText: String, sourceLang: String) {
        let sl = sourceLang.isEmpty ? "auto" : sourceLang
        var comps = URLComponents(string: "https://translate.googleapis.com/translate_a/single")
        comps?.queryItems = [
            URLQueryItem(name: "client", value: "gtx"),
            URLQueryItem(name: "sl", value: sl),
            URLQueryItem(name: "tl", value: "zh-TW"),
            URLQueryItem(name: "dt", value: "t"),
            URLQueryItem(name: "q", value: sourceText)
        ]
        guard let url = comps?.url else {
            DispatchQueue.main.async { [weak self] in self?.isTranslatingOcr = false }
            return
        }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
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
            DispatchQueue.main.async {
                self?.isTranslatingOcr = false
                if !translated.isEmpty {
                    self?.sharedDefaults.set(translated, forKey: "lzh_latest_pip_subtitle")
                    self?.renderSubtitleTextToPip(translated)
                }
            }
        }.resume()
    }

    private func renderSubtitleTextToPip(_ text: String) {
        guard let layer = sampleLayer else { return }
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        lastRenderedSubtitle = clean

        guard let buffer = createSubtitleSampleBuffer(text: clean, width: pipWidthPx, height: pipHeightPx) else {
            return
        }
        if layer.status == .failed {
            layer.flush()
        }
        layer.enqueue(buffer)
    }

    private func createSubtitleSampleBuffer(text: String, width: Int, height: Int) -> CMSampleBuffer? {
        var pixelBuffer: CVPixelBuffer?
        let attrs: [String: Any] = [
            kCVPixelBufferCGImageCompatibilityKey as String: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:]
        ]
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32BGRA,
            attrs as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pb = pixelBuffer else { return nil }

        CVPixelBufferLockBaseAddress(pb, [])
        defer { CVPixelBufferUnlockBaseAddress(pb, []) }

        guard let ctx = CGContext(
            data: CVPixelBufferGetBaseAddress(pb),
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pb),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else {
            return nil
        }

        ctx.translateBy(x: 0, y: CGFloat(height))
        ctx.scaleBy(x: 1.0, y: -1.0)

        UIGraphicsPushContext(ctx)
        defer { UIGraphicsPopContext() }

        let fullRect = CGRect(x: 0, y: 0, width: width, height: height)
        UIColor(red: 0.06, green: 0.09, blue: 0.16, alpha: 0.94).setFill()
        ctx.fill(fullRect)

        let borderRect = fullRect.insetBy(dx: 4, dy: 4)
        let borderPath = UIBezierPath(roundedRect: borderRect, cornerRadius: 18)
        UIColor.white.withAlphaComponent(0.16).setStroke()
        borderPath.lineWidth = 2.0
        borderPath.stroke()

        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineBreakMode = .byTruncatingTail
        paragraph.lineSpacing = 4

        let fontSize: CGFloat = text.count > 44 ? 26.0 : (text.count > 24 ? 30.0 : 34.0)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: fontSize, weight: .bold),
            .foregroundColor: UIColor.white,
            .paragraphStyle: paragraph
        ]
        let attrStr = NSAttributedString(string: text, attributes: attributes)
        let insetRect = fullRect.insetBy(dx: 28, dy: 20)
        let textBounds = attrStr.boundingRect(
            with: CGSize(width: insetRect.width, height: insetRect.height),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        )
        let centeredRect = CGRect(
            x: insetRect.minX,
            y: max(insetRect.minY, (CGFloat(height) - textBounds.height) / 2.0),
            width: insetRect.width,
            height: min(insetRect.height, textBounds.height + 6)
        )
        attrStr.draw(with: centeredRect, options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)

        var formatDesc: CMVideoFormatDescription?
        let fmtStatus = CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pb,
            formatDescriptionOut: &formatDesc
        )
        guard fmtStatus == noErr, let desc = formatDesc else { return nil }

        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 30),
            presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
            decodeTimeStamp: .invalid
        )
        var sampleBuffer: CMSampleBuffer?
        let sbStatus = CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pb,
            formatDescription: desc,
            sampleTiming: &timing,
            sampleBufferOut: &sampleBuffer
        )
        if sbStatus == noErr, let sb = sampleBuffer,
           let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: true) {
            let dict = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(
                dict,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
            )
            return sb
        }
        return sbStatus == noErr ? sampleBuffer : nil
    }

    private func makeSilentWavData() -> Data? {
        let sampleRate: UInt32 = 8000
        let dataSize: UInt32 = 8000
        let chunkSize: UInt32 = 36 + dataSize
        var data = Data()
        func appendLE32(_ v: UInt32) {
            var le = v.littleEndian
            withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
        }
        func appendLE16(_ v: UInt16) {
            var le = v.littleEndian
            withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
        }
        data.append(contentsOf: "RIFF".utf8)
        appendLE32(chunkSize)
        data.append(contentsOf: "WAVE".utf8)
        data.append(contentsOf: "fmt ".utf8)
        appendLE32(16)
        appendLE16(1)
        appendLE16(1)
        appendLE32(sampleRate)
        appendLE32(sampleRate)
        appendLE16(1)
        appendLE16(8)
        data.append(contentsOf: "data".utf8)
        appendLE32(dataSize)
        data.append(Data(repeating: 128, count: Int(dataSize)))
        return data
    }

    // MARK: - AVPictureInPictureControllerDelegate & PlaybackDelegate

    public func pictureInPictureControllerWillStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        if let host = pipHostView {
            host.alpha = 0.0
        }
    }

    public func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        if let host = pipHostView {
            host.alpha = 0.0
        }
        triggerPickerIfPending()
        notifyListeners("pipStateChanged", data: ["active": true])
    }

    public func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        if let host = pipHostView {
            host.isHidden = false
            host.alpha = 1.0
        }
        notifyListeners("pipStateChanged", data: ["active": false])
    }

    public func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
        if let host = pipHostView {
            host.isHidden = false
            host.alpha = 1.0
        }
        triggerPickerIfPending()
        notifyListeners("pipError", data: ["message": error.localizedDescription])
    }

    public func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, setPlaying playing: Bool) {}

    public func pictureInPictureControllerTimeRangeForPlayback(_ pictureInPictureController: AVPictureInPictureController) -> CMTimeRange {
        CMTimeRange(start: .zero, duration: CMTime(value: 3600, timescale: 1))
    }

    public func pictureInPictureControllerIsPlaybackPaused(_ pictureInPictureController: AVPictureInPictureController) -> Bool {
        false
    }

    public func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, didTransitionToRenderSize newRenderSize: CMVideoDimensions) {}

    public func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, skipByInterval skipInterval: CMTime, completion completionHandler: @escaping () -> Void) {
        completionHandler()
    }
}

#if canImport(Translation)
@available(iOS 26.0, *)
private struct AppleTranslationDownloadHelperView: View {
    let sourceLang: String
    let targetLang: String
    let onComplete: (Bool, String) -> Void

    @State private var config: TranslationSession.Configuration?
    @State private var statusMessage = "正在檢查 Apple 離線語言包..."

    var body: some View {
        VStack(spacing: 14) {
            Text("Apple 離線翻譯語言包")
                .font(.headline)
            Text(statusMessage)
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
            Button("完成 / 關閉") {
                onComplete(true, statusMessage)
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(22)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
        .padding(24)
        .onAppear {
            config = TranslationSession.Configuration(
                source: Locale.Language(identifier: sourceLang),
                target: Locale.Language(identifier: targetLang)
            )
        }
        .translationTask(config) { session in
            do {
                try await session.prepareTranslation()
                await MainActor.run {
                    statusMessage = "已備妥 Apple 離線語言包，可立即使用螢幕翻譯。"
                }
            } catch {
                await MainActor.run {
                    statusMessage = "已開啟系統語言下載／設定：\(error.localizedDescription)"
                }
            }
        }
    }
}

@available(iOS 26.0, *)
private struct LegacyTranslationPresentationHelperView: View {
    let sampleText: String
    let onDismiss: () -> Void
    @State private var showSheet = true

    var body: some View {
        Color.clear
            .translationPresentation(isPresented: $showSheet, text: sampleText)
            .onChange(of: showSheet) { isShown in
                if !isShown {
                    onDismiss()
                }
            }
    }
}
#endif
