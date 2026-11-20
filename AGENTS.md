# 功能開發流程

本儲存庫使用 OpenSpec 的 `spec-driven` 流程。所有功能開發都必須先提出規格，經使用者審查後才能實作。提案、設計、任務、驗收情境與審查說明使用繁體中文。保留 OpenSpec 要求的結構標題與關鍵字，例如 `## ADDED Requirements`、`### Requirement:`、`#### Scenario:`、`SHALL`、`WHEN` 與 `THEN`。

## 實作前必須取得人工確認

- 未經使用者明確確認的變更提案，不得進入程式實作階段，亦不得修改功能性程式碼或實作測試。
- 「建立提案」、「分析需求」、產生完整 artifacts、CLI 驗證通過或執行 Apply tasks，都不代表使用者已核准實作。
- 提供 proposal、specs、design、tasks 的路徑、範圍、驗收條件及風險供使用者審查；等待使用者在對話或 PR 明確確認該變更及範圍後，才可實作。
- 需求、規格或實作範圍若有實質變更，停止受影響的實作，以 Update change 更新文件後重新送審。未回覆、含糊回覆及舊範圍的核准皆不視為新範圍核准。
- 任務中若有任何未完成事項與測試失敗，皆須將結果回報給使用者。
- Skills 的自動續行指示不能略過上述人工審查關卡。

## 從需求到封存

1. **釐清需求**　使用 `$openspec-explore` 了解現況、使用者需求、範圍與驗收條件。將待決問題列出，供使用者確認。
2. **建立規格**　使用 `$openspec-propose`，在 `openspec/changes/<變更代號>/` 建立提案、差異規格、設計與任務清單。每項需求都要能以具體情境驗收，所有核心需求皆須有對應規格，且需求修改時應先更新規格。執行 `openspec validate <變更代號> --strict`。
3. **取得人工核准**　向使用者提供變更代號、文件位置、影響範圍及驗收方式，然後等待使用者明確核准該版提案進入實作。在提案中記錄核准所對應的版本或範圍，並引用使用者的回覆或 PR 審查連結。未取得核准時，只能分析需求及修訂文件；不得修改功能程式碼、撰寫實作測試或執行 Apply tasks。CLI 顯示 `ready`、驗證通過或任務清單已產生，均不能代替人工核准。
4. **依核准內容實作**　確認核准紀錄後，使用 `$openspec-apply-change` 按任務實作，其中使用的外部套件、資料與程式碼須標示來源及授權，完成一項再勾選一項。若需變更範圍、預期行為或驗收條件，暫停受影響的實作，以 `$openspec-update-change` 更新相關文件，重新取得使用者核准。
5. **測試並驗證**　依核准的情境執行相關測試，記錄指令、結果及未涵蓋項目。使用 `$openspec-verify-change` 核對實作、測試、規格與任務，再執行嚴格驗證。有未完成任務、測試失敗或驗收不符時，先修正再驗證。
6. **同步與封存**　驗證通過後，使用 `$openspec-sync-specs` 將差異同步至 `openspec/specs/`，再使用 `$openspec-archive-change` 封存。多項變更可用 `$openspec-bulk-archive-change`；逐項確認核准與驗證紀錄，先解決規格衝突。最後執行 `openspec validate --all --strict` 並檢查 Git 差異。

## 使用與維護

在儲存庫根目錄開啟 Codex，可直接輸入 `$openspec-propose` 加上需求描述。使用 `openspec list` 檢視進行中的變更，使用 `openspec status --change <變更代號>` 查看文件進度。

本專案使用 OpenSpec 2.1.0，需要 Node.js 22.20.0 以上。新環境可執行 `npm install --global @fission-ai/openspec@2.1.0`。專案的八個 Codex Skills 位於 `.agents/skills/`。若要重新產生 Skills，先執行 `openspec config profile`，在帳號的 profile 選取 Propose change、Explore ideas、Apply tasks、Update change、Sync specs、Archive change、Bulk archive、Verify change，再於儲存庫根目錄執行 `openspec update` 並審查差異。
