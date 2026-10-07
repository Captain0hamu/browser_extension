# manaba Folder Sync

Firefoxでポータルを経由してmanabaにログインしたあと、資料リンクを右クリックして選ぶと、登録済みコースのローカルフォルダーへ直接保存するローカル専用サービスです。

実装を自分で読んだり改造したりするための、Web開発の基礎から説明したガイドは [DEVELOPMENT_GUIDE.html](DEVELOPMENT_GUIDE.html) です。ブラウザーで直接開けます。

Cookieや大学アカウントのパスワードをファイルへ保存しません。Firefox拡張が `tid.manaba.jp` のログイン済みCookieを**資料を保存するその都度だけ** `127.0.0.1` のサービスへ送ります。サービスは外部には公開せず、Cookieをログにも書きません。

## 設計

```text
Firefox: portal.tid.ac.jp で手動ログイン
  → ポータルの manaba リンクを開く
  → manaba の資料リンクを右クリックして「授業フォルダーへ保存」
  → 拡張機能: 現在タブの course_<ID> とCookieをローカルAPIに送る
  → ローカルAPI: course ID → 設定済みの ~/Documents 配下パスへ保存
```

- コースIDと保存先の対応は設定ファイルだけで管理します。未登録のコースへは保存しません。
- APIは `127.0.0.1` でのみ待ち受け、Bearer tokenを必須にします。
- 保存先は `storage.root`（既定では `~/Documents`）外に設定できません。
- 同名ファイルは既定で `name (1).pdf` のようにリネームし、既存資料を上書きしません。

## 初期化（NixOS）

このディレクトリで、依存を用意して設定ファイルを作成します。

```bash
nix develop path:.
python -m manaba_folder_sync.cli init
```

`~/.config/manaba-folder-sync/config.toml` を開き、`[courses."コースID"]` を追加して、好きな `~/Documents` 配下の `path` を指定してください。コースIDはmanabaを開いたときのURLにある `course_1234567` の数字です。

対応表は次の辞書です。未登録のIDは保存されません。

```toml
[courses."1234567"]
name = "Web Programming"
path = "~/Documents/University/2026-autumn/Web Programming"

[courses."7654321"]
name = "Design Theory"
path = "~/Documents/University/2026-autumn/Design Theory"
```

起動は次です。

```bash
python -m manaba_folder_sync.cli serve
```

Firefoxの `about:debugging#/runtime/this-firefox` で「一時的なアドオンを読み込む」から、このリポジトリの `extension/manifest.json` を選びます。拡張機能の設定画面で、設定ファイルの `server.token` を入力してください。

### 現行コースの対応表候補を作る

manabaを開いたタブで拡張機能のアイコンを押し、**現行コースから対応表を作成**を選びます。ログイン済みCookieをそのリクエスト中だけローカルAPIに渡し、manabaの現在選択可能なコースと `~/Documents` 直下の非隠しフォルダーを照合します。

比較では大文字小文字・空白・`_`・`-`だけを無視します。現行コースにない古い授業フォルダーは候補になりません。結果は「一致」「未一致」「登録済み」「未使用フォルダー」に分けて表示され、一致分はTOMLとしてコピーできます。`config.toml` は自動変更されないため、内容を確認・修正してから手動で追加してください。

### ポータルのログイン入力を自動化する

これはID・パスワードをFirefoxや設定ファイルに保存せず、NixOSのSecret Serviceから一回ずつ読み込んで入力します。`secret-tool` を利用できる状態で、一度だけ以下を実行します（値はプロンプトで入力され、履歴には残りません）。

```bash
secret-tool store --label='TID portal username' service manaba-folder-sync account tid field username
secret-tool store --label='TID portal password' service manaba-folder-sync account tid field password
python -m manaba_folder_sync.cli install-native-host
```

その後、拡張機能を読み込み直します。`portal.tid.ac.jp` またはMicrosoftのログイン画面にID・パスワード欄が現れると自動入力されます。拡張機能の設定で「送信も自動化」を有効にしない限り、送信は自分で確認して行います。MFA・認証アプリ・追加確認は自動化しません。

## 使い方

1. Firefoxで `https://portal.tid.ac.jp` に手動ログインし、ポータル内のmanabaを開く。
2. 保存したい資料のリンクを右クリックする。
3. **このmanaba資料を授業フォルダーへ保存** を選ぶ。

ログインが切れている場合は、先にポータルからmanabaを開き直してください。現時点ではコースIDをURLから判定するため、資料一覧など当該コース配下のページで実行します。

## ローカルAPI

`GET /v1/courses`、`POST /v1/courses/discover`、`POST /v1/courses/mapping-candidates`、`POST /v1/downloads` を提供します。全て（`/v1/health` を除く）`Authorization: Bearer <token>` が必要です。`downloads`、`discover`、`mapping-candidates` ではFirefox Cookie配列をリクエストごとに渡します。Cookieの永続化APIは意図的に提供しません。`mapping-candidates` は設定ファイルを書き換えず、現行コースとの一致、未一致、登録済み、未使用フォルダーを返す読み取り専用APIです。
