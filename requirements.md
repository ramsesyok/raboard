
# raBoard（VS Code Extension, Serverless via Shared Folder）

**版:** v0.2（Full）
**作成日:** 2025-11-12 (JST)
**目的:** チーム内で軽量な掲示板/簡易チャットを VS Code 上に提供する。サーバ無しで、Windows 共有フォルダ（UNC）をストレージとして利用。

---

## 1. スコープ

* **対象:** VS Code デスクトップ版の拡張機能。
* **UI:** Webview（Sidebar/Panel）主体。**Chat API は不使用**（将来の補助用途は可）。
* **ストレージ:** Windows ファイル共有（SMB）上の UNC パス `\\mysv01\board`。
* **機能範囲:** タイムライン表示、投稿、ルーム切替、在席表示、画像プレビュー（png/jpg/jpeg/svg）、添付ディレクトリをOSで開く、手動コンパクション（spool → 日別NDJSON）。
* **非対象:** 外部SaaS連携、独自サーバ、全文検索、厳密な既読/通知、VS Code Web対応。

---

## 2. 用語

* **共有ルート（Share Root）:** 既定 `\\mysv01\board`。
* **ルーム（Room）:** 論理チャンネル（既定 `general`）。
* **spool:** `rooms/<room>/msgs/` に一時的に蓄積される「1投稿=1ファイル」のメッセージ群。
* **NDJSONログ:** `rooms/<room>/logs/YYYY-MM-DD.ndjson` に集約された日別ログ。
* **在席（Presence）:** `presence/<user>.json` の最終更新でオンライン判定。

---

## 3. 前提・制約

* **サーバ無し**（SMB のみ）。
* **OS/クライアント:** Windows 前提（UNC, `path.win32`）。
* **監視:** SMB での通知取りこぼしを避けるため **ポーリング**（既定 5s）。
* **時刻と順序:** 投稿側ローカル時刻を使用。**ファイル名（タイムスタンプ＋ID）の昇順**で安定化。
* **権限:** 共有フォルダへの読書き権限が必要。
* **CSP:** Webview 内で完結（外部サイト接続なし）。`object-src 'none'` 等を適用。
* **Chat API:** 使用しない（v0）。

---

## 4. 画面要件（Webview / Sidebar）

* **レイアウト:**

  * ヘッダ：タイトル、ルーム入力＋Switch、Attachments…（フォルダを開く）
  * 本文：タイムライン（送信者、日時、本文、画像プレビュー）
  * フッタ：メッセージ入力＋Send、オンラインユーザ表示（pills）
* **操作:**

  * 送信（Enter）、改行（Shift+Enter）
  * ルーム切替（存在しなければ自動作成）
  * 添付フォルダを OS（Explorer）で開く
* **表示:**

  * URL は自動リンク化
  * 画像（png/jpg/jpeg/svg）をインライン表示（高さ上限適用）
  * 破損/巨大画像はリンクにフォールバック
* **初期ロード:** 末尾 **最大200件** を読み込み、その後は差分のみ。

---

## 5. 機能要件

### 5.1 投稿（spool 書き込み）

* 1投稿=1 JSON ファイルを `rooms/<room>/msgs/` に **`tmp → rename` の原子的反映**。
* **ファイル名規則:** `YYYY-MM-DDTHH-MM-SS-sssZ_<rand>.json`（例: `2025-11-12T03-21-45-123Z_ab12cd34.json`）
* 送信直後はローカルUIへ即時反映（次回ポーリング待ち不要）。
* **本文が空**の場合は送信不可。

### 5.2 タイムライン

* 既定 5s ポーリング。
* 初回は末尾200件のみ読み込み、以降は最後に見たファイル名より後だけ読む。
* 不正JSONはスキップ（ログ出力）。

### 5.3 ルーム切替

* 入力したルームへ切替。
* 必要なディレクトリ（msgs/attachments/logs）を自動作成。
* 切替時はタイムラインを初期化し、末尾200件を再読み込み。

### 5.4 在席（Presence）

* `presence/<user>.json` を **30s毎** に `tmp→rename`。
* **TTL:** 既定 60s 以内更新のユーザをオンライン表示。
* ユーザ名は既定 OS ユーザ名（設定で上書き可）。

### 5.5 添付（画像のみ）

* 対応拡張子：`.png`, `.jpg`, `.jpeg`, `.svg`（**画像限定**）。
* **運用:** `rooms/<room>/attachments/` に直接配置し、本文に相対パスを書けばインライン表示を試みる。
* 送信時に拡張子ホワイトリスト＋簡易シグネチャを検査（PNG: `89 50 4E 47` 等／SVGは `<svg` 先頭など）。
* **サイズ上限:** 既定 `10MB` を超える場合はリンク表示にフォールバック。
* **描画:** `<img src="{webviewUri}">` のみ。**`<object>`/`<iframe>` は禁止**。
* **サムネイル生成:** v0 では無し（将来検討）。

### 5.6 設定（VS Code Settings）

* `raBoard.shareRoot`（string, 既定 `\\\\mysv01\\board`）
* `raBoard.defaultRoom`（string, 既定 `general`）
* `raBoard.userName`（string, 既定 OS ユーザ名）
* `raBoard.pollIntervalMs`（number, 既定 5000, 最小 1000）
* `raBoard.presenceTtlSec`（number, 既定 60, 最小 15）
* `raBoard.maxImageMB`（number, 既定 10）
* `raBoard.maxInlinePx`（number, 既定 240）

### 5.7 初回起動・自己修復

* `rooms/<room>/{msgs,attachments,logs}` と `presence/` を自動作成。

### 5.8 メッセージJSONのシリアライズ規約

* **改行・インデントなし**で保存し、**末尾に改行1つ（`\n`）を必ず付与**。
* これにより「**常に1行＝NDJSON 1レコード**」の性質を保証。

### 5.9 NDJSONログ（ルーム単位 / 日別）

* 生成先：`rooms/<room>/logs/YYYY-MM-DD.ndjson`（JST基準。必要なら設定化）。
* 各行は1メッセージの JSON（spool の JSON をそのまま1行で追記）。

### 5.10 **手動**コンパクション（spool → NDJSON）

* **起動:** コマンドパレット「raBoard: Compact Logs…」。
* **入力:**

  * ルーム選択
  * 期間プリセット

    * 「**昨日まで**」（推奨）
    * 「**日付指定（～指定日まで）**」
    * 「**当日を除く全期間**」
* **対象:** 指定期間に該当する `rooms/<room>/msgs/*.json`。
* **排他:** `rooms/<room>/logs/.lock` による簡易ロック（`open('wx')`/`mkdir`、TTL付き）。
* **手順:**

  1. 対象spoolを**名前昇順**に走査
  2. 各メッセージの `ts` に基づく **該当日** の `.ndjson` に **append**
  3. **append成功後** に当該spoolを削除（順序厳守）
  4. 途中失敗時はロック解放、未処理spoolは残置（再実行可）
* **重複対策:** 末尾数行のID重複チェックは任意。
* **自動/定期実行:** **行わない**（将来機能）。

---

## 6. データ仕様

### 6.1 ディレクトリ構成（共有ルート直下）

```
\\mysv01\board
├─ rooms/
│  └─ <room>/
│     ├─ msgs/            # 1投稿=1JSON（append禁止）
│     ├─ attachments/     # 画像添付置き場
│     └─ logs/            # 日別NDJSON（手動コンパクションで生成）
└─ presence/
   └─ <user>.json         # 在席ハートビート
```

### 6.2 メッセージ JSON スキーマ

```json
{
  "id": "ab12cd34",
  "ts": "2025-11-12T03:21:45.123Z",
  "room": "general",
  "from": "alice",
  "type": "msg",
  "text": "こんにちは",
  "replyTo": null,
  "attachments": [
    {
      "relPath": "attachments/cat.png",
      "mime": "image/png",
      "display": "inline"   // "inline" or "link"
    }
  ]
}
```

* `attachments` は将来UI強化時に本格運用。現時点は本文の相対パス記載だけでも可。

### 6.3 在席 JSON スキーマ

```json
{ "user": "alice", "ts": "2025-11-12T03:22:00.000Z" }
```

* オンライン判定は `mtime` または `ts` の新しい方で実装可。

### 6.4 NDJSONファイル

* 路径：`rooms/<room>/logs/YYYY-MM-DD.ndjson`
* 内容：1行=1メッセージの JSON（末尾に `\n`）
* サイズ運用は任意（週次圧縮などは将来検討）。

---

## 7. 非機能要件

* **想定規模:** 同時 5〜10 ユーザ、1日 数百〜千投稿。
* **体感性能:** ポーリング5sで UI 反映 5〜10s 以内。
* **初回読み込み:** 200件上限。
* **spool増大の影響:** **手動コンパクションを行わない期間が長いと** `msgs/` での一覧が重くなるため、適宜「昨日まで」を実行することを推奨。
* **可用性:** SMB 一時断・権限不足時もUIは落ちず、復帰後に再開。
* **セキュリティ:** 認証/認可は共有フォルダの ACL に委譲。拡張は外部通信しない。

---

## 8. エラーハンドリング

* 共有ルート未到達/権限不足 → バナー表示と再試行。
* 投稿 `rename` 失敗 → 一時ファイル残置、再送案内。
* JSON 破損 → スキップしてログ、**手動で `msgs_bad/` へ隔離**（コンパクション時は自動隔離）。
* ルーム作成不可 → 理由提示・切替キャンセル。
* コンパクション中ロック取得失敗 → 情報メッセージを出して終了。
* append 失敗 → spool は削除せず残置（再実行で回収）。

---

## 9. セキュリティ/CSP

```
default-src 'none';
img-src ${webview.cspSource};
script-src 'unsafe-inline' ${webview.cspSource};
style-src 'unsafe-inline' ${webview.cspSource};
object-src 'none';
media-src 'none';
```

* 画像は **`webview.asWebviewUri` 化**して読み出す。
* **`img-src` に `data:` は原則含めない**（巨大データURI/SVG埋め込み回避）。
* SVG は `<img>` のみ許可、`<object>`/`<iframe>` は禁止。

---

## 10. インストール/配布

* `.vsix` で配布（オフライン配布可）。
* 初回起動で必要フォルダ自動作成。権限不足時はエラー表示。

---

## 11. ログ/テレメトリ

* 拡張の動作ログを VS Code 出力チャネルへ（INFO/ERROR）。
* メッセージ本文を外部送信しない。

---

## 12. 受け入れ基準（Acceptance Criteria）

* [ ] 空の `\\mysv01\board` でも初回起動で `rooms\general\{msgs,attachments,logs}` と `presence` が作成される
* [ ] 2台以上のクライアント間で、Aの投稿が **10秒以内** にBへ反映
* [ ] 在席は **60秒以内** に相互表示される
* [ ] 画像（png/jpg/jpeg/svg）が **240px上限でインライン表示**、クリックで OS 既定ビューアが開く
* [ ] **10MB超** の画像はリンク表示にフォールバック
* [ ] メッセージJSONが **常に1行＋末尾改行** で保存される
* [ ] コマンド「**Compact Logs…**」で指定ルーム・期間の spool が **日別NDJSONに追記** され、**spoolは削除**される
* [ ] コンパクションの同時実行は **ロック** により1つだけが進行
* [ ] JSON破損や一時的な共有断でも UI は生存し、処理は再開可能

---

## 13. リスクと対策

* **spoolの肥大化** → 運用で「昨日まで」コンパクションを適宜実行。
* **時計ずれによる順序乱れ** → ファイル名にID併用・UI側で `ts,id` ソート。
* **SMB一時断** → 例外を握り、次周期で再試行。
* **巨大画像の負荷** → `maxInlinePx`/`maxImageMB` を設定し、必要なら将来サムネイル生成。

---

## 14. 設計根拠（なぜ直接NDJSONに append しないか）

* SMB上の同一ファイル同時appendは原子保証が弱く、**行の混在/欠落**の恐れ。
* **spool（rename原子）→append→削除**で、少なくとも一回の確実な公開と再試行の容易さを両立。

---

## 15. 将来拡張（Out of Scope for v0）

* 自動/定期コンパクション、週次圧縮（`.ndjson.gz`）、簡易オフセット索引
* スレッド/返信表示、メンション/通知、リアクション
* 画像アップロードUI（ドラッグ&ドロップ）と添付メタ正式運用
* ローカル索引/検索、履歴ビュー（複数日 tail 連結）
* macOS/Linux クライアント対応

---

## 16. 設計確認事項（要回答）

1. 既定ユーザ名：OSユーザ名のままで良いか（将来AD表示名への切替要望は？）
2. 初回読み込み200件：十分か（設定化の要望は？）
3. 在席TTL=60s：妥当か
4. 画像上限：`maxImageMB=10` / `maxInlinePx=240` の初期値で問題ないか
5. コンパクション期間プリセットの文言・既定（「昨日まで」を既定で良いか）
6. 共有フォルダのACL/バックアップ運用はどの部門が担うか

---

必要に応じて、この要件書に「運用手順（例：週1で“昨日まで”を実行）」や「コンパクション結果サマリの表示仕様」を追補できます。
