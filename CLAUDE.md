# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

GeidaiConnect — 東京藝術大学OB限定のレッスン・仕事紹介サービス。
React 19 + TypeScript + Vite のフロントエンドと、Firebase（Auth / Firestore / Cloud Functions / Storage）のバックエンドで構成。決済は Stripe Checkout、メール送信は Nodemailer（SMTP）。UI・コメントは日本語。

## コマンド

フロントエンド（`my-app/` ルートで実行）:

```bash
npm run dev        # Vite 開発サーバー起動
npm run build      # tsc -b && vite build（型チェック込みビルド）
npm run preview    # ビルド結果のプレビュー
```

Cloud Functions（`functions/` で実行）:

```bash
npm run build      # tsc でコンパイル（lib/ に出力）
npm run serve      # firebase emulators:start --only functions
firebase deploy --only functions   # デプロイ（predeploy で lint と build が走る）
```

テストフレームワークと ESLint 実行スクリプトは未設定。型チェックは `npm run build` で行う。

## アーキテクチャ

### 認証とロール

- 認証状態は [src/contexts/AuthContext.tsx](src/contexts/AuthContext.tsx) の `AuthProvider` が一元管理（main.tsx で Router 内に配置）。`useAuth()` で `{ user, role, loading }` を取得する。
- ロール（`admin` / `teacher` / `student`）は Firebase Auth ではなく Firestore の `users/{uid}` ドキュメントの `role` フィールドから読む。
- 講師専用ページは [src/components/RequireTeacher.tsx](src/components/RequireTeacher.tsx) でガード（App.tsx の `/schedule-form`, `/schedule-list`）。
- メール検証メールはユーザー作成時に Functions の `sendVerifyEmail`（Auth onCreate トリガー）が自動送信する。フロントから送ってはいけない（`src/hooks/useAuth.ts` 参照）。

### 予約・決済フロー（Stripe）

1. フロント: [src/lib/checkout.ts](src/lib/checkout.ts) の `createReservationAndGoToCheckout()` が callable 関数 `createReservationAndCheckout` を呼ぶ。
2. Functions: Firestore に `reservations` ドキュメントを作成し、Stripe Checkout セッションを生成して URL を返す → フロントがリダイレクト。
3. `stripeWebhook`（onRequest）が決済完了を受けて予約ステータスを更新。成功ページは `getReservationForSuccess`（onRequest）で予約情報を取得。
4. ルーティング上、`/reserve` と `/reservation` は両方 ReservationForm を指す（Stripe の cancel_url 互換のため両方残すこと）。

### キャンペーン（クーポン・友達紹介）

- 実装は [functions/src/campaigns.ts](functions/src/campaigns.ts) に集約。index.ts は再エクスポートのみ（campaigns.ts から index.ts を import しないこと。循環参照になる）。
- クーポンの状態は `available` / `reserved` / `used` / `expired` / `cancelled`。Checkout 作成で reserved、決済完了 webhook で used、期限切れ・失敗で available に戻す。
- 値引き額はフロントから受け取らない。クライアントが送るのは `couponId` だけで、金額はサーバーが再計算する（`judgeCoupon`）。
- 付与の重複防止は `couponGrants/{決め打ちID}`。レビューを削除して再投稿しても再付与されない。
- レビューの作成は `submitReview`（callable）経由のみ。`firestore.rules` で reviews の create は禁止。
- 仕様と運用手順は [docs/campaigns.md](docs/campaigns.md)。

### Cloud Functions（functions/src/index.ts ＋ campaigns.ts）

- firebase-functions **v1 API**（`firebase-functions/v1`）を使用。リージョンは `us-central1`（フロントの `getFunctions(app, "us-central1")` と一致させること）。
- 環境変数は `defineString()` パラメータで定義: SMTP_*, APP_URL, STRIPE_SECRET_KEY, STRIPE_SUCCESS_URL, STRIPE_CANCEL_URL, STRIPE_WEBHOOK_SECRET。
- エクスポート（onCall/onRequest）: `sendVerifyEmail`, `resendVerifyEmail`, `createCheckoutSession`, `getAvailableStudios`, `createReservationAndCheckout`, `getReservationForSuccess`, `stripeWebhook`, `cancelReservation`, `rescheduleReservation`, `setMeetingUrl`, `submitContact`, `submitRequest`, `submitTeacherApplication`, `studioAdminHttp`, `submitReview`, `getMyReferralCode`, `checkReferralCode`, `applyReferralCode`。
- スケジュール実行（pubsub）: `sendLessonReminders`（レッスン前リマインド）, `releaseExpiredHolds`（期限切れ pending の枠解放）, `captureDueAuthorizations`（締切を過ぎたカード与信のキャプチャ）, `finalizeCompletedLessons`（レッスン完了の確定と紹介特典の判定）, `expireCoupons`（期限切れクーポンの整理）。

### Firestore

主なコレクション: `users`（本人のみ read/write）, `reservations`（削除禁止）, `reviews`（作成は Functions のみ）, `schedules`（read は公開）, `coupons`（本人のみ read）, `couponGrants` / `referralCodes`（admin のみ read）, `referrals`（紹介者・被紹介者が read）。ルールは [firestore.rules](firestore.rules)。

### フロントエンド構成

- Firebase 初期化は [src/firebase.ts](src/firebase.ts)。設定値は `VITE_FIREBASE_*` 環境変数（`.env.local`）から取得。
- トップページの講師一覧は [src/data/teachers.ts](src/data/teachers.ts) の静的データ（`Teacher` / `LessonCourse` 型もここで定義）。都道府県・市区町村・ジャンルのマスタも `src/data/` にある。
- 予約カレンダーは [src/components/booking/BookingCalendar.tsx](src/components/booking/BookingCalendar.tsx)。祝日判定に `jp-holiday` を使用。
- ルート定義は [src/App.tsx](src/App.tsx) に集約。ページは `src/pages/`（講師向けは `src/pages/teachers/`、生徒向けは `src/pages/student/`）。

### 注意点

- `bk_Login.tsx`, `bk_index.css`, `*.bak` はバックアップファイル。編集・参照しない。
- Firestore のクエリは等価条件のみで組む（範囲条件を混ぜると複合インデックスが必要になり、firestore.indexes.json を管理していないため）。日付の絞り込みは取得後にメモリ上で行う。
- フロントは ESM（`"type": "module"`）、functions は CommonJS（`"type": "commonjs"`、Node 22）。
