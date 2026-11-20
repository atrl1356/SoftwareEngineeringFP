# 課堂搶答室

教師從 Google Sheets 的 Guided Notes 選定分頁，開放整份學習單，監看各組逐題送答並一次截止。截止後學生先看到每題的勝組。教師逐題核對原表兩格並確認後，該題勝答才會公布。教師可以分別查看公布與寫入進度。

## 本機啟動

本次驗收使用 Node.js 24.22.1、npm 11.9.0、OpenSpec 2.1.0 與 Chromium。應用程式使用 Node.js 24 以上內建的 SQLite，以單一 Fastify 程序提供前端與 API。

1. 在儲存庫根目錄安裝鎖定版本的套件，並在首次啟動時建立只供本人讀取的設定檔。

   ```sh
   npm ci (umask 077 && cp -n .env.example .env)
   ```

2. 在 `.env` 填入自訂的 `TEACHER_NAME` 與至少 8 字元的 `TEACHER_PASSWORD`。第一次在本機試用可設 `QUIZ_SHEETS=fixture`，直接使用隨專案提供的兩個分頁。使用教師自己的試算表時設 `QUIZ_SHEETS=google`，並依下節完成授權。
3. 建立教師帳號並啟動服務。初始化只需對每個新帳號執行一次。建立完成即可從環境移除初始密碼。

   ```sh
   npm run teacher:init
   npm run dev
   ```

4. 開啟教師頁，登入後建立活動。按「讀取分頁」，選擇分頁並按「匯入題目」。核對表名、分頁、原題號及題數，再按「開放搶答」。後端以已成立的組數判定，只有學生輸入活動碼仍算零組。零組時顯示「目前尚無組別，仍要開放搶答嗎？」取消後維持準備中，按「確認開場」才開始收答。已有組別時單擊即可開場。使用替身時網址會預填，選擇「單題練習」應顯示 6 題。[教師頁](http://localhost:3000/?role=teacher)
5. 學生在另一個瀏覽器工作階段輸入活動加入碼。新建組的學號須為以 1 開頭的九位半形數字，例如 `123456789`。首尾空白會去除，舊名冊與既有組的身分恢復沿用原值。組長建組後取得公開代號與組內加入碼，組員以組內加入碼加入。開放中仍可新增組別。學生可逐題送答並查閱本組原收據。[學生頁](http://localhost:3000/?role=student)
6. 教師按「結束整場」，選一道有勝組的題目，按「預覽兩格」，核對作答格及搶答勝組格。遇到公式或不同值時逐格勾選同意，再按「確認回寫」。過期預覽會顯示最新兩格供重新確認。無有效作答的題目顯示「略過」。

若雲端環境的 npm 快取目錄為唯讀，在同一個 shell 執行 `export npm_config_cache=/tmp/quiz-npm` 後再執行 `npm ci`。本次乾淨安裝使用此設定。

`npm run dev` 會先建置 Vue 前端，再啟動 Fastify。前端原始碼修改後可重新執行這個指令。已有建置產物時可直接執行 `npm start`。本機預設監聽 `127.0.0.1:3000`，教師與學生共用同一個服務。

## 移除活動與還原

在「我的活動」逐列按「移除」，或勾選多場再按「移除勾選活動」。用名稱、活動碼與階段辨認場次。取消不會送出移除請求。確認時系統逐場重查資格，列表會顯示處理結果與略過原因。

| 活動階段 | 移除與還原規則 |
| --- | --- |
| 準備中 | 即使已有組別等待也可移除。還原後保留名冊、公開代號與題目，換發活動碼及每組組內碼。教師把新活動碼與對應的新組內碼分送各組長，也可在準備中場次的「查看組長名冊」再次查閱。 |
| 開放中 | 先明確截止，再按已結束場次的條件檢查。 |
| 已結束 | 每個有勝組的題目須已確認兩格寫入，無勝組題均須略過，且沒有排隊或執行中的回寫。還原後，學生用原活動碼與原組內碼重新加入，可看本組收據、各題勝組及已公布勝答。 |

只有原教師可在「已移除清單」按「還原」。期限從伺服器記錄的移除成功時刻起算，**未滿 240 小時**可還原。到期即失去還原資格，服務運行期間自動清理，停機期間到期則啟動時補清。舊學生工作階段在兩種還原後都已失效。移除、還原與到期清除均不寫 Google Sheets，原表與其他場次的資料保留。

舊版資料在服務啟動時自動遷移。升級前停止舊服務並備份整個 SQLite 持久目錄（含 WAL）及憑證金鑰。同一份資料檔只啟動一個後端程序。

## Google 授權與實表驗收

1. 在 Google Cloud 專案啟用 Google Sheets API 與 Google Drive API。設定 OAuth 同意畫面並將專用測試帳號列為測試使用者。建立「網頁應用程式」OAuth 用戶端。將 `http://localhost:3000/api/google/callback` 列入已授權的重新導向 URI，並用相同主機名稱開啟教師頁。[Google 網頁伺服器 OAuth 指南](https://developers.google.com/identity/protocols/oauth2/web-server)
2. 將用戶端資料填入 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REDIRECT_URI`。用 `openssl rand -hex 32` 產生 `QUIZ_TOKEN_KEY`，供後端加密教師的更新憑證。以檔案或環境變數供應這些設定，妥善保存相同的金鑰供重啟使用。範例僅列設定名稱與佔位值。[設定範例](.env.example)
3. 使用空的測試 SQLite 資料檔，初始化教師，以全新的瀏覽器工作階段登入。先建立活動並嘗試讀取試算表，應收到「請先連結 Google 帳號」。回到「我的活動」，按「連結 Google 帳號」，由專用測試帳號同意授權。應用程式使用 `spreadsheets` 讀寫原表，以 `drive.metadata.readonly` 讀取檔案是否可編輯。[Sheets 權限](https://developers.google.com/workspace/sheets/api/scopes) · [Drive 檔案權限資料](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
4. 從團隊唯讀母版建立專用測試副本，讓該帳號能編輯副本。四個表頭為「題號、題目、作答、搶答勝組」。對照下節 v1 的六題、空白目標、整格格式與合併範圍。在教師頁讀取同一檔案的兩個合規分頁，逐一核對表名、分頁、原題號與題數。唯讀或已設為該教師無權編輯的勝組格應阻止開場，檢查後保留原值。
5. 將該副本網址填入 `GOOGLE_TEST_COPY_URL`。保留已授權教師的 `TEACHER_NAME`、`QUIZ_DB` 與上述 Google 設定。執行 `npm run test:sheets`。腳本在該副本以同一份 v1 資料建立兩個帶時間戳記的新分頁，核對可編輯權、保護設定、初值、格式與合併，再以獨立場次走第 37 題。輸出會列出此次分頁名稱、兩格位置、原文與重試寫入次數。重跑另建新分頁，先前結果可供核查。[實表驗收腳本](tests/live-sheet.ts)

## 收件、資料保存與復原

- 開場、送答與截止共用一個收件序列，以 Fastify 收齊完整請求的時點排序。有效答案與題內順位在同一筆 SQLite 交易保存。同組同題同文重送可取回原收據，異文不能覆寫，截止後的新答案會被拒收。[收件入口](server/app.ts) · [裁決與角色查詢](server/quiz.ts)
- `QUIZ_DB` 預設為 `data/classroom.sqlite`。重新啟動使用同一資料檔及憑證金鑰，即可恢復活動、組別、順位、已公布結果與回寫工作。備份時先停止該單一後端，再保存整個持久目錄與另行保管的金鑰。瀏覽器工作階段到期時，組員可用原活動碼與組內碼重新查閱本組收件。[資料結構](server/db.ts)
- 同一試算表分頁的回寫依序處理。重試先查兩格實際型別、原文、合併範圍與跨場寫入版本。兩格皆符合時，重啟可直接完成而新增零次寫入。另一場已改寫重疊格時須重新確認。人工共編可攔截到最後一次寫前核對所觀察到的變動，Google API 在核對後到寫入前仍允許他人編輯。[定位與權限](server/sheets.ts) · [寫入與對帳](server/writeback.ts)
- Google 批次只設定目標值為字串，保留前導零、以等號開頭的答案、整格格式及合併範圍。替換舊值時，目標格原文字的局部加粗或內嵌連結可能隨之清除。[Sheets API 整批寫入](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate)

## 重跑自動驗收

```sh
openspec validate build-classroom-quiz-update --type change --strict
openspec validate --all --strict
npm run typecheck
npm test
npm run test:e2e
```

Playwright 使用本機 Chromium。若環境沒有 `/usr/bin/chromium`，可執行 `npx playwright install chromium`，或用 `CHROMIUM_PATH` 指向已安裝的瀏覽器。每個案例啟動獨立 Fastify、SQLite 與 Sheets 替身，結束後清理暫存資料。

兩套驗收都以 v1 的兩個分頁為起點。核對四表頭、說明列、格式空列、六個原題號、合併區，以及第一題 C3 與 D3 都空白。日常測試為每案複製固定資料，實表測試在已授權副本重建同版資料。移欄、缺號、重號、缺欄、題組、唯讀及受保護格等變體從母版各自產生。每個變體及其預期錯誤可逐案重跑。[v1 母版](fixtures/guided-notes-v1.json) · [匯入案例](tests/import.test.ts) · [任務與驗收表](openspec/changes/build-classroom-quiz/tasks.md)

### 本次更新的驗收範圍

活動移除與兩種還原使用暫存 SQLite、獨立瀏覽器及可重置的 Sheets 替身驗收。第 49 題的 11 個情境逐項記錄，並重跑第一輪第 37 題與開場、截止的兩秒同步測試。[本次任務及驗收結果](openspec/changes/build-classroom-quiz-update/tasks.md)

### 第一輪 Apply 的雲端驗收紀錄

| 檢查 | 結果 |
| --- | --- |
| OpenSpec 2.1.0 | 嚴格變更檢查通過。五個能力目錄各有一份 delta spec，共 17 條需求。 |
| 乾淨安裝與型別 | 空目錄依鎖檔安裝、`npm run typecheck`、初始化教師、啟動、讀取前端資源、登入及建立活動均通過。 |
| Vitest | 5 個測試檔、41 個案例通過。包含實際 HTTP 分段收件、開場與截止邊界、同組雙裝置、SQLite 重啟、跨場衝突及寫後回應遺失。 |
| Playwright | 6 個案例通過。獨立量測從教師成功回應至學生頁更新，開場 788 ms，截止 788 ms，各低於 2 秒。 |
| 第 37 題 | 三個獨立工作階段完成整場。2 筆有效，乙第一。截止先見乙組 `G02`，確認後公布 `CPU`。替身讀回 C3 為純文字 `CPU`、D3 為純文字 `G02`，其餘格與 v1 一致。 |
| 真實 Google Sheets | 初次雲端驗收時缺少專用副本及授權，當時未能執行。團隊後續已在第一輪任務 3.1、6.4、7.2 記錄通過。 |

第一輪最初的雲端驗收涵蓋 17／20 項，後續團隊已在第一輪任務清單確認 20／20 項。五份規格分別對應身分與場次、Guided Notes 匯入、搶答裁決、角色結果與原表回寫。實作依據與核准版本可在變更目錄查閱。[第一輪決策](docs/project-context.md) · [提案及審查紀錄](openspec/changes/build-classroom-quiz/proposal.md)

## 套件與資料來源

| 用途 | 直接依賴或資料 | 授權及來源 |
| --- | --- | --- |
| 服務與靜態資源 | Fastify、@fastify/static | MIT · [Fastify](https://github.com/fastify/fastify) · [fastify-static](https://github.com/fastify/fastify-static) |
| 前端及建置 | Vue 3、Vite、@vitejs/plugin-vue | MIT · [Vue](https://github.com/vuejs/core) · [Vite](https://github.com/vitejs/vite) · [Vue 外掛](https://github.com/vitejs/vite-plugin-vue) |
| TypeScript 與執行工具 | TypeScript、tsx、vue-tsc、@types/node | TypeScript 為 Apache-2.0，其餘為 MIT · [TypeScript](https://github.com/microsoft/TypeScript) · [tsx](https://github.com/privatenumber/tsx) · [vue-tsc](https://github.com/vuejs/language-tools) · [Node 型別](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| 自動驗收 | Vitest、@playwright/test | [Vitest，MIT](https://github.com/vitest-dev/vitest) · [Playwright，Apache-2.0](https://github.com/microsoft/playwright) |
| 執行環境與儲存 | Node.js、內建 SQLite | [Node.js 授權及所附元件](https://github.com/nodejs/node/blob/main/LICENSE) · [SQLite 公共領域聲明](https://sqlite.org/copyright.html) |
| 工作表與測試資料 | 後端使用 Google 官方 API。v1 學習單與程式化變體為本專案自製的合成驗收資料。 | [Google API 條款](https://developers.google.com/terms) · [專案測試資料](fixtures/guided-notes-v1.json) |

直接依賴的精確版本列於套件設定，遞移依賴的版本、來源與授權資訊可在鎖檔查閱。[package.json](package.json) · [package-lock.json](package-lock.json)
