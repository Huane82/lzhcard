# LZHCard 電腦版獨立桌面懸浮小工具 (`desktop-widget/`)

透過 Electron 建立 **無邊框、透明背景、永遠置頂**（`transparent: true, frame: false, alwaysOnTop: true`）的電腦版獨立桌面懸浮視窗，讓 **LZHCard** 的全域翻譯與好友聊天視窗脫離瀏覽器分頁限制，自由懸浮於電腦桌面與任何軟體（YouTube、PDF、遊戲、文書工具）最上層。

---

## 核心特色

1. **獨立透明無邊框視窗**：
   - 收合態僅呈現精巧的 `76x76` 懸浮球，拖曳放手後自動吸附至最近螢幕的左／右邊緣並記憶座標。
   - 點擊即展開 `436x650` 多功能面板（拍照熱區翻譯、三語分詞點詞、即時雙語字幕、好友懸浮聊天）。
   - 支援跨顯示器邊界防跑出（WorkArea Clamping）與全螢幕拍照框選模式動態擴張。
2. **全域系統熱鍵與系統列匣 (System Tray)**：
   - 支援全域快捷鍵 **`Alt + T`**，在任何軟體操作時皆可一鍵喚出或收合懸浮翻譯視窗。
   - 右鍵系統列小圖示可切換「永遠置頂」、貼齊邊緣、重載連線或開啟完整網頁版。
3. **與主專案資料共用 / 雲端即時同步**：
   - 登入同一組 Google 帳號即可透過 Firebase 即時雙向同步所有字卡、FSRS 排程與好友聊天室訊息。

---

## 執行與啟動方式

確認本機已安裝 **Node.js 18+**，進入 `desktop-widget/` 資料夾執行：

```bash
cd desktop-widget
npm install
npm start
```

### 指定載入來源網址

小工具啟動時會自動偵測以下來源順序：
1. 命令列參數 `--url=...`（例如連線已部署的線上版）：
   ```bash
   npm start -- --url=https://your-lzhcard-domain.example/?widget=desktop
   ```
2. 環境變數 `LZHCARD_APP_URL`
3. 若本機已執行 LZHCard 開發伺服器（`http://127.0.0.1:3000/`），自動連線開發預覽伺服器。
4. 否則自動載入內建打包的 `www/index.html?widget=desktop` 離線前端包。

---

## 打包成 Windows / macOS / Linux 獨立安裝檔

於 `desktop-widget/` 目錄執行對應平台打包指令，產出檔案將輸出至 `desktop-widget/dist-widget/`：

### Windows（產生安裝程式 `.exe` 與免安裝版 Portable `.exe`）
```bash
npm run build:win
```

### macOS（產生 `.dmg` 與 `.zip`）
```bash
npm run build:mac
```

### Linux（產生 `.AppImage`）
```bash
npm run build:linux
```

### 僅測試封裝目錄（不壓縮安裝包）
```bash
npm run pack
```

---

## 檔案結構說明

- `package.json`：Electron 與 `electron-builder` 打包設定（自動打包 `../www` 靜態資源）。
- `main.js`：建立 `transparent: true, frame: false, alwaysOnTop: true` 視窗、IPC 尺寸切換與拖曳吸附、系統列選單與全域熱鍵 `Alt+T`。
- `preload.js`：透過 `contextBridge` 安全暴露 `window.LZHDesktopWidget` 給 `www/js/floating-translator.js` 呼叫。
