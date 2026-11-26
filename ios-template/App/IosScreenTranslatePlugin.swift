import Foundation
import Capacitor
import UIKit
import AVKit
import AVFoundation
import ReplayKit
import CoreMedia
import CoreVideo
import Darwin
import Network
import SwiftUI
#if canImport(Translation)
import Translation
#endif
#if canImport(ActivityKit)
import ActivityKit
#endif
#if canImport(WidgetKit)
import WidgetKit
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
        CAPPluginMethod(name: "updatePipText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncEcosystemSnapshot", returnType: CAPPluginReturnPromise)
    ]

    private let loopbackHost = "127.0.0.1"
    private let loopbackCandidatePorts: [UInt16] = [49152, 49153, 49154, 49155, 49156]
    private let darwinNotificationName = "com.lzhcard.app.pip.subtitle.updated" as CFString
    private let shortcutDarwinNotificationName = "com.lzhcard.app.shortcut.command" as CFString
    private let ipcWakeDarwinNotificationName = "com.lzhcard.app.ipc.wake" as CFString
    private let localBroadcastStartedDarwinName = "com.lzhcard.app.broadcast.started.local" as CFString
    private let localBroadcastFinishedDarwinName = "com.lzhcard.app.broadcast.finished.local" as CFString
    private let pipWidthPx = 680
    private let pipHeightPx = 192
    private let defaultInitialText = "LZHCard 預覽浮窗（可拖曳移動），點選開始廣播後切換畫面"

    private let hostSessionToken = UUID().uuidString
    private let configLock = NSLock()
    private var resolvedAppGroupId: String?
    private var sharedContainerBridgeFileUrl: URL?
    private var appGroupWritable: Bool = false
    private var appGroupHandshakeVerified: Bool = false
    private var detectedIpcMode: String = "local"
    private var lastConnectedVia: String = "none"
    private var lastLocalPacketAt: TimeInterval = 0

    private lazy var fastCloudSession: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 2.8
        cfg.timeoutIntervalForResource = 4.0
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()

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
    private var broadcastPickerOverlayView: UIView?
    private var audioInterruptionObserver: NSObjectProtocol?
    private var audioRouteObserver: NSObjectProtocol?
    private var appActiveObserver: NSObjectProtocol?
    private var appBackgroundObserver: NSObjectProtocol?

    private var silentAudioPlayer: AVAudioPlayer?
    private var pollTimer: Timer?
    private var lastHandledOcrSeq: Int = -1
    private var lastHandledBridgeSeq: Int = -1
    private var lastBroadcastActive: Bool = false
    private var lastSourceSubtitle: String = ""
    private var lastRenderedSubtitle: String = ""
    private var lastHandledShortcutTs: TimeInterval = 0
    private var isTranslatingOcr: Bool = false

    private let ipcQueue = DispatchQueue(label: "com.lzhcard.app.loopback.ipc", qos: .userInitiated)
    private let ipcListenerQueue = DispatchQueue(label: "com.lzhcard.app.loopback.nwlistener", qos: .userInitiated)
    private let ipcClientQueue = DispatchQueue(label: "com.lzhcard.app.loopback.clients", qos: .userInitiated, attributes: .concurrent)
    private var nwListener: NWListener?
    private var nwListenerReady: Bool = false
    private var activeLoopbackPort: UInt16 = 0
    private var darwinObserverRegistered = false
    private var shortcutDarwinRegistered = false
    private var ipcWakeDarwinRegistered = false
    private var localBroadcastDarwinRegistered = false
    private var pauseDarwinRegistered = false
    private var saveSubtitleDarwinRegistered = false

    private var runtimeConfig: [String: Any] = [
        "engine": "apple_offline",
        "provider": "apple_offline",
        "model": "apple_translation",
        "sourceLang": "en",
        "targetLang": "zh-Hant",
        "workerBaseUrl": "https://lzhcard.tomlin980415.workers.dev",
        "authToken": "",
        "regionMode": "auto",
        "region": [
            "x": 0.12,
            "y": 0.75,
            "width": 0.76,
            "height": 0.18
        ],
        "cropRect": [
            "x": 0.12,
            "y": 0.75,
            "width": 0.76,
            "height": 0.18
        ],
        "portraitRegionMode": "auto",
        "portraitRegion": [
            "x": 0.08,
            "y": 0.70,
            "width": 0.84,
            "height": 0.22
        ],
        "landscapeRegionMode": "auto",
        "landscapeRegion": [
            "x": 0.12,
            "y": 0.74,
            "width": 0.76,
            "height": 0.20
        ]
    ]

    override public func load() {
        super.load()
        signal(SIGPIPE, SIG_IGN)
        probeAppGroupCapability()
        hydrateRuntimeConfigFromDefaults()
        registerShortcutDarwinObserverIfNeeded()
        registerEcosystemDarwinObserversIfNeeded()
        registerIpcWakeDarwinObserverIfNeeded()
        registerLocalBroadcastDarwinObserversIfNeeded()
        registerDarwinObserverIfNeeded()
        startLoopbackServerIfNeeded()

        if appActiveObserver == nil {
            appActiveObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.consumePendingShortcutCommandIfNeeded()
                self?.drainPendingSaveCardsIfNeeded()
                self?.startLoopbackServerIfNeeded()
            }
        }
        if appBackgroundObserver == nil {
            appBackgroundObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.startLoopbackServerIfNeeded()
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            self?.consumePendingShortcutCommandIfNeeded()
            self?.drainPendingSaveCardsIfNeeded()
        }
    }

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
        if let routeObs = audioRouteObserver {
            NotificationCenter.default.removeObserver(routeObs)
            audioRouteObserver = nil
        }
        if let actObs = appActiveObserver {
            NotificationCenter.default.removeObserver(actObs)
            appActiveObserver = nil
        }
        if let bgObs = appBackgroundObserver {
            NotificationCenter.default.removeObserver(bgObs)
            appBackgroundObserver = nil
        }
        unregisterDarwinObserver()
        unregisterShortcutDarwinObserver()
        unregisterEcosystemDarwinObservers()
        unregisterIpcWakeDarwinObserver()
        unregisterLocalBroadcastDarwinObservers()
        stopLoopbackServer()
    }

    private func probeAppGroupCapability() {
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
        var foundGid: String?
        var foundBridgeUrl: URL?
        var writable = false

        for gid in candidates where !gid.isEmpty && !seen.contains(gid) {
            seen.insert(gid)
            guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: gid) else {
                continue
            }
            let cachesDir = container.appendingPathComponent("Library/Caches", isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: cachesDir, withIntermediateDirectories: true)
                let probeFile = cachesDir.appendingPathComponent(".lzh_ag_probe_\(UUID().uuidString).tmp")
                let probeToken = "LZH_PROBE_\(Date().timeIntervalSince1970)"
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

        configLock.lock()
        resolvedAppGroupId = foundGid
        sharedContainerBridgeFileUrl = foundBridgeUrl
        appGroupWritable = writable
        if !writable {
            appGroupHandshakeVerified = false
            detectedIpcMode = "local"
        } else if lastConnectedVia != "local_loopback" {
            detectedIpcMode = "app_group"
        }
        configLock.unlock()

        if writable {
            writeSharedBridgeState(merging: [
                "hostSessionToken": hostSessionToken,
                "hostAppGroupId": foundGid ?? "",
                "hostLoopbackPort": Int(activeLoopbackPort),
                "hostPid": Int(ProcessInfo.processInfo.processIdentifier),
                "hostReadyAt": Date().timeIntervalSince1970
            ])
        }
    }

    private func hydrateRuntimeConfigFromDefaults() {
        let cfg = currentConfigDictionary()
        configLock.lock()
        runtimeConfig = cfg
        configLock.unlock()
    }

    private var sharedDefaults: UserDefaults {
        configLock.lock()
        let gid = appGroupWritable ? resolvedAppGroupId : nil
        configLock.unlock()
        if let gid = gid, let suite = UserDefaults(suiteName: gid) {
            return suite
        }
        return UserDefaults.standard
    }

    private func readSharedBridgeState() -> [String: Any] {
        configLock.lock()
        let url = sharedContainerBridgeFileUrl
        configLock.unlock()
        guard let url = url,
              let data = try? Data(contentsOf: url),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return dict
    }

    private func writeSharedBridgeState(merging updates: [String: Any]) {
        configLock.lock()
        let url = sharedContainerBridgeFileUrl
        configLock.unlock()
        guard let url = url else { return }
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

    private func registerShortcutDarwinObserverIfNeeded() {
        guard !shortcutDarwinRegistered else { return }
        shortcutDarwinRegistered = true
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(
            center,
            observer,
            { _, observerPtr, _, _, _ in
                guard let observerPtr = observerPtr else { return }
                let plugin = Unmanaged<IosScreenTranslatePlugin>.fromOpaque(observerPtr).takeUnretainedValue()
                DispatchQueue.main.async {
                    plugin.consumePendingShortcutCommandIfNeeded()
                }
            },
            shortcutDarwinNotificationName,
            nil,
            .deliverImmediately
        )
    }

    private func unregisterShortcutDarwinObserver() {
        guard shortcutDarwinRegistered else { return }
        shortcutDarwinRegistered = false
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterRemoveObserver(center, observer, CFNotificationName(shortcutDarwinNotificationName), nil)
    }

    private func consumePendingShortcutCommandIfNeeded() {
        var foundAction = ""
        var foundTs: TimeInterval = 0
        let containers: [UserDefaults] = [sharedDefaults, UserDefaults.standard]
        for ud in containers {
            let ts = ud.double(forKey: "lzh_pending_shortcut_ts")
            if let act = ud.string(forKey: "lzh_pending_shortcut_action"), !act.isEmpty, ts > foundTs {
                foundAction = act
                foundTs = ts
            }
        }
        guard !foundAction.isEmpty, foundTs > lastHandledShortcutTs, (Date().timeIntervalSince1970 - foundTs) < 25.0 else {
            return
        }
        lastHandledShortcutTs = foundTs
        for ud in containers {
            ud.removeObject(forKey: "lzh_pending_shortcut_action")
            ud.removeObject(forKey: "lzh_pending_shortcut_ts")
            ud.synchronize()
        }

        if foundAction == "stop_subtitle_recognition" {
            teardownPip()
        }
        notifyListeners("shortcutCommand", data: ["action": foundAction])
    }

    private func registerEcosystemDarwinObserversIfNeeded() {
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        if !pauseDarwinRegistered {
            pauseDarwinRegistered = true
            CFNotificationCenterAddObserver(
                center,
                observer,
                { _, observerPtr, _, _, _ in
                    guard let observerPtr = observerPtr else { return }
                    let plugin = Unmanaged<IosScreenTranslatePlugin>.fromOpaque(observerPtr).takeUnretainedValue()
                    DispatchQueue.main.async {
                        plugin.handleSubtitlePauseToggledNotification()
                    }
                },
                LzhSharedEcosystemStore.darwinPauseToggled,
                nil,
                .deliverImmediately
            )
        }
        if !saveSubtitleDarwinRegistered {
            saveSubtitleDarwinRegistered = true
            CFNotificationCenterAddObserver(
                center,
                observer,
                { _, observerPtr, _, _, _ in
                    guard let observerPtr = observerPtr else { return }
                    let plugin = Unmanaged<IosScreenTranslatePlugin>.fromOpaque(observerPtr).takeUnretainedValue()
                    DispatchQueue.main.async {
                        plugin.drainPendingSaveCardsIfNeeded()
                    }
                },
                LzhSharedEcosystemStore.darwinSaveSubtitleRequested,
                nil,
                .deliverImmediately
            )
        }
    }

    private func unregisterEcosystemDarwinObservers() {
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        if pauseDarwinRegistered {
            pauseDarwinRegistered = false
            CFNotificationCenterRemoveObserver(center, observer, CFNotificationName(LzhSharedEcosystemStore.darwinPauseToggled), nil)
        }
        if saveSubtitleDarwinRegistered {
            saveSubtitleDarwinRegistered = false
            CFNotificationCenterRemoveObserver(center, observer, CFNotificationName(LzhSharedEcosystemStore.darwinSaveSubtitleRequested), nil)
        }
    }

    private func handleSubtitlePauseToggledNotification() {
        let paused = LzhSharedEcosystemStore.isSubtitlePaused()
        if paused {
            renderSubtitleTextToPip("⏸ 字幕翻譯已暫停（點擊動態島可繼續）", sourceText: lastSourceSubtitle)
        } else if !lastRenderedSubtitle.isEmpty {
            renderSubtitleTextToPip(lastRenderedSubtitle, sourceText: lastSourceSubtitle)
        }
        updateDynamicIslandLiveActivity(
            sourceText: lastSourceSubtitle,
            translatedText: lastRenderedSubtitle.isEmpty ? "螢幕翻譯恢復偵測中..." : lastRenderedSubtitle,
            statusLabel: paused ? "⏸ 已暫停" : (detectedIpcMode == "app_group" ? "廣播翻譯中" : "本機翻譯中"),
            isActive: lastBroadcastActive,
            isPaused: paused
        )
        notifyListeners("pauseStateChanged", data: ["paused": paused])
    }

    private func drainPendingSaveCardsIfNeeded() {
        let cards = LzhSharedEcosystemStore.drainPendingSaveCards()
        if !cards.isEmpty {
            for item in cards {
                let src = (item["sourceText"] as? String) ?? ""
                let tr = (item["translatedText"] as? String) ?? ""
                guard !src.isEmpty || !tr.isEmpty else { continue }
                notifyListeners("shortcutCommand", data: [
                    "action": "save_current_subtitle",
                    "sourceText": src,
                    "translatedText": tr
                ])
            }
        }
    }

    private func broadcastExtensionBundleIdFallback() -> String {
        "\(Bundle.main.bundleIdentifier ?? "com.lzhcard.app").BroadcastUpload"
    }

    private func registerIpcWakeDarwinObserverIfNeeded() {
        guard !ipcWakeDarwinRegistered else { return }
        ipcWakeDarwinRegistered = true
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(
            center,
            observer,
            { _, observerPtr, _, _, _ in
                guard let observerPtr = observerPtr else { return }
                let plugin = Unmanaged<IosScreenTranslatePlugin>.fromOpaque(observerPtr).takeUnretainedValue()
                plugin.startLoopbackServerIfNeeded()
                DispatchQueue.main.async {
                    plugin.checkSharedSubtitleUpdates()
                }
            },
            ipcWakeDarwinNotificationName,
            nil,
            .deliverImmediately
        )
    }

    private func unregisterIpcWakeDarwinObserver() {
        guard ipcWakeDarwinRegistered else { return }
        ipcWakeDarwinRegistered = false
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterRemoveObserver(center, observer, CFNotificationName(ipcWakeDarwinNotificationName), nil)
    }

    private func registerLocalBroadcastDarwinObserversIfNeeded() {
        guard !localBroadcastDarwinRegistered else { return }
        localBroadcastDarwinRegistered = true
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(
            center,
            observer,
            { _, observerPtr, _, _, _ in
                guard let observerPtr = observerPtr else { return }
                let plugin = Unmanaged<IosScreenTranslatePlugin>.fromOpaque(observerPtr).takeUnretainedValue()
                plugin.startLoopbackServerIfNeeded()
                DispatchQueue.main.async {
                    plugin.handleLocalBroadcastStartedNotification()
                }
            },
            localBroadcastStartedDarwinName,
            nil,
            .deliverImmediately
        )
        CFNotificationCenterAddObserver(
            center,
            observer,
            { _, observerPtr, _, _, _ in
                guard let observerPtr = observerPtr else { return }
                let plugin = Unmanaged<IosScreenTranslatePlugin>.fromOpaque(observerPtr).takeUnretainedValue()
                DispatchQueue.main.async {
                    plugin.handleLocalBroadcastFinishedNotification()
                }
            },
            localBroadcastFinishedDarwinName,
            nil,
            .deliverImmediately
        )
    }

    private func unregisterLocalBroadcastDarwinObservers() {
        guard localBroadcastDarwinRegistered else { return }
        localBroadcastDarwinRegistered = false
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterRemoveObserver(center, observer, CFNotificationName(localBroadcastStartedDarwinName), nil)
        CFNotificationCenterRemoveObserver(center, observer, CFNotificationName(localBroadcastFinishedDarwinName), nil)
    }

    private func handleLocalBroadcastStartedNotification() {
        removeBroadcastHelperBanner()
        let wasActive = lastBroadcastActive
        lastBroadcastActive = true
        let statusMsg = "LZHCard 廣播已連線（本機偵測中），等待畫面字幕..."
        if !wasActive {
            notifyListeners("broadcastStateChanged", data: [
                "active": true,
                "message": statusMsg
            ])
        }
        if lastRenderedSubtitle.isEmpty || lastRenderedSubtitle == defaultInitialText || lastRenderedSubtitle == "螢幕翻譯廣播已結束" {
            renderSubtitleTextToPip(statusMsg, sourceText: lastSourceSubtitle)
            updateDynamicIslandLiveActivity(
                sourceText: lastSourceSubtitle,
                translatedText: statusMsg,
                statusLabel: detectedIpcMode == "app_group" ? "廣播翻譯中" : "本機翻譯中",
                isActive: true
            )
        }
        emitIpcStatusChanged()
    }

    private func handleLocalBroadcastFinishedNotification() {
        let wasActive = lastBroadcastActive
        lastBroadcastActive = false
        let endMsg = "螢幕翻譯廣播已結束"
        if wasActive {
            notifyListeners("broadcastStateChanged", data: [
                "active": false,
                "message": endMsg
            ])
        }
        renderSubtitleTextToPip(endMsg, sourceText: "")
        updateDynamicIslandLiveActivity(
            sourceText: "",
            translatedText: endMsg,
            statusLabel: "已結束",
            isActive: false
        )
        emitIpcStatusChanged()
    }

    private func emitIpcStatusChanged() {
        configLock.lock()
        let mode = detectedIpcMode
        let agWritable = appGroupWritable
        let agVerified = appGroupHandshakeVerified
        let port = Int(activeLoopbackPort)
        let ready = nwListenerReady && port > 0
        let via = lastConnectedVia
        configLock.unlock()

        notifyListeners("ipcStatusChanged", data: [
            "ipcMode": mode,
            "appGroupWritable": agWritable,
            "appGroupVerified": agVerified,
            "loopbackReady": ready,
            "loopbackPort": port,
            "lastConnectedVia": via,
            "broadcastActive": lastBroadcastActive
        ])
    }

    // MARK: - Channel B: Network.framework NWListener Loopback Server (127.0.0.1:49152-49156)

    private func startLoopbackServerIfNeeded() {
        ipcQueue.async { [weak self] in
            self?.ensureLoopbackServerOnIpcQueue()
        }
    }

    private func ensureLoopbackServerOnIpcQueue() {
        configLock.lock()
        let alreadyRunning = (nwListener != nil && nwListenerReady && activeLoopbackPort > 0)
        configLock.unlock()
        if alreadyRunning {
            return
        }

        stopLoopbackServerOnIpcQueue()

        for port in loopbackCandidatePorts {
            if let listener = bindNWLoopbackListener(port: port) {
                configLock.lock()
                nwListener = listener
                nwListenerReady = true
                activeLoopbackPort = port
                let agWritable = appGroupWritable
                configLock.unlock()

                if agWritable {
                    writeSharedBridgeState(merging: [
                        "hostLoopbackPort": Int(port),
                        "hostReadyAt": Date().timeIntervalSince1970
                    ])
                }
                DispatchQueue.main.async { [weak self] in
                    self?.emitIpcStatusChanged()
                }
                return
            }
        }
    }

    private func bindNWLoopbackListener(port: UInt16) -> NWListener? {
        guard let nwPort = NWEndpoint.Port(rawValue: port),
              let loopbackIP = IPv4Address(loopbackHost) else {
            return nil
        }

        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(loopbackIP), port: nwPort)

        let listener: NWListener
        do {
            listener = try NWListener(using: params)
        } catch {
            return nil
        }

        let bindLock = NSLock()
        var bindResolved = false
        var bindSucceeded = false
        let sema = DispatchSemaphore(value: 0)

        listener.newConnectionHandler = { [weak self] connection in
            self?.handleNWConnection(connection)
        }

        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                bindLock.lock()
                if !bindResolved {
                    bindResolved = true
                    bindSucceeded = true
                    bindLock.unlock()
                    sema.signal()
                } else {
                    bindLock.unlock()
                }
            case .failed:
                bindLock.lock()
                let initialFailure = !bindResolved
                if initialFailure {
                    bindResolved = true
                    bindSucceeded = false
                    bindLock.unlock()
                    listener.cancel()
                    sema.signal()
                } else {
                    bindLock.unlock()
                    self?.ipcQueue.async {
                        guard let self = self else { return }
                        if self.nwListener === listener {
                            self.stopLoopbackServerOnIpcQueue()
                            self.ipcQueue.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                                self?.ensureLoopbackServerOnIpcQueue()
                            }
                        }
                    }
                }
            case .cancelled:
                bindLock.lock()
                if !bindResolved {
                    bindResolved = true
                    bindSucceeded = false
                    bindLock.unlock()
                    sema.signal()
                } else {
                    bindLock.unlock()
                }
            default:
                break
            }
        }

        listener.start(queue: ipcListenerQueue)
        _ = sema.wait(timeout: .now() + 0.35)

        bindLock.lock()
        let ok = bindSucceeded
        if !bindResolved {
            bindResolved = true
            bindLock.unlock()
            listener.cancel()
            return nil
        }
        bindLock.unlock()
        return ok ? listener : nil
    }

    private func stopLoopbackServer() {
        ipcQueue.async { [weak self] in
            self?.stopLoopbackServerOnIpcQueue()
        }
    }

    private func stopLoopbackServerOnIpcQueue() {
        configLock.lock()
        let listener = nwListener
        nwListener = nil
        nwListenerReady = false
        activeLoopbackPort = 0
        configLock.unlock()
        listener?.stateUpdateHandler = nil
        listener?.newConnectionHandler = nil
        listener?.cancel()
    }

    private func handleNWConnection(_ connection: NWConnection) {
        connection.stateUpdateHandler = { state in
            if case .failed = state {
                connection.cancel()
            }
        }
        connection.start(queue: ipcClientQueue)
        receiveLoopbackHttpChunk(on: connection, buffer: Data())
    }

    private func receiveLoopbackHttpChunk(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self else {
                connection.cancel()
                return
            }

            var accumulated = buffer
            if let chunk = data, !chunk.isEmpty {
                accumulated.append(chunk)
            }

            if accumulated.count > 262144 {
                self.sendHttpResponse(on: connection, statusCode: 400, jsonBody: ["ok": false, "error": "payload_too_large"])
                return
            }

            if let parsed = self.tryParseHttpRequest(accumulated) {
                self.routeLoopbackRequest(method: parsed.method, path: parsed.path, body: parsed.body, on: connection)
                return
            }

            if isComplete || error != nil {
                self.sendHttpResponse(on: connection, statusCode: 400, jsonBody: ["ok": false, "error": "invalid_request"])
                return
            }

            self.receiveLoopbackHttpChunk(on: connection, buffer: accumulated)
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

    private func routeLoopbackRequest(method: String, path: String, body: Data, on connection: NWConnection) {
        if method == "GET" && path == "/config" {
            var cfgSnapshot = currentConfigDictionary()
            configLock.lock()
            lastLocalPacketAt = Date().timeIntervalSince1970
            if !appGroupWritable {
                detectedIpcMode = "local"
            }
            if lastConnectedVia == "none" {
                lastConnectedVia = "local_loopback"
            }
            let activeModeNow = detectedIpcMode
            cfgSnapshot["hostSessionToken"] = hostSessionToken
            cfgSnapshot["hostAppGroupId"] = resolvedAppGroupId ?? ""
            cfgSnapshot["hostAppGroupWritable"] = appGroupWritable
            cfgSnapshot["hostIpcMode"] = activeModeNow
            cfgSnapshot["hostLoopbackPort"] = Int(activeLoopbackPort)
            cfgSnapshot["isPaused"] = LzhSharedEcosystemStore.isSubtitlePaused()
            configLock.unlock()

            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                if !self.lastBroadcastActive {
                    self.handleLocalBroadcastStartedNotification()
                } else {
                    self.emitIpcStatusChanged()
                }
            }
            sendHttpResponse(on: connection, statusCode: 200, jsonBody: cfgSnapshot)
            return
        }

        if method == "POST" && path == "/subtitle" {
            var incomingText = ""
            var incomingSource = ""
            var incomingIpcMode = ""
            var extAgWritable = false
            var extHandshakeOk = false
            var translatedReady = true
            var broadcastActive = true
            if let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                incomingText = String((json["text"] as? String) ?? (json["subtitle"] as? String) ?? "")
                incomingSource = String(json["sourceText"] as? String ?? "")
                incomingIpcMode = String(json["ipcMode"] as? String ?? "")
                extAgWritable = (json["appGroupWritable"] as? Bool) ?? false
                extHandshakeOk = (json["appGroupVerified"] as? Bool) ?? false
                if let trFlag = json["translated"] as? Bool {
                    translatedReady = trFlag
                }
                if let bcFlag = json["broadcastActive"] as? Bool {
                    broadcastActive = bcFlag
                }
            } else if let rawText = String(data: body, encoding: .utf8) {
                incomingText = rawText
            }
            let clean = incomingText.trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanSrc = incomingSource.trimmingCharacters(in: .whitespacesAndNewlines)

            configLock.lock()
            lastLocalPacketAt = Date().timeIntervalSince1970
            let prevMode = detectedIpcMode
            if incomingIpcMode == "app_group" && extAgWritable && extHandshakeOk && appGroupWritable {
                appGroupHandshakeVerified = true
                detectedIpcMode = "app_group"
                lastConnectedVia = "app_group"
            } else {
                detectedIpcMode = (incomingIpcMode == "local" || !appGroupWritable) ? "local" : detectedIpcMode
                lastConnectedVia = "local_loopback"
            }
            let modeChanged = (prevMode != detectedIpcMode)
            let activeModeNow = detectedIpcMode
            let portNow = Int(activeLoopbackPort)
            configLock.unlock()

            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.sharedDefaults.set(broadcastActive, forKey: "lzh_broadcast_active")
                if broadcastActive != self.lastBroadcastActive {
                    self.lastBroadcastActive = broadcastActive
                    self.notifyListeners("broadcastStateChanged", data: [
                        "active": broadcastActive,
                        "message": clean,
                        "ipcMode": activeModeNow
                    ])
                }
                if modeChanged || self.lastConnectedVia == "local_loopback" {
                    self.emitIpcStatusChanged()
                }
                if broadcastActive {
                    self.removeBroadcastHelperBanner()
                }
                if !cleanSrc.isEmpty {
                    self.lastSourceSubtitle = cleanSrc
                    self.notifyListeners("ocrCaptured", data: ["text": cleanSrc])
                }
                if translatedReady && !clean.isEmpty {
                    self.sharedDefaults.set(clean, forKey: "lzh_latest_pip_subtitle")
                    self.sharedDefaults.synchronize()
                    self.writeSharedBridgeState(merging: [
                        "subtitle": clean,
                        "ocrText": cleanSrc,
                        "broadcastActive": broadcastActive,
                        "subtitleUpdatedAt": Date().timeIntervalSince1970
                    ])
                    self.renderSubtitleTextToPip(clean, sourceText: cleanSrc)
                    if !cleanSrc.isEmpty {
                        LzhSharedEcosystemStore.saveLatestSubtitle(source: cleanSrc, translated: clean)
                        self.notifyListeners("subtitleTranslated", data: [
                            "sourceText": cleanSrc,
                            "translatedText": clean
                        ])
                    }
                    self.updateDynamicIslandLiveActivity(
                        sourceText: cleanSrc,
                        translatedText: clean,
                        statusLabel: broadcastActive ? (activeModeNow == "app_group" ? "廣播翻譯中" : "本機翻譯中") : "已結束",
                        isActive: broadcastActive
                    )
                } else if !cleanSrc.isEmpty && !self.isTranslatingOcr {
                    self.translateCapturedTextForPip(cleanSrc)
                }
            }
            sendHttpResponse(on: connection, statusCode: 200, jsonBody: [
                "ok": true,
                "ipcMode": activeModeNow,
                "loopbackPort": portNow
            ])
            return
        }

        if method == "GET" && path == "/health" {
            configLock.lock()
            let agId = resolvedAppGroupId ?? ""
            let agW = appGroupWritable
            let mode = detectedIpcMode
            let port = Int(activeLoopbackPort)
            configLock.unlock()
            sendHttpResponse(on: connection, statusCode: 200, jsonBody: [
                "ok": true,
                "appGroup": agId,
                "appGroupWritable": agW,
                "ipcMode": mode,
                "loopbackPort": port
            ])
            return
        }

        sendHttpResponse(on: connection, statusCode: 404, jsonBody: ["ok": false, "error": "not_found"])
    }

    private func sendHttpResponse(on connection: NWConnection, statusCode: Int, jsonBody: [String: Any]) {
        let statusText = statusCode == 200 ? "OK" : (statusCode == 404 ? "Not Found" : "Bad Request")
        let bodyData = (try? JSONSerialization.data(withJSONObject: jsonBody, options: [])) ?? Data("{}".utf8)
        let header = "HTTP/1.1 \(statusCode) \(statusText)\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(bodyData.count)\r\nConnection: close\r\n\r\n"
        var responseData = Data(header.utf8)
        responseData.append(bodyData)

        connection.send(content: responseData, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func currentConfigDictionary() -> [String: Any] {
        configLock.lock()
        var cfg = runtimeConfig
        configLock.unlock()

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
        if let prm = defaults.string(forKey: "lzh_portrait_region_mode"), !prm.isEmpty {
            cfg["portraitRegionMode"] = prm
        }
        let pw = defaults.double(forKey: "lzh_portrait_region_w")
        let ph = defaults.double(forKey: "lzh_portrait_region_h")
        if pw > 0.05 && ph > 0.05 {
            cfg["portraitRegion"] = [
                "x": defaults.double(forKey: "lzh_portrait_region_x"),
                "y": defaults.double(forKey: "lzh_portrait_region_y"),
                "width": pw,
                "height": ph
            ]
        }
        if let lrm = defaults.string(forKey: "lzh_landscape_region_mode"), !lrm.isEmpty {
            cfg["landscapeRegionMode"] = lrm
        }
        let lw = defaults.double(forKey: "lzh_landscape_region_w")
        let lh = defaults.double(forKey: "lzh_landscape_region_h")
        if lw > 0.05 && lh > 0.05 {
            cfg["landscapeRegion"] = [
                "x": defaults.double(forKey: "lzh_landscape_region_x"),
                "y": defaults.double(forKey: "lzh_landscape_region_y"),
                "width": lw,
                "height": lh
            ]
        }
        return cfg
    }

    // MARK: - Capacitor Plugin Methods

    private func hasBroadcastExtension() -> Bool {
        guard let plugInsUrl = Bundle.main.builtInPlugInsURL,
              let items = try? FileManager.default.contentsOfDirectory(at: plugInsUrl, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else {
            return false
        }
        for url in items where url.pathExtension.lowercased() == "appex" {
            let plistUrl = url.appendingPathComponent("Info.plist")
            let info = Bundle(url: url)?.infoDictionary ?? (NSDictionary(contentsOf: plistUrl) as? [String: Any])
            if let nsExt = info?["NSExtension"] as? [String: Any],
               let pointId = nsExt["NSExtensionPointIdentifier"] as? String,
               pointId == "com.apple.broadcast-services-upload" {
                return true
            }
        }
        return false
    }

    @objc func getCapabilities(_ call: CAPPluginCall) {
        probeAppGroupCapability()
        ipcQueue.sync {
            ensureLoopbackServerOnIpcQueue()
        }

        let ver = ProcessInfo.processInfo.operatingSystemVersion
        let supportsOfflineSheet = ver.majorVersion >= 18
        let supportsTranslationSession = ver.majorVersion >= 26
        let pipSupported = AVPictureInPictureController.isPictureInPictureSupported()
        let hasBroadcastExt = hasBroadcastExtension()

        configLock.lock()
        let gid = resolvedAppGroupId ?? ""
        let agWritable = appGroupWritable
        let agVerified = appGroupHandshakeVerified
        let mode = detectedIpcMode
        let via = lastConnectedVia
        let port = Int(activeLoopbackPort)
        let ready = nwListenerReady && port > 0
        configLock.unlock()

        call.resolve([
            "supported": true,
            "iosMajor": ver.majorVersion,
            "iosMinor": ver.minorVersion,
            "supportsOfflineTranslation": supportsOfflineSheet,
            "supportsTranslationSession": supportsTranslationSession,
            "pipSupported": pipSupported,
            "hasBroadcastExtension": hasBroadcastExt,
            "loopbackReady": ready,
            "loopbackPort": port,
            "appGroupId": gid,
            "appGroupWritable": agWritable,
            "appGroupVerified": agVerified,
            "ipcMode": mode,
            "lastConnectedVia": via,
            "broadcastActive": lastBroadcastActive,
            "pipActive": pipController?.isPictureInPictureActive ?? false,
            "latestSourceText": lastSourceSubtitle,
            "latestSubtitle": lastRenderedSubtitle
        ])
    }

    @objc func prepareOfflineLanguages(_ call: CAPPluginCall) {
        let sourceLang = call.getString("sourceLang") ?? "en"
        let targetLang = call.getString("targetLang") ?? "zh-Hant"

        guard #available(iOS 18.0, *) else {
            call.resolve([
                "supported": false,
                "fallbackSuggested": true,
                "reason": "目前系統版本將自動使用雲端高速翻譯通道；iOS 18 以上提供 Apple 原生離線語言包。"
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
        let workerBaseUrl = call.getString("workerBaseUrl") ?? "https://lzhcard.tomlin980415.workers.dev"
        let authToken = call.getString("authToken") ?? ""
        let regionMode = call.getString("regionMode") ?? "auto"
        let portraitRegionMode = call.getString("portraitRegionMode") ?? regionMode
        let landscapeRegionMode = call.getString("landscapeRegionMode") ?? regionMode

        let defaultsList: [UserDefaults] = (sharedDefaults === UserDefaults.standard)
            ? [UserDefaults.standard]
            : [sharedDefaults, UserDefaults.standard]

        var regDict: [String: Double] = [
            "x": sharedDefaults.double(forKey: "lzh_region_x"),
            "y": sharedDefaults.double(forKey: "lzh_region_y"),
            "width": sharedDefaults.double(forKey: "lzh_region_w"),
            "height": sharedDefaults.double(forKey: "lzh_region_h")
        ]
        let rectSource = call.getObject("cropRect") ?? call.getObject("region")
        if let region = rectSource {
            let rx = (region["x"] as? NSNumber)?.doubleValue ?? (region["x"] as? Double) ?? 0.12
            let ry = (region["y"] as? NSNumber)?.doubleValue ?? (region["y"] as? Double) ?? 0.75
            let rw = (region["width"] as? NSNumber)?.doubleValue ?? (region["width"] as? Double) ?? 0.76
            let rh = (region["height"] as? NSNumber)?.doubleValue ?? (region["height"] as? Double) ?? 0.18
            regDict = ["x": rx, "y": ry, "width": rw, "height": rh]
        }

        var portraitDict: [String: Double] = [
            "x": 0.08,
            "y": 0.70,
            "width": 0.84,
            "height": 0.22
        ]
        if let pReg = call.getObject("portraitRegion") {
            let px = (pReg["x"] as? NSNumber)?.doubleValue ?? (pReg["x"] as? Double) ?? 0.08
            let py = (pReg["y"] as? NSNumber)?.doubleValue ?? (pReg["y"] as? Double) ?? 0.70
            let pw = (pReg["width"] as? NSNumber)?.doubleValue ?? (pReg["width"] as? Double) ?? 0.84
            let ph = (pReg["height"] as? NSNumber)?.doubleValue ?? (pReg["height"] as? Double) ?? 0.22
            if pw > 0.05 && ph > 0.05 {
                portraitDict = ["x": px, "y": py, "width": pw, "height": ph]
            }
        }

        var landscapeDict: [String: Double] = [
            "x": 0.12,
            "y": 0.74,
            "width": 0.76,
            "height": 0.20
        ]
        if let lReg = call.getObject("landscapeRegion") {
            let lx = (lReg["x"] as? NSNumber)?.doubleValue ?? (lReg["x"] as? Double) ?? 0.12
            let ly = (lReg["y"] as? NSNumber)?.doubleValue ?? (lReg["y"] as? Double) ?? 0.74
            let lw = (lReg["width"] as? NSNumber)?.doubleValue ?? (lReg["width"] as? Double) ?? 0.76
            let lh = (lReg["height"] as? NSNumber)?.doubleValue ?? (lReg["height"] as? Double) ?? 0.20
            if lw > 0.05 && lh > 0.05 {
                landscapeDict = ["x": lx, "y": ly, "width": lw, "height": lh]
            }
        }

        for defaults in defaultsList {
            defaults.set(engine, forKey: "lzh_translate_engine")
            defaults.set(provider, forKey: "lzh_translate_provider")
            defaults.set(model, forKey: "lzh_translate_model")
            defaults.set(sourceLang, forKey: "lzh_source_lang")
            defaults.set(targetLang, forKey: "lzh_target_lang")
            defaults.removeObject(forKey: "lzh_custom_api_key")
            defaults.set(workerBaseUrl, forKey: "lzh_worker_base_url")
            defaults.set(authToken, forKey: "lzh_auth_token")
            defaults.set(regionMode, forKey: "lzh_region_mode")
            defaults.set(portraitRegionMode, forKey: "lzh_portrait_region_mode")
            defaults.set(landscapeRegionMode, forKey: "lzh_landscape_region_mode")
            if let rx = regDict["x"], let ry = regDict["y"], let rw = regDict["width"], let rh = regDict["height"], rw > 0.05, rh > 0.05 {
                defaults.set(rx, forKey: "lzh_region_x")
                defaults.set(ry, forKey: "lzh_region_y")
                defaults.set(rw, forKey: "lzh_region_w")
                defaults.set(rh, forKey: "lzh_region_h")
            }
            defaults.set(portraitDict["x"] ?? 0.08, forKey: "lzh_portrait_region_x")
            defaults.set(portraitDict["y"] ?? 0.70, forKey: "lzh_portrait_region_y")
            defaults.set(portraitDict["width"] ?? 0.84, forKey: "lzh_portrait_region_w")
            defaults.set(portraitDict["height"] ?? 0.22, forKey: "lzh_portrait_region_h")
            defaults.set(landscapeDict["x"] ?? 0.12, forKey: "lzh_landscape_region_x")
            defaults.set(landscapeDict["y"] ?? 0.74, forKey: "lzh_landscape_region_y")
            defaults.set(landscapeDict["width"] ?? 0.76, forKey: "lzh_landscape_region_w")
            defaults.set(landscapeDict["height"] ?? 0.20, forKey: "lzh_landscape_region_h")
            defaults.synchronize()
        }

        let updatedCfg: [String: Any] = [
            "engine": engine,
            "provider": provider,
            "model": model,
            "sourceLang": sourceLang,
            "targetLang": targetLang,
            "workerBaseUrl": workerBaseUrl,
            "authToken": authToken,
            "regionMode": regionMode,
            "region": regDict,
            "cropRect": regDict,
            "portraitRegionMode": portraitRegionMode,
            "portraitRegion": portraitDict,
            "landscapeRegionMode": landscapeRegionMode,
            "landscapeRegion": landscapeDict
        ]
        configLock.lock()
        runtimeConfig = updatedCfg
        configLock.unlock()

        writeSharedBridgeState(merging: [
            "config": updatedCfg,
            "configUpdatedAt": Date().timeIntervalSince1970
        ])
        startLoopbackServerIfNeeded()

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

    @objc private func handleDismissBroadcastHelperBanner() {
        removeBroadcastHelperBanner()
    }

    private func removeBroadcastHelperBanner() {
        DispatchQueue.main.async { [weak self] in
            self?.broadcastPickerOverlayView?.removeFromSuperview()
            self?.broadcastPickerOverlayView = nil
        }
    }

    private func ensureBroadcastHelperBanner(in rootView: UIView) {
        if lastBroadcastActive {
            removeBroadcastHelperBanner()
            return
        }
        if let existing = broadcastPickerOverlayView {
            rootView.bringSubviewToFront(existing)
            return
        }

        let safeInsets = rootView.safeAreaInsets
        let barW = min(360.0, max(260.0, rootView.bounds.width - 28.0))
        let barH: CGFloat = 72.0
        let barX = floor((rootView.bounds.width - barW) / 2.0)
        let barY = max(safeInsets.top + 60.0, rootView.bounds.height - max(safeInsets.bottom, 20.0) - barH - 74.0)

        let banner = UIView(frame: CGRect(x: barX, y: barY, width: barW, height: barH))
        banner.backgroundColor = UIColor(red: 0.07, green: 0.11, blue: 0.18, alpha: 0.96)
        banner.layer.cornerRadius = 16.0
        banner.layer.borderWidth = 1.0
        banner.layer.borderColor = UIColor.white.withAlphaComponent(0.22).cgColor
        banner.layer.shadowColor = UIColor.black.cgColor
        banner.layer.shadowOpacity = 0.35
        banner.layer.shadowRadius = 10.0
        banner.layer.shadowOffset = CGSize(width: 0, height: 4)
        banner.autoresizingMask = [.flexibleLeftMargin, .flexibleRightMargin, .flexibleTopMargin]

        let pickerBg = UIView(frame: CGRect(x: 12.0, y: 14.0, width: 44.0, height: 44.0))
        pickerBg.backgroundColor = UIColor(red: 0.06, green: 0.72, blue: 0.51, alpha: 1.0)
        pickerBg.layer.cornerRadius = 22.0
        banner.addSubview(pickerBg)

        let visiblePicker = RPSystemBroadcastPickerView(frame: pickerBg.bounds)
        visiblePicker.preferredExtension = resolveBroadcastExtensionBundleId()
        visiblePicker.showsMicrophoneButton = false
        pickerBg.addSubview(visiblePicker)

        let hasExt = hasBroadcastExtension()
        let label = UILabel(frame: CGRect(x: 66.0, y: 10.0, width: barW - 106.0, height: 52.0))
        label.numberOfLines = 2
        label.font = UIFont.systemFont(ofSize: 12.0, weight: .bold)
        label.textColor = .white
        label.text = hasExt
            ? "若未跳出系統選單，請點左側綠色圖示並選擇「開始廣播」"
            : "找不到 BroadcastUpload 擴充（側載請保留 PlugIns 或注意 3 App ID 限制）"
        banner.addSubview(label)

        let closeBtn = UIButton(type: .system)
        closeBtn.frame = CGRect(x: barW - 34.0, y: 8.0, width: 26.0, height: 26.0)
        closeBtn.setTitle("✕", for: .normal)
        closeBtn.titleLabel?.font = UIFont.systemFont(ofSize: 12.0, weight: .bold)
        closeBtn.setTitleColor(.white, for: .normal)
        closeBtn.backgroundColor = UIColor.white.withAlphaComponent(0.16)
        closeBtn.layer.cornerRadius = 13.0
        closeBtn.addTarget(self, action: #selector(handleDismissBroadcastHelperBanner), for: .touchUpInside)
        banner.addSubview(closeBtn)

        rootView.addSubview(banner)
        rootView.bringSubviewToFront(banner)
        broadcastPickerOverlayView = banner
    }

    @discardableResult
    private func triggerSystemBroadcastPicker(in rootView: UIView) -> Bool {
        ensureBroadcastHelperBanner(in: rootView)

        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        picker.preferredExtension = resolveBroadcastExtensionBundleId()
        picker.showsMicrophoneButton = false
        picker.alpha = 0.015
        rootView.addSubview(picker)
        picker.layoutIfNeeded()

        var triggered = false
        if let button = findButton(in: picker) {
            button.sendActions(for: .touchUpInside)
            triggered = true
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 12.0) {
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

            self.probeAppGroupCapability()
            self.startLoopbackServerIfNeeded()
            self.registerDarwinObserverIfNeeded()
            self.registerIpcWakeDarwinObserverIfNeeded()
            self.registerLocalBroadcastDarwinObserversIfNeeded()
            self.shouldTriggerPickerAfterPip = true
            self.hasTriggeredBroadcastPicker = false
            self.lastSourceSubtitle = ""
            UIApplication.shared.isIdleTimerDisabled = true

            var pipStarted = false
            if AVPictureInPictureController.isPictureInPictureSupported() {
                self.setupAudioSessionAndKeepAlive()
                self.setupPipControllerIfNeeded(initialText: effectiveInitial)
                let shouldResetSubtitle = !self.lastBroadcastActive || self.lastRenderedSubtitle.isEmpty || self.lastRenderedSubtitle == self.defaultInitialText
                if shouldResetSubtitle {
                    self.sharedDefaults.set(effectiveInitial, forKey: "lzh_latest_pip_subtitle")
                    self.sharedDefaults.synchronize()
                    self.writeSharedBridgeState(merging: [
                        "subtitle": effectiveInitial,
                        "subtitleUpdatedAt": Date().timeIntervalSince1970
                    ])
                    self.renderSubtitleTextToPip(effectiveInitial)
                    self.startDynamicIslandLiveActivity(initialText: effectiveInitial)
                }
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
                self.startDynamicIslandLiveActivity(initialText: effectiveInitial)
                self.triggerSystemBroadcastPicker(in: rootView)
            }

            self.configLock.lock()
            let currentMode = self.detectedIpcMode
            let currentPort = Int(self.activeLoopbackPort)
            self.configLock.unlock()

            call.resolve([
                "started": pipStarted,
                "triggered": true,
                "pipSupported": AVPictureInPictureController.isPictureInPictureSupported(),
                "ipcMode": currentMode,
                "loopbackPort": currentPort
            ])
        }
    }

    @objc func showBroadcastPicker(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let rootView = self.bridge?.viewController?.view else {
                call.reject("Root view unavailable")
                return
            }

            self.probeAppGroupCapability()
            self.startLoopbackServerIfNeeded()
            self.registerDarwinObserverIfNeeded()
            self.registerIpcWakeDarwinObserverIfNeeded()
            self.registerLocalBroadcastDarwinObserversIfNeeded()
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

            self.probeAppGroupCapability()
            self.startLoopbackServerIfNeeded()
            self.registerDarwinObserverIfNeeded()
            self.registerIpcWakeDarwinObserverIfNeeded()
            self.registerLocalBroadcastDarwinObserversIfNeeded()
            self.shouldTriggerPickerAfterPip = false
            self.setupAudioSessionAndKeepAlive()
            self.setupPipControllerIfNeeded(initialText: effectiveInitial)
            let shouldResetSubtitle = !self.lastBroadcastActive || self.lastRenderedSubtitle.isEmpty || self.lastRenderedSubtitle == self.defaultInitialText
            if shouldResetSubtitle {
                self.sharedDefaults.set(effectiveInitial, forKey: "lzh_latest_pip_subtitle")
                self.sharedDefaults.synchronize()
                self.writeSharedBridgeState(merging: [
                    "subtitle": effectiveInitial,
                    "subtitleUpdatedAt": Date().timeIntervalSince1970
                ])
                self.renderSubtitleTextToPip(effectiveInitial)
            }
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

    @objc func syncEcosystemSnapshot(_ call: CAPPluginCall) {
        let dueCount = call.getInt("dueCount") ?? 0
        let streakDays = call.getInt("streakDays") ?? 0
        let totalWords = call.getInt("totalWords") ?? 0
        let featuredWord = (call.getString("featuredWord") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let featuredMeaning = (call.getString("featuredMeaning") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        let snap = LzhSharedEcosystemStore.StudySnapshot(
            dueCount: max(0, dueCount),
            streakDays: max(0, streakDays),
            totalWords: max(0, totalWords),
            featuredWord: featuredWord,
            featuredMeaning: featuredMeaning,
            updatedAt: Date().timeIntervalSince1970
        )
        LzhSharedEcosystemStore.saveSnapshot(snap)

        #if canImport(WidgetKit)
        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadAllTimelines()
        }
        #endif

        call.resolve(["synced": true])
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

        if audioRouteObserver == nil {
            audioRouteObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.routeChangeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard let self = self, self.pipController != nil else { return }
                try? AVAudioSession.sharedInstance().setActive(true)
                if let player = self.silentAudioPlayer, !player.isPlaying {
                    player.play()
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
        UIApplication.shared.isIdleTimerDisabled = false
        removeBroadcastHelperBanner()
        endDynamicIslandLiveActivity()
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
        lastBroadcastActive = false
        lastSourceSubtitle = ""
        lastRenderedSubtitle = ""
        notifyListeners("pipStateChanged", data: ["active": false])
    }

    private func startDynamicIslandLiveActivity(initialText: String) {
        LzhSharedEcosystemStore.setSubtitlePaused(false)
        #if canImport(ActivityKit)
        if #available(iOS 16.1, *) {
            LzhLiveActivityCoordinator.shared.startOrUpdate(
                sourceText: lastSourceSubtitle,
                translatedText: initialText,
                statusLabel: "PiP 待命",
                isActive: true,
                isPaused: false,
                sourceLang: (currentConfigDictionary()["sourceLang"] as? String) ?? "en"
            )
        }
        #endif
    }

    private func updateDynamicIslandLiveActivity(sourceText: String, translatedText: String, statusLabel: String, isActive: Bool, isPaused: Bool? = nil) {
        let pausedNow = isPaused ?? LzhSharedEcosystemStore.isSubtitlePaused()
        #if canImport(ActivityKit)
        if #available(iOS 16.1, *) {
            LzhLiveActivityCoordinator.shared.startOrUpdate(
                sourceText: sourceText,
                translatedText: translatedText,
                statusLabel: pausedNow ? "⏸ 已暫停" : statusLabel,
                isActive: isActive,
                isPaused: pausedNow,
                sourceLang: (currentConfigDictionary()["sourceLang"] as? String) ?? "en"
            )
        }
        #endif
    }

    private func endDynamicIslandLiveActivity() {
        LzhSharedEcosystemStore.setSubtitlePaused(false)
        #if canImport(ActivityKit)
        if #available(iOS 16.1, *) {
            LzhLiveActivityCoordinator.shared.endAll()
        }
        #endif
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
        if let ackToken = bridgeState["extAckSessionToken"] as? String,
           !ackToken.isEmpty,
           ackToken == hostSessionToken {
            configLock.lock()
            let wasVerified = appGroupHandshakeVerified
            appGroupHandshakeVerified = true
            detectedIpcMode = "app_group"
            lastConnectedVia = "app_group"
            configLock.unlock()
            if !wasVerified {
                emitIpcStatusChanged()
            }
        }

        let bcActive = (bridgeState["broadcastActive"] as? Bool) ?? sharedDefaults.bool(forKey: "lzh_broadcast_active")
        let bridgeSubtitle = (bridgeState["subtitle"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let bridgeOcr = (bridgeState["ocrText"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let needsHostTrans = (bridgeState["needsHostTranslation"] as? Bool) ?? false

        if bcActive != lastBroadcastActive {
            lastBroadcastActive = bcActive
            notifyListeners("broadcastStateChanged", data: [
                "active": bcActive,
                "message": bridgeSubtitle
            ])
        }
        if bcActive {
            removeBroadcastHelperBanner()
        }

        if let bridgeSeq = bridgeState["ocrSeq"] as? Int,
           bridgeSeq > lastHandledBridgeSeq,
           !bridgeOcr.isEmpty {
            lastHandledBridgeSeq = bridgeSeq
            lastSourceSubtitle = bridgeOcr
            notifyListeners("ocrCaptured", data: ["text": bridgeOcr])
            if !needsHostTrans && !bridgeSubtitle.isEmpty {
                renderSubtitleTextToPip(bridgeSubtitle, sourceText: bridgeOcr)
                notifyListeners("subtitleTranslated", data: [
                    "sourceText": bridgeOcr,
                    "translatedText": bridgeSubtitle
                ])
                updateDynamicIslandLiveActivity(
                    sourceText: bridgeOcr,
                    translatedText: bridgeSubtitle,
                    statusLabel: bcActive ? "廣播翻譯中" : "翻譯完成",
                    isActive: bcActive
                )
                return
            }
            if !isTranslatingOcr {
                translateCapturedTextForPip(bridgeOcr)
                return
            }
        }

        if !bridgeSubtitle.isEmpty, bridgeSubtitle != lastRenderedSubtitle {
            renderSubtitleTextToPip(bridgeSubtitle, sourceText: lastSourceSubtitle)
            updateDynamicIslandLiveActivity(
                sourceText: lastSourceSubtitle,
                translatedText: bridgeSubtitle,
                statusLabel: bcActive ? "廣播翻譯中" : "待機中",
                isActive: bcActive
            )
        }

        let defaults = sharedDefaults
        let seq = defaults.integer(forKey: "lzh_latest_ocr_seq")
        let ocrText = (defaults.string(forKey: "lzh_latest_ocr_text") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        if seq > lastHandledOcrSeq, !ocrText.isEmpty, !isTranslatingOcr {
            lastHandledOcrSeq = seq
            lastSourceSubtitle = ocrText
            notifyListeners("ocrCaptured", data: ["text": ocrText])
            translateCapturedTextForPip(ocrText)
            return
        }

        let latestPip = (defaults.string(forKey: "lzh_latest_pip_subtitle") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !latestPip.isEmpty && latestPip != lastRenderedSubtitle {
            renderSubtitleTextToPip(latestPip, sourceText: lastSourceSubtitle)
        }
    }

    private func publishHostTranslatedSubtitle(_ translated: String, sourceText: String) {
        let clean = translated.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        lastSourceSubtitle = sourceText
        if !sourceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            LzhSharedEcosystemStore.saveLatestSubtitle(source: sourceText, translated: clean)
        }
        sharedDefaults.set(clean, forKey: "lzh_latest_pip_subtitle")
        sharedDefaults.synchronize()
        writeSharedBridgeState(merging: [
            "subtitle": clean,
            "ocrText": sourceText,
            "needsHostTranslation": false,
            "subtitleUpdatedAt": Date().timeIntervalSince1970
        ])
        renderSubtitleTextToPip(clean, sourceText: sourceText)
        notifyListeners("subtitleTranslated", data: [
            "sourceText": sourceText,
            "translatedText": clean
        ])
        updateDynamicIslandLiveActivity(
            sourceText: sourceText,
            translatedText: clean,
            statusLabel: lastBroadcastActive ? "廣播翻譯中" : "翻譯完成",
            isActive: true
        )
    }

    private func translateCapturedTextForPip(_ sourceText: String) {
        isTranslatingOcr = true
        let cfg = currentConfigDictionary()
        let engine = (cfg["engine"] as? String) ?? "apple_offline"
        let sourceLang = (cfg["sourceLang"] as? String) ?? "en"
        let targetLang = (cfg["targetLang"] as? String) ?? "zh-Hant"

        #if canImport(Translation)
        if engine == "apple_offline" {
            if #available(iOS 26.0, *) {
                Task { [weak self] in
                    guard let self = self else { return }
                    let translated = await self.translateWithAppleOffline(text: sourceText, from: sourceLang, to: targetLang)
                    await MainActor.run {
                        self.isTranslatingOcr = false
                        if let out = translated, !out.isEmpty {
                            self.publishHostTranslatedSubtitle(out, sourceText: sourceText)
                        } else {
                            self.translateViaCloudFallback(sourceText)
                        }
                    }
                }
                return
            }
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
        let authToken = ((cfg["authToken"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let sourceLang = (cfg["sourceLang"] as? String) ?? "auto"

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
        fastCloudSession.dataTask(with: req) { [weak self] data, _, _ in
            var translated = ""
            if let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let tr = json["translation"] as? String {
                translated = tr.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if !translated.isEmpty {
                DispatchQueue.main.async {
                    self?.isTranslatingOcr = false
                    self?.publishHostTranslatedSubtitle(translated, sourceText: sourceText)
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
        fastCloudSession.dataTask(with: url) { [weak self] data, _, _ in
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
                    self?.publishHostTranslatedSubtitle(translated, sourceText: sourceText)
                }
            }
        }.resume()
    }

    private func renderSubtitleTextToPip(_ text: String, sourceText: String? = nil) {
        guard let layer = sampleLayer else { return }
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        lastRenderedSubtitle = clean
        if let src = sourceText?.trimmingCharacters(in: .whitespacesAndNewlines), !src.isEmpty {
            lastSourceSubtitle = src
        }

        guard let buffer = createSubtitleSampleBuffer(
            text: clean,
            sourceText: lastSourceSubtitle,
            width: pipWidthPx,
            height: pipHeightPx
        ) else {
            return
        }
        if layer.status == .failed || !layer.isReadyForMoreMediaData {
            layer.flush()
        }
        layer.enqueue(buffer)
    }

    private func createSubtitleSampleBuffer(text: String, sourceText: String = "", width: Int, height: Int) -> CMSampleBuffer? {
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
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.lineSpacing = 3

        let cleanSrc = sourceText.trimmingCharacters(in: .whitespacesAndNewlines)
        let insetRect = fullRect.insetBy(dx: 24, dy: 14)

        if !cleanSrc.isEmpty && cleanSrc != text {
            let srcAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 14.0, weight: .medium),
                .foregroundColor: UIColor(white: 0.78, alpha: 0.9),
                .paragraphStyle: paragraph
            ]
            let transFontSize: CGFloat = text.count > 44 ? 19.0 : (text.count > 24 ? 22.0 : 25.0)
            let transAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: transFontSize, weight: .bold),
                .foregroundColor: UIColor.white,
                .paragraphStyle: paragraph
            ]
            let combined = NSMutableAttributedString(string: cleanSrc + "\n", attributes: srcAttrs)
            combined.append(NSAttributedString(string: text, attributes: transAttrs))
            let textBounds = combined.boundingRect(
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
            combined.draw(with: centeredRect, options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
        } else {
            let fontSize: CGFloat = text.count > 44 ? 20.0 : (text.count > 24 ? 23.0 : 27.0)
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: fontSize, weight: .bold),
                .foregroundColor: UIColor.white,
                .paragraphStyle: paragraph
            ]
            let attrStr = NSAttributedString(string: text, attributes: attributes)
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
        }

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

#if canImport(ActivityKit)
@available(iOS 16.1, *)
private final class LzhLiveActivityCoordinator {
    static let shared = LzhLiveActivityCoordinator()
    private var currentActivity: Activity<LzhTranslateActivityAttributes>?

    private init() {}

    func startOrUpdate(
        sourceText: String,
        translatedText: String,
        statusLabel: String,
        isActive: Bool,
        isPaused: Bool = false,
        sourceLang: String
    ) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let state = LzhTranslateActivityAttributes.ContentState(
            sourceText: sourceText,
            translatedText: translatedText,
            statusLabel: statusLabel,
            isActive: isActive,
            isPaused: isPaused,
            sourceLang: sourceLang,
            updatedAt: Date().timeIntervalSince1970
        )

        if let act = currentActivity ?? Activity<LzhTranslateActivityAttributes>.activities.first {
            currentActivity = act
            Task {
                await act.update(using: state)
            }
            return
        }

        do {
            let attrs = LzhTranslateActivityAttributes(sessionTitle: "LZHCard 即時字幕")
            currentActivity = try Activity<LzhTranslateActivityAttributes>.request(
                attributes: attrs,
                contentState: state,
                pushType: nil
            )
        } catch {
            currentActivity = nil
        }
    }

    func endAll() {
        let finalState = LzhTranslateActivityAttributes.ContentState(
            sourceText: "",
            translatedText: "字幕識別已關閉",
            statusLabel: "已結束",
            isActive: false,
            isPaused: false,
            sourceLang: "en",
            updatedAt: Date().timeIntervalSince1970
        )
        Task {
            for act in Activity<LzhTranslateActivityAttributes>.activities {
                await act.end(using: finalState, dismissalPolicy: .immediate)
            }
            currentActivity = nil
        }
    }
}
#endif

#if canImport(Translation)
@available(iOS 18.0, *)
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

@available(iOS 18.0, *)
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
