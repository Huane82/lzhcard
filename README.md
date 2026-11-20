# Sideloadly IPA Installation & Auto Refresh Guide
# Sideloadly IPA 安裝與自動續簽教學
# Sideloadly IPA インストール・自動更新ガイド

**Windows 11 + iPhone + Free Apple ID + Sideloadly**

| Language | 語言 | 言語 |
|---|---|---|
| 繁體中文 | Traditional Chinese | 繁体字中国語 |
| English | English | 英語 |
| 日本語 | Japanese | 日本語 |

---

# 目錄 / Table of Contents / 目次

- [繁體中文](#繁體中文)
- [English](#english)
- [日本語](#日本語)

---

# 繁體中文

## 1. 專案介紹

本教學介紹如何使用 Windows 電腦、免費 Apple ID 與 Sideloadly，在 iPhone 上安裝 IPA 檔案，並設定 Auto Refresh 自動續簽功能。

本方法不需要 Mac、不需要越獄，也不需要購買 Apple 開發者帳號。

### 主要特色

- 完全免費。
- 不需要 Mac。
- 不需要越獄。
- 不需要付費 Apple Developer 帳號。
- 支援 IPA 安裝與簽署。
- 支援 Auto Refresh 自動續簽。
- 支援 USB 與 Wi-Fi 裝置連線。
- 適用於 Windows 10 / 11。

## 2. 系統需求

| 項目 | 需求 |
|---|---|
| 電腦 | Windows 10 / 11 |
| 手機 | iPhone |
| iOS | iOS 26 等相容版本 |
| Apple ID | 免費 Apple ID |
| IPA | 已準備好的 IPA 檔案 |
| USB 線 | 支援資料傳輸 |
| 網路 | 網際網路連線 |

本教學以 Windows 11、iPhone 15 Pro Max、iOS 26 為操作環境。

Sideloadly 官方表示支援 iOS 7 至 iOS 27+。實際安裝仍取決於 IPA 本身的相容性。

## 3. 下載必要軟體

### 3.1 Sideloadly

用途：
- 安裝 IPA。
- 使用 Apple ID 簽署應用程式。
- 自動刷新應用程式簽署期限。
- 管理側載應用程式。

官方網站：

https://sideloadly.io/

### 3.2 iTunes for Windows（桌面版）

用途：
- 協助 Windows 辨識 iPhone。
- 安裝 Apple 裝置相關元件。
- 設定 Wi-Fi 同步。
- 協助裝置配對。

官方下載：

https://www.apple.com/itunes/download/win64

**重要：必須使用 Apple 網站提供的桌面版 iTunes，不要使用 Microsoft Store 版本。**

### 3.3 iCloud for Windows（桌面安裝版）

用途：
- 提供 Sideloadly 所需的 Apple 相關元件。
- 協助 Windows 環境與 Apple 服務整合。

官方下載入口：

https://sideloadly.io/

進入網站後，找到 Windows 安裝區域中的：

**Web iCloud**

請使用 Sideloadly 官方提供的非 Microsoft Store 安裝版本。

Apple 官方 iCloud 說明：

https://support.apple.com/zh-tw/103232

**重要注意事項：**

- iCloud for Windows 是 Windows 專用程式，不是 Mac 版本。
- 不要下載 macOS 版 iCloud。
- 不要使用 Microsoft Store 版 iCloud。
- 如果已安裝 Microsoft Store 版，建議先解除安裝，再安裝相容的桌面版。
- 不要同時保留兩種版本，以免產生元件衝突。

### 3.4 軟體下載總表

| 軟體 | 版本要求 | 官方來源 |
|---|---|---|
| Sideloadly | Windows 版 | https://sideloadly.io/ |
| iTunes | Web / Desktop 版 | https://www.apple.com/itunes/download/win64 |
| iCloud | Web / Desktop 版 | https://sideloadly.io/ |

## 4. 安裝前準備

### 4.1 安裝順序

1. 如果已安裝 Microsoft Store 版 iTunes，先解除安裝。
2. 如果已安裝 Microsoft Store 版 iCloud，先解除安裝。
3. 下載並安裝 Apple 網站提供的桌面版 iTunes。
4. 從 Sideloadly 官方網站下載 Web iCloud。
5. 安裝 iCloud。
6. 安裝 Sideloadly。
7. 重新啟動 Windows。

### 4.2 連接 iPhone

1. 使用 USB 傳輸線連接 iPhone。
2. 解鎖 iPhone。
3. 出現「信任此電腦」時，選擇「信任」。
4. 開啟 iTunes。
5. 確認 iTunes 能辨識 iPhone。
6. 開啟 Sideloadly。
7. 確認裝置出現在 Device 欄位。

### 4.3 如果無法辨識 iPhone

請檢查：

- USB 線是否支援資料傳輸。
- iPhone 是否已解鎖。
- 是否已信任電腦。
- 是否使用 Apple 官方桌面版 iTunes。
- 是否安裝正確的 iCloud 版本。
- Apple 裝置相關服務是否正常。

## 5. 第一次安裝 IPA

### 5.1 主畫面設定

1. 開啟 Sideloadly。
2. 使用 USB 連接 iPhone。
3. 在 Device 欄位選擇 iPhone。
4. 將 IPA 檔案拖曳至左側 IPA 圖示。
5. 確認 Apple ID。
6. 確認 IPA 檔案已正確載入。
7. 確認安裝選項。
8. 點擊 Start。
9. 等待安裝完成。

### 5.2 Advanced Options 建議設定

| 選項 | 建議 |
|---|---|
| Try to support older iOS versions | 不勾選 |
| Remove limitation on supported devices | 不勾選，除非遇到裝置限制錯誤 |
| Enable File Sharing | 不勾選 |
| Change app name | 不勾選 |
| Change app version | 不勾選 |
| Use automatic bundle ID | 保持預設 |
| Use custom entitlements | 不勾選 |
| Inject dylibs/frameworks | 不勾選 |

一般 IPA 安裝不需要修改這些選項。

### 5.3 Settings 建議設定

| 設定 | 建議 |
|---|---|
| Anisette Authentication | Auto |
| Signing Mode | Apple ID Sideload |
| Ignore pre-flight binary errors | 不勾選 |
| Dynamic upload | 不勾選 |
| Custom upload chunk size | 不勾選 |

完成後按下 OK。

### 5.4 安全注意事項

- 建議使用專門用於側載的 Apple ID。
- 建議開啟雙重認證。
- 不要將 Apple ID 密碼提供給不明第三方。
- 驗證碼應透過 Apple 官方驗證流程處理。
- 只安裝來自可信任來源的 IPA。

## 6. 設定 Auto Refresh 自動續簽

這是本教學最重要的功能。

Sideloadly 提供 Automatic App Refresh 功能，透過背景服務 Sideloadly Daemon 管理已登記的應用程式。

### 6.1 啟用自動刷新

1. 開啟 Sideloadly。
2. 將 IPA 載入主畫面。
3. 確認裝置及 Apple ID。
4. 找到安裝時的 Automatic Refresh 選項。
5. 啟用 Automatic Refresh。
6. 點擊 Start。
7. 等待安裝及簽署完成。

注意：Automatic Refresh 是側載時的功能，不是在 Anisette Authentication 或 Signing Mode 裡設定。

### 6.2 Sideloadly Daemon

Daemon 是負責自動續簽的背景服務。

主要功能：

- 管理已登記的 App。
- 檢查 App 的簽署期限。
- 在 App 接近過期時嘗試刷新簽署。
- 透過 USB 或 Wi-Fi 偵測 iPhone。
- 管理已啟用自動刷新的應用程式。

### 6.3 自動續簽必要條件

- Windows 電腦必須正常運作。
- Sideloadly Daemon 必須正常執行。
- iPhone 必須能透過 USB 或 Wi-Fi 被偵測到。
- 電腦必須有網際網路連線。
- 建議完成 Wi-Fi 配對。

自動刷新不是永久簽署，也不保證所有情況都能成功。

如果電腦關機，Daemon 就無法在該期間執行續簽。

官方 FAQ：

https://sideloadly.io/faq.html

## 7. 設定 Wi-Fi 無線連線

Wi-Fi 配對可以讓 Sideloadly 在不插 USB 的情況下偵測 iPhone。

### 7.1 初次配對

1. 使用 USB 連接 iPhone。
2. 確認 Windows 已辨識 iPhone。
3. 開啟 iTunes。
4. 點擊 iPhone 裝置圖示。
5. 進入裝置摘要頁面。
6. 找到「透過 Wi-Fi 與此 iPhone 同步」。
7. 勾選該選項。
8. 點擊套用或同步。
9. 確認 iPhone 和 Windows 位於同一個 Wi-Fi 網路。

### 7.2 Wi-Fi 偵測條件

- Windows 與 iPhone 必須位於相同網路。
- Windows 必須保持運作。
- iPhone 必須能被網路偵測到。
- 某些情況下需要開啟 iTunes。
- iPhone 螢幕需要保持開啟，才能讓 Sideloadly 偵測到無線裝置。

### 7.3 Wi-Fi 偵測失敗

如果無法透過 Wi-Fi 偵測：

1. 確認兩台裝置使用同一個 Wi-Fi。
2. 開啟 iTunes。
3. 確認已完成 Wi-Fi 同步設定。
4. 確認 Bonjour 服務正常。
5. 重新啟動 Sideloadly。
6. 必要時改用 USB。

官方說明：

https://sideloadly.io/faq.html

## 8. iPhone 端設定

### 8.1 信任開發者憑證

如果 iPhone 顯示未受信任的開發者：

前往：

設定 → 一般 → VPN 與裝置管理

找到使用的 Apple ID，選擇信任。

### 8.2 開啟開發者模式

iOS 16 或更新版本，如果系統要求：

設定 → 隱私權與安全性 → 開發者模式

依照畫面指示重新啟動 iPhone。

並非所有情況都需要手動開啟，請依照系統提示操作。

## 9. 免費 Apple ID 的限制

| 項目 | 免費帳號 |
|---|---|
| App 簽署期限 | 通常 7 天 |
| 同時側載 App | 最多 3 個 |
| 付費 Apple Developer 帳號 | 不需要 |
| Mac | 不需要 |
| 越獄 | 不需要 |
| 自動續簽 | 支援，但有條件限制 |

### 9.1 為什麼只有 7 天？

免費 Apple Developer 帳號簽署的側載 App 通常只能使用 7 天。

期限到達後，如果沒有成功刷新簽署，App 可能無法開啟。

### 9.2 如何降低過期風險？

1. 確認 Automatic Refresh 已啟用。
2. 確認 Sideloadly Daemon 正常執行。
3. 定期讓 Windows 保持開機及網路連線。
4. 讓 iPhone 能透過 USB 或 Wi-Fi 被偵測。
5. 在到期前確認自動刷新是否成功。
6. 如果失敗，使用 USB 重新簽署。

## 10. 常見問題與故障排除

### Q1：Sideloadly 找不到 iPhone？

可能原因：

- USB 線不支援資料傳輸。
- 尚未信任電腦。
- iTunes 或 Apple 驅動程式安裝不完整。
- 使用 Microsoft Store 版 iTunes。
- iCloud 安裝版本不相容。

解決方式：

1. 更換 USB 線或連接埠。
2. 重新連接 iPhone。
3. 確認 iTunes 能辨識手機。
4. 移除 Microsoft Store 版 iTunes 和 iCloud。
5. 安裝 Apple 網站提供的桌面版元件。
6. 重新啟動 Windows。

### Q2：出現 No devices detected？

建議：

1. 重新安裝 Web 版 iTunes。
2. 重新安裝 Web 版 iCloud。
3. 重新啟動 Windows。
4. 連接 iPhone 並在手機上選擇信任。
5. 開啟 iTunes 並同步裝置。

### Q3：IPA 安裝成功，但 App 無法開啟？

可能原因：

- 尚未信任開發者憑證。
- 簽署期限已過。
- IPA 與 iOS 版本不相容。
- IPA 本身損壞。
- IPA 的架構不符合裝置需求。

解決方式：

1. 檢查 VPN 與裝置管理。
2. 確認簽署期限。
3. 確認 IPA 支援目前的 iOS。
4. 必要時重新簽署。

### Q4：7 天後 App 失效？

通常代表簽署期限已到，或自動刷新沒有成功。

解決方式：

1. 開啟 Windows。
2. 確認 Daemon 正常執行。
3. 連接 iPhone。
4. 確認裝置能被偵測。
5. 使用 Sideloadly 重新簽署。

### Q5：可以完全不開電腦嗎？

不行。

Sideloadly Auto Refresh 依賴 Windows 背景服務。電腦關機時，Daemon 無法執行續簽。

### Q6：可以不使用 USB 嗎？

可以，但必須先完成 USB 初次配對及 Wi-Fi 同步設定。

之後在相同網路環境下，可以嘗試透過 Wi-Fi 偵測裝置。

### Q7：免費帳號可以安裝多少個 App？

免費 Apple ID 通常最多同時側載 3 個 App。

### Q8：更新 IPA 會不會刪除原本的 App？

使用相同 Apple ID 和相同 Bundle ID 重新側載時，Sideloadly 可以覆蓋原本的 App。

建議事先備份重要資料。

## 11. 官方資源

- Sideloadly：https://sideloadly.io/
- Sideloadly FAQ：https://sideloadly.io/faq.html
- Sideloadly Changelog：https://sideloadly.io/changelog.html
- iTunes：https://www.apple.com/itunes/download/win64
- Apple iCloud：https://support.apple.com/zh-tw/103232

---

# English

## 1. Introduction

This guide explains how to install IPA files on an iPhone using Windows, a free Apple ID, and Sideloadly.

It also explains how to configure Auto Refresh to reduce the need for manual re-signing every seven days.

No Mac, jailbreak, or paid Apple Developer account is required.

### Features

- Completely free.
- No Mac required.
- No jailbreak required.
- No paid Apple Developer account required.
- IPA installation and signing.
- Automatic app refreshing.
- USB and Wi-Fi device connectivity.
- Windows 10 / 11 support.

## 2. System Requirements

| Item | Requirement |
|---|---|
| Computer | Windows 10 / 11 |
| Device | iPhone |
| iOS | iOS 26 and other supported versions |
| Apple ID | Free Apple ID |
| IPA | Existing IPA file |
| USB cable | Data-capable USB cable |
| Internet | Internet connection |

This guide uses Windows 11, iPhone 15 Pro Max, and iOS 26 as the reference environment.

Sideloadly officially supports iOS 7 through iOS 27+. Actual installation compatibility also depends on the IPA file.

## 3. Required Software

### 3.1 Sideloadly

Used for:
- IPA installation.
- Apple ID signing.
- Automatic app refreshing.
- Sideloaded app management.

Official website:

https://sideloadly.io/

### 3.2 iTunes for Windows (Desktop Version)

Used for:
- iPhone device recognition.
- Apple device components.
- Wi-Fi synchronization.
- Device pairing.

Official download:

https://www.apple.com/itunes/download/win64

**Important: Use the desktop version from Apple's website, not the Microsoft Store version.**

### 3.3 iCloud for Windows (Desktop Installer)

Used for:
- Providing Apple-related components required by Sideloadly.
- Supporting integration between Windows and Apple services.

Official download entry:

https://sideloadly.io/

Open the Windows download section and locate:

**Web iCloud**

Use the non-Microsoft Store installer provided through Sideloadly's official website.

Apple support:

https://support.apple.com/icloud

**Important:**
- iCloud for Windows is designed for Windows computers.
- Do not download the macOS version.
- Do not use the Microsoft Store version.
- If the Microsoft Store version is installed, uninstall it before installing the compatible desktop version.
- Avoid keeping both versions installed simultaneously.

### 3.4 Software Download Summary

| Software | Required Version | Official Source |
|---|---|---|
| Sideloadly | Windows version | https://sideloadly.io/ |
| iTunes | Web / Desktop version | https://www.apple.com/itunes/download/win64 |
| iCloud | Web / Desktop version | https://sideloadly.io/ |

## 4. Preparation

### 4.1 Installation Order

1. Uninstall Microsoft Store iTunes if installed.
2. Uninstall Microsoft Store iCloud if installed.
3. Download and install Apple's desktop version of iTunes.
4. Download Web iCloud from Sideloadly's official website.
5. Install iCloud.
6. Install Sideloadly.
7. Restart Windows.

### 4.2 Connect Your iPhone

1. Connect your iPhone using a USB cable.
2. Unlock your iPhone.
3. Tap **Trust This Computer** when prompted.
4. Open iTunes.
5. Make sure iTunes recognizes your iPhone.
6. Open Sideloadly.
7. Verify that your device appears in the Device field.

### 4.3 If Your iPhone Is Not Detected

Check the following:

- Whether the USB cable supports data transfer.
- Whether your iPhone is unlocked.
- Whether the computer has been trusted.
- Whether Apple's desktop version of iTunes is installed.
- Whether the correct iCloud version is installed.
- Whether Apple device services are running.

## 5. Install an IPA File

### 5.1 Main Interface

1. Launch Sideloadly.
2. Connect your iPhone via USB.
3. Select your iPhone under Device.
4. Drag the IPA file onto the IPA icon.
5. Verify your Apple ID.
6. Make sure the IPA file has loaded.
7. Check the installation options.
8. Click Start.
9. Wait for the installation to complete.

### 5.2 Recommended Advanced Options

| Option | Recommendation |
|---|---|
| Try to support older iOS versions | Disabled |
| Remove limitation on supported devices | Disabled unless a device limitation error occurs |
| Enable File Sharing | Disabled |
| Change app name | Disabled |
| Change app version | Disabled |
| Use automatic bundle ID | Default |
| Use custom entitlements | Disabled |
| Inject dylibs/frameworks | Disabled |

Most IPA installations do not require changes to these options.

### 5.3 Recommended Settings

| Setting | Recommendation |
|---|---|
| Anisette Authentication | Auto |
| Signing Mode | Apple ID Sideload |
| Ignore pre-flight binary errors | Disabled |
| Dynamic upload | Disabled |
| Custom upload chunk size | Disabled |

Click OK when finished.

### 5.4 Security Recommendations

- Consider using a dedicated Apple ID for sideloading.
- Enable two-factor authentication.
- Never share your Apple ID password with untrusted third parties.
- Complete verification through Apple's official authentication process.
- Only install IPA files from trusted sources.

## 6. Configure Auto Refresh

This is the most important feature in this guide.

Sideloadly provides Automatic App Refresh, managed by the background service called Sideloadly Daemon.

### 6.1 Enable Automatic Refresh

1. Open Sideloadly.
2. Load your IPA file.
3. Verify your device and Apple ID.
4. Locate the Automatic Refresh option during installation.
5. Enable Automatic Refresh.
6. Click Start.
7. Wait for signing and installation to finish.

Note: Automatic Refresh is an option during sideloading. It is not configured under Anisette Authentication or Signing Mode.

### 6.2 Sideloadly Daemon

Daemon is the background service responsible for automatic app refreshing.

Its functions include:

- Managing enrolled apps.
- Checking app signing expiration.
- Attempting to refresh apps near expiration.
- Detecting iPhones over USB or Wi-Fi.
- Managing apps enrolled for automatic refreshing.

### 6.3 Auto Refresh Requirements

- Windows must be running.
- Sideloadly Daemon must be running.
- The iPhone must be detectable through USB or Wi-Fi.
- The computer must have internet access.
- Wi-Fi pairing is recommended.

Automatic refreshing does not provide permanent signing and is not guaranteed to succeed in every situation.

When the computer is powered off, the Daemon cannot perform refreshing.

Official FAQ:

https://sideloadly.io/faq.html

## 7. Configure Wi-Fi Connectivity

Wi-Fi pairing allows Sideloadly to detect your iPhone without a USB cable.

### 7.1 Initial Pairing

1. Connect your iPhone via USB.
2. Make sure Windows recognizes your iPhone.
3. Open iTunes.
4. Select your iPhone.
5. Open the device summary page.
6. Find **Sync with this iPhone over Wi-Fi**.
7. Enable the option.
8. Click Apply or Sync.
9. Make sure your iPhone and PC are connected to the same Wi-Fi network.

### 7.2 Wi-Fi Detection Requirements

- Windows and iPhone must be on the same network.
- Windows must remain running.
- The iPhone must be discoverable over the network.
- iTunes may need to be open in some situations.
- Keep the iPhone screen on to help Sideloadly detect it wirelessly.

### 7.3 Wi-Fi Detection Troubleshooting

If wireless detection fails:

1. Verify both devices use the same Wi-Fi network.
2. Open iTunes.
3. Check the Wi-Fi synchronization setting.
4. Verify that Bonjour is working.
5. Restart Sideloadly.
6. Use USB if necessary.

Official documentation:

https://sideloadly.io/faq.html

## 8. iPhone Configuration

### 8.1 Trust the Developer Certificate

If iOS reports an untrusted developer:

Navigate to:

Settings → General → VPN & Device Management

Select the corresponding Apple ID developer certificate and tap Trust.

### 8.2 Enable Developer Mode

On iOS 16 or later, if requested:

Settings → Privacy & Security → Developer Mode

Follow the instructions to restart your iPhone.

Manual activation is not required in every situation. Follow the actual iOS prompts.

## 9. Free Apple ID Limitations

| Feature | Free Account |
|---|---|
| App signing validity | Usually 7 days |
| Simultaneous sideloaded apps | Up to 3 |
| Paid Apple Developer account | Not required |
| Mac | Not required |
| Jailbreak | Not required |
| Auto Refresh | Supported, with conditions |

### 9.1 Why Does Signing Last Only 7 Days?

Apps signed with a free Apple Developer account generally remain valid for 7 days.

After expiration, the app may stop launching if its signature has not been successfully refreshed.

### 9.2 How to Reduce Expiration Risks

1. Enable Automatic Refresh.
2. Make sure Sideloadly Daemon is running.
3. Keep Windows powered on and connected to the internet periodically.
4. Make sure your iPhone is detectable via USB or Wi-Fi.
5. Check whether automatic refreshing succeeded before expiration.
6. Re-sign manually via USB if refreshing fails.

## 10. Troubleshooting

### Q1: Sideloadly Cannot Detect My iPhone

Possible causes:

- USB cable does not support data transfer.
- The computer has not been trusted.
- iTunes or Apple drivers are not installed correctly.
- Microsoft Store iTunes is installed.
- The iCloud version is incompatible.

Solutions:

1. Try another USB cable or port.
2. Reconnect your iPhone.
3. Make sure iTunes recognizes your device.
4. Uninstall Microsoft Store iTunes and iCloud.
5. Install the compatible desktop components from Apple's website.
6. Restart Windows.

### Q2: No Devices Detected

Recommended steps:

1. Reinstall Web iTunes.
2. Reinstall Web iCloud.
3. Restart Windows.
4. Connect your iPhone and tap Trust.
5. Open iTunes and sync your device.

### Q3: The Installed App Cannot Open

Possible causes:

- The developer certificate has not been trusted.
- The signing period has expired.
- The IPA is incompatible with your iOS version.
- The IPA file is corrupted.
- The IPA architecture is incompatible with your device.

Solutions:

1. Check VPN & Device Management.
2. Check the signing expiration date.
3. Verify IPA compatibility.
4. Re-sign the IPA if necessary.

### Q4: The App Stops Working After Seven Days

This usually means the signature expired or automatic refreshing failed.

Solutions:

1. Start Windows.
2. Check whether Daemon is running.
3. Connect your iPhone.
4. Verify device detection.
5. Re-sign the app with Sideloadly.

### Q5: Can I Keep My Computer Completely Off?

No.

Sideloadly Auto Refresh depends on a Windows background service. The Daemon cannot refresh apps while the computer is powered off.

### Q6: Can I Avoid Using USB?

Yes, after completing initial USB pairing and Wi-Fi synchronization setup.

Sideloadly can then attempt to detect your iPhone over the same local network.

### Q7: How Many Apps Can I Install With a Free Apple ID?

A free Apple ID generally allows up to 3 simultaneously sideloaded apps.

### Q8: Will Updating an IPA Remove the Existing App?

Sideloadly can overwrite an existing app when using the same Apple ID and Bundle ID.

Back up important data before updating.

## 11. Official Resources

- Sideloadly: https://sideloadly.io/
- Sideloadly FAQ: https://sideloadly.io/faq.html
- Sideloadly Changelog: https://sideloadly.io/changelog.html
- iTunes: https://www.apple.com/itunes/download/win64
- Apple iCloud: https://support.apple.com/icloud

---

# 日本語

## 1. 概要

このガイドでは、Windows PC、無料の Apple ID、Sideloadly を使用して、iPhone に IPA ファイルをインストールする方法を説明します。

また、Auto Refresh（自動更新）を設定し、7 日ごとの手動再署名を減らす方法も紹介します。

Mac、脱獄、有料 Apple Developer アカウントは必要ありません。

### 主な特徴

- 完全無料。
- Mac 不要。
- 脱獄不要。
- 有料 Apple Developer アカウント不要。
- IPA のインストールと署名に対応。
- Auto Refresh に対応。
- USB と Wi-Fi による接続に対応。
- Windows 10 / 11 に対応。

## 2. システム要件

| 項目 | 必要条件 |
|---|---|
| パソコン | Windows 10 / 11 |
| デバイス | iPhone |
| iOS | iOS 26 などの対応バージョン |
| Apple ID | 無料 Apple ID |
| IPA | 用意済みの IPA ファイル |
| USB ケーブル | データ通信対応 |
| インターネット | インターネット接続 |

このガイドでは、Windows 11、iPhone 15 Pro Max、iOS 26 を基準に説明します。

Sideloadly は公式に iOS 7 から iOS 27+ まで対応しています。ただし、実際のインストール可否は IPA ファイルの互換性にも依存します。

## 3. 必要なソフトウェア

### 3.1 Sideloadly

用途：
- IPA のインストール。
- Apple ID による署名。
- アプリの自動更新。
- サイドロードしたアプリの管理。

公式サイト：

https://sideloadly.io/

### 3.2 iTunes for Windows（デスクトップ版）

用途：
- iPhone の認識。
- Apple デバイス関連コンポーネント。
- Wi-Fi 同期。
- デバイスのペアリング。

公式ダウンロード：

https://www.apple.com/itunes/download/win64

**重要：Apple 公式サイトのデスクトップ版を使用してください。Microsoft Store 版は使用しないでください。**

### 3.3 iCloud for Windows（デスクトップインストーラー）

用途：
- Sideloadly が必要とする Apple 関連コンポーネントの提供。
- Windows と Apple サービスの連携。

公式ダウンロード入口：

https://sideloadly.io/

Windows のダウンロード欄から、次の項目を探してください。

**Web iCloud**

Sideloadly 公式サイトから提供される Microsoft Store 以外のインストーラーを使用してください。

Apple 公式サポート：

https://support.apple.com/ja-jp/103232

**重要：**
- iCloud for Windows は Windows 専用アプリです。
- macOS 版をダウンロードしないでください。
- Microsoft Store 版を使用しないでください。
- Microsoft Store 版がインストールされている場合は、互換性のあるデスクトップ版をインストールする前にアンインストールしてください。
- 2 種類のバージョンを同時にインストールしないでください。

### 3.4 ソフトウェア一覧

| ソフトウェア | 必要なバージョン | 公式サイト |
|---|---|---|
| Sideloadly | Windows 版 | https://sideloadly.io/ |
| iTunes | Web / Desktop 版 | https://www.apple.com/itunes/download/win64 |
| iCloud | Web / Desktop 版 | https://sideloadly.io/ |

## 4. インストール前の準備

### 4.1 インストール順序

1. Microsoft Store 版 iTunes があればアンインストールします。
2. Microsoft Store 版 iCloud があればアンインストールします。
3. Apple 公式サイトからデスクトップ版 iTunes をダウンロードしてインストールします。
4. Sideloadly 公式サイトから Web iCloud をダウンロードします。
5. iCloud をインストールします。
6. Sideloadly をインストールします。
7. Windows を再起動します。

### 4.2 iPhone を接続する

1. USB ケーブルで iPhone を接続します。
2. iPhone のロックを解除します。
3. 「このコンピュータを信頼」をタップします。
4. iTunes を開きます。
5. iTunes が iPhone を認識することを確認します。
6. Sideloadly を起動します。
7. Device 欄に iPhone が表示されることを確認します。

### 4.3 iPhone が認識されない場合

以下を確認してください。

- USB ケーブルがデータ通信に対応しているか。
- iPhone のロックが解除されているか。
- コンピュータを信頼しているか。
- Apple 公式デスクトップ版 iTunes がインストールされているか。
- 正しいバージョンの iCloud がインストールされているか。
- Apple 関連サービスが正常に動作しているか。

## 5. IPA ファイルのインストール

### 5.1 メイン画面での操作

1. Sideloadly を起動します。
2. USB で iPhone を接続します。
3. Device 欄で iPhone を選択します。
4. IPA ファイルを左側の IPA アイコンにドラッグ＆ドロップします。
5. Apple ID を確認します。
6. IPA ファイルが正しく読み込まれたことを確認します。
7. インストールオプションを確認します。
8. Start をクリックします。
9. インストールが完了するまで待ちます。

### 5.2 Advanced Options の推奨設定

| オプション | 推奨設定 |
|---|---|
| Try to support older iOS versions | オフ |
| Remove limitation on supported devices | オフ。デバイス制限エラーが発生した場合のみ検討 |
| Enable File Sharing | オフ |
| Change app name | オフ |
| Change app version | オフ |
| Use automatic bundle ID | デフォルト |
| Use custom entitlements | オフ |
| Inject dylibs/frameworks | オフ |

通常の IPA インストールでは、これらの設定を変更する必要はありません。

### 5.3 Settings の推奨設定

| 設定 | 推奨 |
|---|---|
| Anisette Authentication | Auto |
| Signing Mode | Apple ID Sideload |
| Ignore pre-flight binary errors | オフ |
| Dynamic upload | オフ |
| Custom upload chunk size | オフ |

設定後、OK をクリックします。

### 5.4 セキュリティ上の注意

- サイドロード専用の Apple ID の使用を推奨します。
- 2 ファクタ認証を有効にしてください。
- 信頼できない第三者に Apple ID のパスワードを教えないでください。
- 認証は Apple の公式手順に従ってください。
- 信頼できる配布元の IPA ファイルのみをインストールしてください。

## 6. Auto Refresh（自動更新）の設定

このガイドで最も重要な機能です。

Sideloadly には Automatic App Refresh 機能があり、Sideloadly Daemon というバックグラウンドサービスによって管理されます。

### 6.1 自動更新を有効にする

1. Sideloadly を起動します。
2. IPA ファイルを読み込みます。
3. デバイスと Apple ID を確認します。
4. インストール時の Automatic Refresh オプションを探します。
5. Automatic Refresh を有効にします。
6. Start をクリックします。
7. 署名とインストールが完了するまで待ちます。

注意：Automatic Refresh は IPA のサイドロード時に設定します。Anisette Authentication や Signing Mode の設定ではありません。

### 6.2 Sideloadly Daemon

Daemon は自動更新を管理するバックグラウンドサービスです。

主な機能：

- 登録済みアプリの管理。
- 署名期限の確認。
- 期限が近いアプリの再署名。
- USB または Wi-Fi による iPhone の検出。
- 自動更新対象アプリの管理。

### 6.3 自動更新に必要な条件

- Windows が正常に動作していること。
- Sideloadly Daemon が実行されていること。
- iPhone が USB または Wi-Fi で検出できること。
- PC がインターネットに接続されていること。
- Wi-Fi ペアリングを完了しておくことを推奨します。

自動更新は永久署名ではなく、すべての状況で成功する保証はありません。

PC の電源が切れている間、Daemon は更新処理を実行できません。

公式 FAQ：

https://sideloadly.io/faq.html

## 7. Wi-Fi 接続の設定

Wi-Fi ペアリングを設定すると、USB ケーブルなしで Sideloadly が iPhone を検出できるようになります。

### 7.1 初回ペアリング

1. USB で iPhone を接続します。
2. Windows が iPhone を認識していることを確認します。
3. iTunes を開きます。
4. iPhone のデバイスアイコンをクリックします。
5. デバイスの概要ページを開きます。
6. 「Wi-Fi 経由でこの iPhone と同期」を探します。
7. チェックを入れます。
8. 適用または同期をクリックします。
9. iPhone と Windows が同じ Wi-Fi ネットワークに接続されていることを確認します。

### 7.2 Wi-Fi 検出条件

- Windows と iPhone が同じネットワークに接続されていること。
- Windows が起動していること。
- iPhone がネットワーク上で検出可能であること。
- 状況によって iTunes を起動する必要があります。
- 無線検出を助けるため、iPhone の画面をオンにしてください。

### 7.3 Wi-Fi 検出に失敗する場合

1. 両方のデバイスが同じ Wi-Fi を使用しているか確認します。
2. iTunes を開きます。
3. Wi-Fi 同期の設定を確認します。
4. Bonjour が正常に動作しているか確認します。
5. Sideloadly を再起動します。
6. 必要に応じて USB 接続を使用します。

公式説明：

https://sideloadly.io/faq.html

## 8. iPhone 側の設定

### 8.1 開発者証明書を信頼する

「未信頼の開発元」と表示された場合：

設定 → 一般 → VPN とデバイス管理

該当する Apple ID の開発者証明書を選択し、「信頼」をタップします。

### 8.2 デベロッパモードを有効にする

iOS 16 以降で必要な場合：

設定 → プライバシーとセキュリティ → デベロッパモード

画面の指示に従って iPhone を再起動します。

すべての環境で手動設定が必要なわけではありません。iOS の案内に従ってください。

## 9. 無料 Apple ID の制限

| 項目 | 無料アカウント |
|---|---|
| 署名の有効期間 | 通常 7 日間 |
| 同時にサイドロードできるアプリ | 最大 3 個 |
| 有料 Apple Developer アカウント | 不要 |
| Mac | 不要 |
| 脱獄 | 不要 |
| 自動更新 | 対応。ただし条件あり |

### 9.1 なぜ 7 日間なのか？

無料 Apple Developer アカウントで署名したアプリは、通常 7 日間使用できます。

署名が正常に更新されないまま期限を迎えると、アプリを起動できなくなる場合があります。

### 9.2 期限切れのリスクを減らす方法

1. Automatic Refresh を有効にします。
2. Sideloadly Daemon が正常に動作していることを確認します。
3. Windows を定期的に起動し、インターネットに接続します。
4. iPhone が USB または Wi-Fi で検出できるようにします。
5. 期限前に自動更新の成功を確認します。
6. 失敗した場合は USB で再署名します。

## 10. よくある問題と解決方法

### Q1：Sideloadly が iPhone を認識しない

考えられる原因：

- USB ケーブルがデータ通信に対応していない。
- コンピュータを信頼していない。
- iTunes または Apple ドライバーが正しくインストールされていない。
- Microsoft Store 版 iTunes がインストールされている。
- iCloud のバージョンに互換性がない。

解決方法：

1. USB ケーブルまたはポートを変更します。
2. iPhone を再接続します。
3. iTunes が iPhone を認識するか確認します。
4. Microsoft Store 版 iTunes と iCloud をアンインストールします。
5. Apple 公式のデスクトップ版コンポーネントをインストールします。
6. Windows を再起動します。

### Q2：No devices detected と表示される

推奨手順：

1. Web iTunes を再インストールします。
2. Web iCloud を再インストールします。
3. Windows を再起動します。
4. iPhone を接続して「信頼」をタップします。
5. iTunes を開いてデバイスを同期します。

### Q3：インストール後にアプリが起動しない

考えられる原因：

- 開発者証明書が信頼されていない。
- 署名の有効期限が切れている。
- IPA が現在の iOS に対応していない。
- IPA ファイルが破損している。
- IPA のアーキテクチャがデバイスに対応していない。

解決方法：

1. VPN とデバイス管理を確認します。
2. 署名期限を確認します。
3. IPA の互換性を確認します。
4. 必要に応じて再署名します。

### Q4：7 日後にアプリが使えなくなる

署名期限が切れたか、自動更新に失敗した可能性があります。

解決方法：

1. Windows を起動します。
2. Daemon が動作していることを確認します。
3. iPhone を接続します。
4. デバイスが検出されることを確認します。
5. Sideloadly で再署名します。

### Q5：PC の電源を完全に切っても自動更新できますか？

いいえ。

Sideloadly Auto Refresh は Windows のバックグラウンドサービスに依存します。PC の電源が切れている間、Daemon は更新処理を実行できません。

### Q6：USB を使わずに接続できますか？

初回の USB ペアリングと Wi-Fi 同期の設定が完了していれば可能です。

その後は同じネットワーク上で Wi-Fi 経由の検出を試すことができます。

### Q7：無料 Apple ID で何個のアプリをインストールできますか？

無料 Apple ID では、通常、同時に最大 3 個のアプリをサイドロードできます。

### Q8：IPA を更新すると既存のアプリは削除されますか？

同じ Apple ID と同じ Bundle ID を使用すれば、Sideloadly で既存アプリを上書きできます。

重要なデータは事前にバックアップしてください。

## 11. 公式リソース

- Sideloadly：https://sideloadly.io/
- Sideloadly FAQ：https://sideloadly.io/faq.html
- Sideloadly Changelog：https://sideloadly.io/changelog.html
- iTunes：https://www.apple.com/itunes/download/win64
- Apple iCloud：https://support.apple.com/ja-jp/103232

---

# Disclaimer / 免責事項 / 免責事項

This guide is intended for personal use and educational purposes. Only install IPA files from trusted sources. Automatic refreshing is not guaranteed to work in every environment.

本教學僅供個人使用及學習參考。請只安裝來自可信任來源的 IPA 檔案。自動續簽不保證在所有環境中都能成功。

このガイドは個人利用および学習目的を対象としています。信頼できる配布元の IPA ファイルのみをインストールしてください。自動更新はすべての環境で成功することを保証するものではありません。