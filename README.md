# Windows 使用 Sideloadly 免費安裝 IPA 與自動續簽教學

使用 Windows 電腦及免費 Apple ID，在 iPhone 上安裝 IPA，不需要 Mac、不需要越獄，也不需要購買 Apple 開發者帳號。

本教學以 **Sideloadly + Auto Refresh** 為主要方案，目標是讓 IPA 安裝後能盡可能自動續簽，避免每 7 天手動重新安裝。

---

## 目錄

- [一、準備工作](#一準備工作)
- [二、下載必要軟體](#二下載必要軟體)
- [三、安裝前準備](#三安裝前準備)
- [四、第一次安裝 IPA](#四第一次安裝-ipa)
- [五、設定自動續簽](#五設定自動續簽)
- [六、設定 Wi-Fi 無線連線](#六設定-wi-fi-無線連線)
- [七、iPhone 端設定](#七iphone-端設定)
- [八、免費 Apple ID 的限制](#八免費-apple-id-的限制)
- [九、常見問題與故障排除](#九常見問題與故障排除)

---

## 一、準備工作

### 需要的設備

| 項目 | 需求 |
|---|---|
| 電腦 | Windows 10 / Windows 11 |
| 手機 | iPhone |
| Apple ID | 免費 Apple ID |
| IPA | 已經下載好的 IPA 檔案 |
| 傳輸線 | 可傳輸資料的 USB 線 |
| 網路 | 可以正常連接網際網路 |

### 本方法的特色

- 完全免費。
- 不需要 Mac。
- 不需要越獄。
- 不需要付費 Apple 開發者帳號。
- 使用免費 Apple ID 簽署 IPA。
- 支援 Sideloadly Auto Refresh 自動續簽。
- 可以設定 Wi-Fi 無線連線。

## 二、下載必要軟體

### 1. Sideloadly

官方網站：

https://sideloadly.io/

用途：
- 安裝 IPA。
- 使用 Apple ID 簽署應用程式。
- 自動刷新簽署期限。

### 2. iTunes

Apple 官方下載：

https://www.apple.com/itunes/download/win64

用途：
- 協助 Windows 辨識 iPhone。
- 管理 iPhone 裝置。
- 設定 Wi-Fi 同步。

注意：Sideloadly 的 Windows 環境建議使用 Apple 網站提供的傳統桌面版 iTunes，而非 Microsoft Store 版本。

### 3. iCloud

Apple 官方說明：

https://support.apple.com/zh-tw/103232

用途：
- 提供 Apple 服務及裝置相關支援。

建議依照 Sideloadly 官方說明安裝相容版本。

---

## 三、安裝前準備

1. 安裝 iTunes。
2. 安裝 iCloud。
3. 安裝 Sideloadly。
4. 重新啟動 Windows。
5. 使用 USB 傳輸線連接 iPhone。
6. 解鎖 iPhone。
7. 手機出現「信任此電腦」時，選擇「信任」。

確認 Sideloadly 可以正確辨識 iPhone。

如果沒有辨識到手機，請先檢查：
- USB 線是否支援資料傳輸。
- iPhone 是否已解鎖。
- 是否已安裝正確的 Apple 驅動程式。
- iTunes 是否能正常辨識手機。

---

## 四、第一次安裝 IPA

### 操作步驟

1. 開啟 Sideloadly。
2. 使用 USB 連接 iPhone。
3. 在 Device 欄位選擇自己的 iPhone。
4. 將 IPA 檔案拖曳至 IPA 欄位。
5. 輸入 Apple ID。
6. 確認 IPA 檔案及裝置正確。
7. 點擊 Start。
8. 等待 Sideloadly 完成簽署與安裝。

### 注意事項

- 建議使用專門用於側載的 Apple ID。
- 開啟 Apple ID 雙重認證。
- 不要將 Apple ID 密碼交給不明第三方。
- 如果出現驗證碼，依照 Apple 官方登入流程完成驗證。

---

## 五、設定自動續簽

這是整個流程最重要的部分。

Sideloadly 提供 Auto Refresh 功能，可透過背景服務定期檢查並刷新已安裝 App 的簽署期限。

### 設定步驟

1. 開啟 Sideloadly。
2. 找到 Auto Refresh 相關設定。
3. 啟用自動刷新功能。
4. 安裝 IPA 時確認有啟用自動刷新。
5. 完成 IPA 安裝。
6. 確認 Sideloadly Daemon 已正常運作。

### 自動續簽的必要條件

- Windows 電腦必須保持開機。
- Sideloadly Daemon 必須正常運作。
- iPhone 必須能被電腦偵測到。
- 電腦需要有網際網路連線。
- 建議預先完成 Wi-Fi 無線配對。

注意：自動續簽不代表永久有效，也不保證每次都能成功。建議在到期前確認簽署狀態。

官方 FAQ：

https://sideloadly.io/faq.html

---

## 六、設定 Wi-Fi 無線連線

設定完成後，可以減少每次續簽都需要插 USB 的情況。

### 操作步驟

1. 使用 USB 將 iPhone 連接 Windows。
2. 開啟 iTunes。
3. 點擊 iPhone 裝置圖示。
4. 進入裝置摘要頁面。
5. 找到「透過 Wi-Fi 與此 iPhone 同步」。
6. 勾選該選項。
7. 點擊套用。
8. 確認電腦與 iPhone 位於相同 Wi-Fi 網路。

### 注意事項

- Windows 需要正常運作。
- 電腦不能關機或進入休眠。
- 需要有正常的網路連線。
- 確認 Bonjour 及 Apple 裝置相關服務正常。
- Wi-Fi 配對不代表可以完全脫離電腦。

---

## 七、iPhone 端設定

IPA 安裝完成後，可能需要手動信任開發者憑證。

### 1. 信任開發者憑證

進入：

設定 → 一般 → VPN 與裝置管理

找到對應的開發者 App，選擇信任。

### 2. 開啟開發者模式

如果使用 iOS 16 或更新版本：

設定 → 隱私權與安全性 → 開發者模式

開啟後，依照畫面提示重新啟動 iPhone。

注意：並非所有安裝情況都需要手動處理這個選項，請依照 iPhone 實際提示操作。

---

## 八、免費 Apple ID 的限制

| 項目 | 免費帳號限制 |
|---|---|
| App 簽署期限 | 通常 7 天 |
| 同時側載 App | 最多 3 個 App ID |
| Apple 開發者帳號 | 不需要付費帳號 |
| Mac | 不需要 |
| 越獄 | 不需要 |
| 自動續簽 | 支援，但有環境限制 |

### 為什麼需要每 7 天續簽？

免費 Apple ID 使用個人開發者簽署方式，產生的應用程式簽署期限通常只有 7 天。

到期後，App 可能無法正常開啟，需要重新簽署。

### 如何避免過期？

1. 保持 Sideloadly Daemon 正常運作。
2. 定期開啟 Windows 電腦。
3. 確保 iPhone 能被電腦偵測。
4. 在到期前確認 Auto Refresh 是否成功。
5. 如果自動刷新失敗，使用 USB 重新簽署。

---

## 九、常見問題與故障排除

### Q1：Sideloadly 找不到 iPhone？

可能原因：
- USB 線不支援資料傳輸。
- 尚未信任電腦。
- iTunes 或 Apple 驅動程式安裝不完整。
- Apple 裝置服務異常。

解決方式：
1. 更換 USB 線或連接埠。
2. 重新連接 iPhone。
3. 確認 iTunes 能辨識手機。
4. 重新安裝相容的 Apple 桌面版元件。

### Q2：IPA 安裝成功，但 App 無法開啟？

可能原因：
- 尚未信任開發者憑證。
- 簽署期限已過。
- IPA 與 iOS 版本不相容。
- IPA 本身有問題。

解決方式：
1. 檢查 VPN 與裝置管理。
2. 確認簽署期限。
3. 確認 IPA 是否支援目前的 iOS。
4. 必要時重新簽署。

### Q3：7 天後 App 失效？

通常代表簽署期限已到，或自動續簽沒有成功。

解決方式：
1. 開啟 Windows。
2. 確認 Sideloadly Daemon 正常。
3. 重新連接 iPhone。
4. 使用 Sideloadly 重新簽署。

### Q4：可以完全不開電腦嗎？

Sideloadly 的自動續簽依賴 Windows 背景服務，因此不能保證電腦關機時仍能自動續簽。

---

## 官方資源

- Sideloadly：https://sideloadly.io/
- Sideloadly FAQ：https://sideloadly.io/faq.html
- iTunes：https://www.apple.com/itunes/download/win64
- Apple iCloud：https://support.apple.com/zh-tw/103232

---

## 最後提醒

本教學使用免費 Apple ID，適合個人測試及安裝自己信任的 IPA。

自動續簽只能降低手動操作頻率，無法保證永久有效。請勿安裝來路不明的 IPA，也不要將 Apple ID 密碼交給不可信任的服務。

**推薦配置：Windows 11 + Sideloadly + Auto Refresh + Wi-Fi 配對 + 免費 Apple ID。**