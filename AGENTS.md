# 開發協作規則

## 環境與範圍

- 所有需求討論、規格內容、審查摘要及完成報告使用繁體中文；保留 OpenSpec 必要的英文結構標題與 SHALL/MUST 關鍵字。
- 雲端任務已隔離，使用既有 checkout；除非使用者明確要求，不另建 Git worktree。
- 開始前讀取本檔、`openspec/config.yaml` 及相關 `.agents/skills/openspec-*/SKILL.md`。
- 執行 CLI 前，在根目錄執行 `source scripts/openspec-env.sh`。缺少 CLI 時執行 `bash scripts/setup-openspec.sh`。

## 必須遵循的 OpenSpec 流程

1. **需求分析**：使用 `openspec-explore` 釐清目標、範圍、風險、限制與驗收情境；此階段不得實作功能。
2. **規格建立**：使用 `openspec-propose` 建立 `openspec/changes/<change-id>/` 下的 proposal、specs、design 與 tasks，包含可驗證的驗收條件與測試計畫。既有提案以 `openspec-update-change` 修訂。
3. **人工審查**：執行 `openspec validate <change-id> --strict --no-interactive`，向使用者展示提案、規格、設計與任務，等待使用者明確確認該變更的當前版本。
4. **實作**：只有完成上述審查且取得明確確認後，才能使用 `openspec-apply-change`，依核准的 tasks 修改功能性程式碼並標記進度。
5. **測試**：執行與核准需求相符的測試、建置及必要檢查，記錄實際命令、結果、跳過項目與限制；不可把未執行或零測試的結果宣稱通過。
6. **驗證**：使用 `openspec-verify-change` 比對實作、規格及任務，並再次嚴格驗證；修正差異後才可完成。沒有測試框架時須明示限制，不能捏造測試結果。
7. **同步與封存**：通過測試與驗證後使用 `openspec-sync-specs` 同步規格，再使用 `openspec-archive-change` 封存；批次封存使用 `openspec-bulk-archive-change`，逐項確認完成狀態。保留封存與測試紀錄供 PR 審查。

## 實作前的必要關卡

- 未經使用者確認的提案不得進入程式實作階段。提案檔案齊全、CLI 顯示可 apply、任務已產生或使用者未回覆，均不代表已核准。
- 實作前在變更目錄的 `review.md` 記錄核准範圍、所對應的 Git commit（或檔案摘要）、使用者明確確認的原文及可追溯的對話／PR 參照；不得自行編造核准紀錄。
- 呼叫 Apply skill 本身不等於核准提案；必須確認使用者已審閱並明確同意當前提案內容。
- 提案的需求、驗收條件、設計或實作範圍有實質變更時，先更新規格，重新取得使用者確認，再繼續受影響的實作。
- 缺少核准、需求仍不明確或實作超出已核准範圍時，停止相關實作並提出需確認的具體內容；可繼續唯讀分析與規格整理。
- 這些是代理協作規則與 CLI 指引，不是技術存取控制。OpenSpec CLI 本身不會阻止繞過人工核准；不得將本設定宣稱為強制執行的權限機制。

本次初始化只設定開發環境及規格流程，不代表任何未來功能提案已獲核准。
