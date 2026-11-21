# Proposal

## Why

目前組別只能使用系統代號 G01，課堂辨識度不足。讓組長建立時命名，可讓教師、學生、公開結果與學習單使用易辨識的組名，同時保留穩定代號供內部識別與舊資料相容。

## What Changes

- 建組時要求輸入組名；修整後限 1–20 字元、不得含換行或控制字元，且同活動唯一。
- 保留 G01 等公開代號作內部穩定識別；新場次以組名呈現教師監看、學生結果及勝組。
- 將 Sheets「搶答勝組」格的預期與寫入值改為勝組名稱。
- **BREAKING** 新建立場次的建組 API 需提供組名；舊活動與歷史結果持續以既有代號顯示及回寫。

## Capabilities

### New Capabilities

### Modified Capabilities

- `classroom-session`: 建組名稱、唯一性、重送與重新加入。
- `classroom-results`: 組名的教師、學生與公開結果顯示。
- `guided-notes-writeback`: 勝組格回寫組名與舊場相容。

## Impact

影響 SQLite `groups_` 遷移、建組 API 與學生表單、共用型別、教師／學生畫面、勝組回傳、寫回預覽與測試。
