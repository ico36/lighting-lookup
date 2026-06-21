# 照明サーチ（lighting-lookup）

電気工事士向け：照明器具の型番・写真から後継器を調査し、見積書を作成するツール。

## デプロイ手順（Vercel）

### 1. GitHubにアップロード
このフォルダの内容をGitHubの新しいリポジトリにアップロードする。

### 2. Vercelでプロジェクトを作成
1. https://vercel.com にアクセスし、GitHubアカウントでログイン
2. 「Add New」→「Project」
3. アップロードしたリポジトリを選択して「Import」
4. 設定はデフォルトのままでOK（Vercelが自動でNode.js環境と認識する）

### 3. 環境変数を設定
Vercelのプロジェクト設定 →「Settings」→「Environment Variables」で以下を追加：

| Key | Value |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.comで取得したAPIキー |
| `APP_ACCESS_CODE` | 使う人に共有する合言葉（好きな文字列。例：denko2026） |

### 4. デプロイ
「Deploy」ボタンを押すと数十秒でURLが発行される（例：`https://lighting-lookup.vercel.app`）

### 5. 使う人に共有するもの
- 発行されたURL
- `APP_ACCESS_CODE`に設定した合言葉

## 注意事項
- `APP_ACCESS_CODE`を知っている人は誰でもAPIを使える＝課金が発生するので、3人以外には教えないこと
- コードを変更したい場合は、GitHub上のファイルを更新すればVercelが自動で再デプロイする

## ファイル更新時の注意
既存のGitHubリポジトリにこの一式を上書きアップロードする場合、`api`フォルダと`public`フォルダの中身がすべて更新されていることを確認してください（特に`api/product-detail.js`は新規ファイルです）。アップロード後はVercelが自動的に再デプロイします。
