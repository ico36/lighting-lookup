# CLAUDE.md

このファイルは、このリポジトリでClaude Codeが作業する際のガイダンスです。

## プロジェクト概要

電気工事士向けWebアプリ「照明サーチ」。照明器具の型番・写真から後継器・互換品をAI（Claude + Web検索）で調査し、発注メモ・見積書の作成までを支援する。個人事業主が知人の電気工事士3人に向けて運用中、月額サブスク（Stripe）で提供。

## アーキテクチャ

```
ブラウザ（public/index.html）
  ↓ fetch（Bearer トークン付き）
Vercel Serverless Functions（api/*.js）
  ↓
Anthropic API（Claude + web_search ツール） / Stripe / Upstash Redis / Vercel Blob
```

- **フロントエンド**: `public/index.html` 一枚に HTML/CSS/JS がすべて入っている。ビルドステップなし、フレームワークなし（vanilla JS SPA）。npmパッケージはフロントには使わない。
- **API**: `api/` 直下のファイルがそのままVercel Serverless Functionsとしてzero-config公開される（Next.jsではない）。`api/_auth.js` のようにアンダースコア始まりのファイルは公開エンドポイントにならない共通ヘルパー用の命名規則。
- **認証**: メールアドレス＋Stripeサブスク状態のその場確認（`api/login.js`）。ログイン成功でHMAC署名付きセッショントークン（有効期限30日）を発行し、以後は `Authorization: Bearer <token>` で送信。検証は `api/_auth.js` の `requireAuth()` を各APIの先頭で呼ぶ。
- **DB**: Upstash Redis（`@upstash/redis`）。ログインのレート制限・自社情報・会員番号・OTP・ウェルカムメール送信済み・経営統計の「現在有効」SET/週次スナップショットなど、用途は機能追加とともに増えている（網羅的な列挙はしない。各`lib/*.js`の冒頭コメントに個別のキーの説明がある）。
- **ファイル保存**: Vercel Blob（`@vercel/blob`）。現状の用途はロゴ画像のみ（`api/company-logo.js`）。
- **Vercelプラン**: 2026-11-01にHobbyからProへ移行済み。Serverless Functionの**12個上限は無くなった**。Hobby時代はこの上限のために「新規APIエンドポイントを増やさず既存ファイルに機能を相乗りさせる」という設計判断を複数の箇所でしていた（`lib/ownerDeletion.js`、`api/company.js`、`api/info/[type].js`、`api/cron/process-cases.js` 等のコメント参照）。これらのコメントは移行前の制約を理由にしたものなので、新規APIファイルを追加するかどうかの判断では**この上限はもう考慮しなくてよい**（既存コメントの文言はまだ更新していない箇所がある）。

## 経営統計ページ（stats.ma-system.co.jp）

- 共同経営者が都道府県別の契約状況を個人で確認するための、照明サーチ本体とは別の画面。照明サーチのアプリ内（`public/index.html`）には一切出さない。同じVercelプロジェクト・同じドメイン群内だが、`vercel.json`の`rewrites`で**ホストが`stats.ma-system.co.jp`のときだけ**`/`を`/stats/index.html`へ書き換えて提供する（新しいVercelプロジェクトは作らない）。
- 実体ファイルは`public/stats/index.html`・`api/stats/*.js`・`lib/stats*.js`・`lib/contractStats.js`で、照明サーチ本体のファイル（`api/login.js`・`api/_auth.js`・`lib/otp.js`の既存呼び出し等）には影響を与えない設計にしている。`lib/otp.js`だけはnamespaceオプションを追加したが、既定値は元の挙動と完全に同一（既存呼び出し側は変更不要）。
- ログインは確認コード方式だが、本体とは別の許可リスト（`STATS_VIEWER_EMAILS`。`ADMIN_EMAILS`とは別物）と別の署名鍵（`STATS_SESSION_SECRET`。`SESSION_SECRET`とは別物）を使う。どちらも未設定時はfail-closed（ログイン・APIともに失敗する側に倒す）。
- 「現在、照明サーチの契約が有効(LIVE_STATUSES)かどうか」は、表示・集計のたびにStripeへ問い合わせず、`lib/contractStats.js`の`contract-status:active`（Redis SET）を読む。このSETはWebhook（`api/stripe-webhook.js`）が契約状態の変化のたびに更新し、日次cron（`api/cron/process-cases.js`）の会員番号採番と同じcandidatesを使い回してバックフィル・取りこぼしの除去を行う（追加のStripe往復なし）。
- 週次（JST月曜、日次cronの中）にRedisへスナップショットを保存し、`STATS_VIEWER_EMAILS`全員へ差分入りのメールを送る。送信は日付ごとの印（`stats:weekly-email:sent:{date}`）で1日1回に制限するが、スナップショットの保存自体は同じ日付なら上書きしてよい（副作用が無いため）。

## 設計方針（変更時に矛盾させないこと）

- **自社情報（社名・電話番号・登録番号・ロゴ）**: ログイン成功直後、Redisに未登録なら他のどの画面よりも先に初回設定画面をブロック表示し、保存が終わるまで先に進めない。一度保存した自社情報は、型番検索→見積書作成フロー内では**表示専用**（編集不可）。編集は独立した「設定画面」からのみ可能。
- **アカウント＝会社**の1対1設計。他社の見積書を誤って発行してしまう懸念はない。
- **管理者バイパス**: `ADMIN_EMAILS` 環境変数に含まれるメールはStripeサブスク確認・レート制限をスキップして常にログイン可能。
- 現状 `api/checkout.js` は `ADMIN_EMAILS` のみ許可（サービス公開前ロック）。新規登録を一般開放する変更は要確認。

## Vercel Blobで踏んだ地雷（再発防止）

- Blobストアには **Public** と **Private** の2種類があり、作成後にアクセス種別は変更できない（CLIにも `update-store` は存在しない）。ロゴURLは `company:{email}` に永続保存して何度も使い回す設計のため、期限付き署名URLが前提の Private では動かない。**必ず Public ストアを使う。**
- 認証方式は接続の仕方によって `BLOB_READ_WRITE_TOKEN`（環境変数）と、`BLOB_STORE_ID` + ランタイム自動注入の `VERCEL_OIDC_TOKEN`（OIDC方式）の2パターンがある。`@vercel/blob` の `put()` はOIDCを優先的に試すため、**古い接続のBLOB_STORE_IDが環境変数に残っていると、有効なBLOB_READ_WRITE_TOKENがあっても古いストア（や削除済みストア）を見に行ってエラーになる**。ストアを作り直したときは、古いストアの環境変数が残っていないか `vercel env ls` で確認すること。
- コード側で特定の環境変数の有無を事前チェックして早期リターンするのは避ける（接続方式によって必要な変数が変わるため誤検知しやすい）。`put()` 自身のエラーをそのまま拾って `console.error` とレスポンスの両方に詳細を出す方針にしてある。
- 環境変数を追加・変更しても、既存のデプロイには反映されない。反映には再デプロイが必要（`git push` でも、`vercel redeploy <url> --target production` でもよい）。
- Vercel CLIはグローバルインストールで権限エラーになりやすいので、必要なら `npm install --prefix <一時ディレクトリ>` でローカルインストールして使う。

## その他の運用メモ

- サーバーレス関数のコールドスタート対策として、UptimeRobotが `/api/analyze` に5分おきにpingしている。フロント側にも `fetchWithRetry()`（最大2回リトライ）を実装済み。
- デプロイはGitHub `main` へのpushでVercelが自動実行。CIテストは無い。
- コミット・push・Vercel本番環境への直接操作（Blobストア作成/削除、Redeployなど）は、都度ユーザーの明示的な許可を得てから行うこと（過去のセッションで確立した運用ルール）。
- **コマンド実行時の申告**: シェルコマンドを実行する前に、それが「読み取りのみ」か「書き込みを伴う」かを1行で明示すること。読み取りのみは「読み取り専用です（ファイルの変更なし）」、書き込みありは何をどう変更するかを1行で述べる。判断がつかない場合は「書き込みの可能性あり」として扱う。特に `node -e` / `python -c` のように引用符の中がコードになる形式は、中身に `fs.write` 等が含まれないか確認したうえで申告する。
- コミットメッセージ末尾に `Co-Authored-By` / `Claude-Session` 行は書かない。モデル名を確定できないまま推測で埋めると事実と異なる記録が残るため（実際に「Claude Sonnet 5」と書かれたが正しくは Opus 5 だった事例あり）。
- **cron(`api/cron/process-cases.js`)を呼ぶテストは必ず`globalThis.fetch`をスタブすること**。ウェルカムメール送信保険のステップが、有効なサブスク候補が1件でもあればResendへ実際にfetchする。スタブを忘れると、テストごとに実際のネットワークリクエストが飛び、無効なAPIキーで401が返り続ける（2026-11-05に`tests/api/cron.member-no.test.mjs`等4ファイルで発覚・修正した実例あり）。

## 会社Stripeアカウントへの移行時のTODO

- 移行で3つのPrice IDを作り直したら、新しいPrice IDが正しく読み込めるか照合すること。`api/info/[type].js`（管理者専用の軽量参照エンドポイント群）に確認用の項目を追加し、3つのPrice IDそれぞれについて「取得可否・livemode・商品名(product.name)・metadata.plan」を返すようにして突き合わせる。

## 開発の背景・設計判断の記録

過去の設計判断・実装経緯・つまずいた点はObsidianに記録されている：

```
/Users/Masato_Ikoma/Library/Mobile Documents/com~apple~CloudDocs/My brain/Claude会話ログ/アプリ開発/照明サーチ/
```

大きめの機能追加や設計判断が絡むタスクに着手する前は、このフォルダの最新ログに目を通し、既存の方針と矛盾しないか確認する。なお「アカウント別見積書フォーマット対応」（個別対応5万円 or 上位プランへのテンプレ機能組み込み）は2026-07-18時点でまだ検討中の案であり、決定事項ではない。
