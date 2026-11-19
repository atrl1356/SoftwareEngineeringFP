# OpenSpec 規格驅動開發

## 初始化結果

本專案初始為空儲存庫，沒有既有功能性程式碼、OpenSpec 設定或專案 Skills。
初始化時使用 Node.js v24.22.1、npm 11.9.0、官方 `@fission-ai/openspec` 2.1.0（要求 Node.js >=22.20.0）。
套件安裝於 `/workspace/.tools`，npm 快取位於 `/workspace/.cache/npm`；不把套件或快取提交至專案。

先執行使用者指定的初始化命令；因預設全域 Skills 目錄不可寫，使用官方專案範圍選項完成：

```bash
source scripts/openspec-env.sh
openspec init --tools codex --language zh-TW --profile core --scope project
openspec config profile
openspec update
```

已透過互動選單選取以下八項工作流程（最終 profile 為 `custom`）：

| 工作流程 | Codex Skill |
| --- | --- |
| Propose change | `openspec-propose` |
| Explore ideas | `openspec-explore` |
| Apply tasks | `openspec-apply-change` |
| Update change | `openspec-update-change` |
| Sync specs | `openspec-sync-specs` |
| Archive change | `openspec-archive-change` |
| Bulk archive | `openspec-bulk-archive-change` |
| Verify change | `openspec-verify-change` |

Skills 位於 `.agents/skills/`（OpenSpec 2.1.0 的 Codex 專案路徑），`.openspec-target` 標記工具為 codex。
保留官方產生的 Skill 範本；繁體中文規格語言、人工審查與專案規則集中在 `AGENTS.md` 及 `openspec/config.yaml`，避免更新範本時遺失自訂規則。

## 重建與日常使用

在雲端 checkout 根目錄執行：

```bash
bash scripts/setup-openspec.sh
source scripts/openspec-env.sh
openspec --version
openspec config list
openspec list --json
openspec update --dry-run
```

設定腳本可重複執行，安裝固定版本並恢復八項 workflow 設定；不修改自訂 Skills。
`config profile` 修改的是所選 `XDG_CONFIG_HOME` 下的全域設定，會影響共用該設定目錄的專案；設定腳本保留其餘設定鍵。
未來更新 Skills 前，先檢查 `git status` 與 `openspec update --dry-run`，備份自訂內容，再執行 `openspec update` 並審查差異。
勿在已有設定的專案盲目重跑 `init`。

在 Codex CLI／IDE 使用 `$openspec-explore` 討論需求，再使用 `$openspec-propose` 建立提案；桌面版可從 Skills 選單選擇同名工具。
若目前工作階段未重新掃描 Skills，重新開啟專案或工作階段。

提案完成後：

```bash
openspec status --change <change-id>
openspec validate <change-id> --strict --no-interactive
```

向使用者展示 proposal、specs、design、tasks 及驗收條件。取得明確確認後，在 `openspec/changes/<change-id>/review.md` 記錄核准者、原始確認的對話摘要或 PR 審查連結、範圍及文件版本。若審查的是已提交文件，可以 commit SHA 記錄版本。
直接使用 `$openspec-apply-change` 或接續實作前，皆須核對這份紀錄與目前提案。缺少紀錄或無法核對時，停在人工審查。
需要調整提案時使用 `$openspec-update-change`；範圍實質變更須重新確認。
實作後執行實際測試、`$openspec-verify-change` 與嚴格驗證，再使用 `$openspec-sync-specs`、`$openspec-archive-change`；多項已完成變更可用 `$openspec-bulk-archive-change`。
CLI 與 Skills 不會技術性強制人工核准；代理必須遵循 `AGENTS.md`，審查者也應核對核准紀錄。

## 驗證範圍

初始化不建立產品功能提案，不含應用程式測試套件。
驗證 CLI、八項 workflow 設定、八個 Skill 檔案、專案根目錄辨識及 spec-driven schema。
功能性驗證使用 checkout 外的暫存專案建立具體測試提案，執行嚴格規格驗證及 apply 指引解析，避免將測試提案混入本專案。
空專案的 `validate --all` 沒有項目可驗證，不能當成產品測試通過。
