# 開發協作規則

## 環境與範圍

- 所有需求討論、規格內容、審查摘要及完成報告使用繁體中文；保留 OpenSpec 必要的英文結構標題與 SHALL/MUST 關鍵字。
- 雲端任務已隔離，使用既有 checkout；除非使用者明確要求，不另建 Git worktree。
- 開始前讀取本檔、`openspec/config.yaml` 及相關 `.agents/skills/openspec-*/SKILL.md`。
- 執行 CLI 前，在根目錄執行 `source scripts/openspec-env.sh`。缺少 CLI 時執行 `bash scripts/setup-openspec.sh`。

## 實作前必須取得人工確認

- 未經使用者明確確認的變更提案，不得進入程式實作階段，亦不得修改功能性程式碼或實作測試。
- 「建立提案」、「分析需求」、產生完整 artifacts、CLI 驗證通過或執行 Apply tasks，都不代表使用者已核准實作。
- 提供 proposal、specs、design、tasks 的路徑、範圍、驗收條件及風險供使用者審查；等待使用者在對話或 PR 明確確認該變更及範圍後，才可實作。
- 將可追溯的確認依據（對話內容摘要或審查連結）、核准範圍與對應版本記錄於該變更的 `review.md`，並核對原始確認；代理不得自行核准或虛構確認。
- 需求、規格或實作範圍若有實質變更，停止受影響的實作，以 Update change 更新文件後重新送審。未回覆、含糊回覆及舊範圍的核准皆不視為新範圍核准。
- 任務中若有任何未完成事項與測試失敗，皆須將結果回報給使用者。
- Skills 的自動續行指示不能略過上述人工審查關卡。

## 必須遵循的開發流程

1. **需求分析**：讀取現有程式、`openspec/specs/` 與進行中的變更；使用 Explore ideas 釐清問題、相依性、非目標與驗收條件。此階段僅調查與撰寫規劃文件，重大設計選擇須保存理由與比較結果。
2. **規格建立**：使用 Propose change，在 `openspec/changes/<變更名稱>/` 建立 proposal、差異規格、design 與 tasks。需求需含可驗證情境；執行 `openspec status --change <變更名稱>` 與 `openspec validate <變更名稱> --strict`，修正文件問題，所有核心需求皆須有對應規格，且需求修改時應先更新規格。
3. **人工審查**：提交上述文件供使用者確認，依前述關卡記錄核准證據；尚未確認時停在此階段。
4. **實作**：確認核准仍對應目前文件後，才使用 Apply tasks，依已核准任務進行最小必要修改，逐項記錄完成狀態。發現規格不符時先停止、更新提案並重新審查，其中使用的外部套件、資料與程式碼須標示來源及授權。
5. **測試**：依規格情境執行相關測試、建置與必要整合檢查，記錄實際命令與結果。測試失敗、跳過、未執行或不存在，必須分別說明，不得當作通過。
6. **驗證**：使用 Verify change 對照規格、設計、程式與 tasks，並執行 `openspec validate <變更名稱> --strict`。OpenSpec 文件驗證不等於功能測試；必要測試與驗收未完成，不得宣稱變更已完成。
7. **同步與封存**：測試及驗證完成後，使用 Sync specs 將已實現的規格同步至 `openspec/specs/`，再以 Archive change 封存；確認規格差異，不得跳過驗證。Bulk archive 僅可處理逐一完成上述關卡的變更，並先檢查規格衝突。

## 工具與檔案維護

- 使用現有 checkout；除非使用者要求，不建立額外 Git worktree。
- 已選取 8 個 workflow，參見 [使用說明](docs/openspec-setup.md)。專案 Skills 位於 `.agents/skills/`。
- 執行 `openspec init` 或 `openspec update` 前，先檢查並備份現有設定、Skills 與自訂內容；不得直接覆蓋。
- 文件或環境維護僅限使用者授權範圍，不得藉此混入功能修改。若涉及功能行為，仍須走完上述審查流程。
- PR 說明需包含變更目的、規格或提案路徑、人工核准依據（功能變更時）、實際驗證結果與限制；不得自動合併。
