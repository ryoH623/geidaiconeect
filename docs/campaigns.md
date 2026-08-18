# キャンペーン（レビュー投稿 / 友達紹介）とクーポン

作成日: 2026-08-17 / ステータス: **実装済み・未デプロイ**

実装は `functions/src/campaigns.ts` に集約している（index.ts からは再エクスポートのみ）。

---

## 1. レビュー投稿キャンペーン

レッスン完了後にレビューを投稿した生徒へ、**500円クーポン**を1回だけ付与する。

### 付与条件（すべて満たす場合のみ）

| 条件 | 実装 |
|---|---|
| 支払い済みのレッスン | `paymentStatus === "paid"` |
| 予約が完了扱い | `reservationStatus === "confirmed"` かつレッスン日が過去（`isLessonCompleted`） |
| 予約者本人の投稿 | `reservation.userId === context.auth.uid` |
| 同じ予約で未付与 | `couponGrants/review_res_{予約ID}` が存在しない |
| キャンセル・返金でない | 上記の2条件で除外（cancelled/refunded/voided は通らない） |
| 1ユーザー1回 | `couponGrants/review_user_{uid}` が存在しない |
| 星の数・内容は不問 | 判定に一切使わない |
| 管理者・講師は対象外 | `users/{uid}.role === "student"` のときのみ付与 |

**レビュー削除後の再投稿で再取得できない理由**: 付与の記録は `coupons` でも `reviews` でもなく、
`couponGrants` という独立した台帳に残す。ドキュメント ID を決め打ち（`review_user_{uid}`）に
しているため、トランザクション内でクエリなしに既付与を判定できる。レビューを消しても台帳は残る。

レビュー自体は削除後に投稿し直せる（クーポンは出ない）。1予約1レビューの制約は、
`reservation.reviewId` が指すレビューが**今も存在するか**で判定している。

### 画面

- 投稿画面 `/mypage/review`: 受講済みの予約を選択 → 評価・コメント。キャンペーンの説明を常時表示。
- レビュー一覧: `campaign` フィールドを持つレビューにのみ注記を出す。
  過去のレビュー・通常投稿には出ない（クーポンが出なかった投稿には `campaign` を入れない）。

レビューの作成は **Cloud Functions 経由のみ**（`firestore.rules` で `reviews` の create を禁止）。
クライアントから書けると付与条件を検証できず、`campaign` フィールドも詐称できてしまうため。

---

## 2. 友達紹介キャンペーン

| 特典 | タイミング | 金額 |
|---|---|---|
| 被紹介者 | 初回レッスンの完了時 | 500円 |
| 紹介者 | 被紹介者が3回目のレッスンを完了した時 | 1,000円 |

### 紹介コード

- 形式 `GC-XXXXXX`（6桁）。連番ではなく乱数。見間違えやすい `0/O/1/I/L` は使わない
- `users/{uid}.referralCode` と `referralCodes/{code}` の両方に保存（後者は逆引き用）
- 初回アクセス時に `getMyReferralCode` が採番する。衝突したら引き直す
- 確認・コピーできる場所: マイページ、友達紹介ページ `/referral`
- **コードを持てるのは生徒と管理者**（`canOwnReferralCode`）。運営者自身が知人を紹介する
  ケースがあるため管理者も対象にしている。講師は対象外。
  なお**コードを入力する側（被紹介者）は生徒のみ**で、ここは変えていない

### 紹介コードの登録（`applyReferralCode`）

- 会員登録フォーム、または初回予約前まで
- `referrals/{被紹介者uid}` を作成。**ドキュメント ID が被紹介者の uid** なので二重登録できない
- 登録後の変更は不可（既存ドキュメントがあれば `already-exists`）
- 決済まで進んだ予約（`paid` / `authorized`）が1件でもあれば拒否
  → 既存ユーザーが後から入力して特典を受けることはできない
- 紹介者と被紹介者が同一、または**同じメール・同じ電話番号**なら `blocked: true` を立てて特典を止める。
  登録自体は通し、理由を `blockedReason` に残す

**運営の手動対応**: `referrals/{uid}.blocked` を `false` にすれば特典判定が再開する。
逆に不正が判明したら `true` にすれば止まる。付与済みクーポンを止める場合は
`coupons/{id}.status` を `cancelled` にする。

### 特典の付与タイミング

`finalizeCompletedLessons`（毎日 3:00 JST）が、レッスン日を過ぎた
`paid` かつ `confirmed` の予約に `lessonCompleted: true` を立てる。
完了数が変わったユーザーについてのみ `processReferralMilestones` を回す。

- 回数は `reservations` の `lessonCompleted === true` を数える。
  キャンセル・返金された予約はフラグが立たないため回数に入らない
- 紹介者への特典は、**紹介者自身に完了レッスンが1回以上ある**場合のみ。
  管理者アカウントもこの条件は同じ（受講実績がなければ 1,000円クーポンは出ない）。
  被紹介者側の 500円クーポンは紹介者の受講実績に関係なく付与される
- 二重付与は `couponGrants/referral_referee_{uid}` / `referral_referrer_{uid}` で防ぐ

> ⚠️ `lessonCompleted` はこの機能の実装以降に作られた予約にのみ入る。
> 既存の予約を回数に含めたい場合は、`lessonCompleted: false` を一括で書き込む必要がある
> （展開前でデータが少ないため、現状は未対応）。

---

## 3. クーポン共通仕様

### 状態遷移

```
available ──(Checkout作成)──> reserved ──(決済完了webhook)──> used
    ^                            │
    └──(Checkout期限切れ/失敗/ロールバック)──┘

available ──(期限切れ)──> expired
any       ──(運営が無効化)──> cancelled
```

- **Checkout を作っただけでは used にしない**。`checkout.session.completed` を受けて確定する
- 同じクーポンを複数の予約で同時に使えないよう、`reserved` への遷移は
  予約作成のトランザクション内で行う（`createReservationAndCheckout`）
- 解放される経路: `checkout.session.expired` webhook / `releaseExpiredHolds` /
  予約作成の失敗時ロールバック / `captureDueAuthorizations` の請求失敗

### 金額の計算順序

1. レッスン基本料金（`lessonAmount`）
2. スタジオ代・出張費などの加算 → `subtotalAmount`
3. クーポン値引き → `couponDiscount`
4. Stripe に渡す決済金額 → `totalAmount = subtotalAmount - couponDiscount`

**フロントから送られた割引額は一切使わない。** クライアントが送るのは `couponId` だけで、
値引き額・最低利用金額・有効期限はサーバーがクーポン本体を読み直して判定する（`judgeCoupon`）。

Stripe の明細にマイナス行は作れないため、値引きは先頭（レッスン料）から順に単価を引く。
0円になった明細は送らない。決済金額が 50円（JPY の下限）を下回る組み合わせは受け付けない。

予約に保存するフィールド: `subtotalAmount` / `couponId` / `couponName` / `couponDiscount` / `totalAmount`。

### 手数料との関係

手数料は**クーポン値引き前のレッスン料**に対して計算する。クーポンは運営が負担する販促費であり、
講師の取り分は減らさない。`reservationPayouts` に `couponDiscount` を併記しているので、
運営の手取り（手数料 − 値引き）はそこから出せる。

### キャンセル時の扱い

`COUPON_ON_CANCEL`（campaigns.ts）で切り替える。

| キャンセルした側 | クーポン |
|---|---|
| 生徒 | 消費したまま（戻さない） |
| 講師 | 利用可能に戻す |
| 運営 | 利用可能に戻す |

現状 `cancelReservation` は生徒本人からの経路しかないため、常に `student` として扱う。
講師都合・運営都合の経路を作るときは、この関数を書き換えるのではなく別の呼び出し口から
initiator を渡し、上の表に従わせること。戻す場合、期限切れなら30日延長して復活させる。

---

## 4. 管理画面

| ページ | パス | できること |
|---|---|---|
| クーポン管理 | `/admin/coupons` | 発行済み一覧（ユーザー・種別・金額・ステータス・発行日・有効期限・使用された予約・発行理由）、手動付与、手動無効化 |
| 友達紹介 管理 | `/admin/referrals` | 一覧（紹介者・被紹介者・ステータス・完了レッスン回数・特典付与状況）、紹介の無効化と解除 |
| ユーザー別履歴 | `/admin/users/:uid/campaigns` | そのユーザーのクーポン、紹介した相手、紹介された記録、運営操作の履歴 |

一覧・紹介一覧のユーザー名はユーザー別履歴へのリンクになっている。

### 運営操作（すべて理由の入力が必須）

| 操作 | callable | 備考 |
|---|---|---|
| クーポンの手動付与 | `adminIssueCoupon` | 値引き額・最低利用金額・有効日数を指定できる。キャンペーンの1回制限（`couponGrants`）は通さない |
| クーポンの無効化 | `adminCancelCoupon` | 使用済みのものも無効化できる（不正が後から判明した場合の記録用）。**決済の返金は別途 Stripe 側の対応が必要** |
| 紹介の無効化／解除 | `adminSetReferralBlocked` | 無効化すると以降のマイルストーン判定が止まる。解除するとその場で再判定して付与する |

操作は `campaignAuditLogs` に「誰が・いつ・何を・なぜ」を1件ずつ残す。
理由を必須にしているのは、不正利用の判断根拠を後から追えるようにするため。

**注意**: 紹介を無効化しても、すでに付与済みのクーポンは自動では取り消されない。
必要ならクーポン管理から個別に無効化する。また `reserved`（決済手続き中）の
クーポンを無効化しても、作成済みの Stripe Checkout の金額は変わらない。

---

## 5. Firestore のコレクションとルール

| コレクション | 内容 | read |
|---|---|---|
| `coupons/{id}` | クーポン本体 | 本人と admin |
| `couponGrants/{key}` | 付与済みの台帳（ID決め打ち） | admin のみ |
| `referrals/{被紹介者uid}` | 紹介の紐づけと進捗 | 紹介者・被紹介者・admin |
| `referralCodes/{code}` | コード → uid の逆引き | admin のみ（照合はサーバー） |
| `campaignAuditLogs/{id}` | 運営の手動操作の記録 | admin のみ |

書き込みはすべて `false`（Cloud Functions の Admin SDK 経由のみ）。

---

## 6. キャンペーン期間

`REVIEW_CAMPAIGN_PERIOD` / `REFERRAL_CAMPAIGN_PERIOD`（campaigns.ts）で設定する。
`{ startsOn: null, endsOn: null }` は「制限なし」。終了日を入れると、その翌日から新規の付与が止まる。

判定に使う日付が campaign ごとに違う。

- **レビュー**: 投稿日が期間内であること。期間外はレビューは投稿できるがクーポンは出ない
- **友達紹介**: **紹介コードの登録日**が期間内であること。
  期間中に案内した特典は、3回目の受講が期間終了後になっても付与する
  （途中まで進めた人の期待を裏切らないため）。新規の紹介コード登録は期間外だと拒否する

「期間終了と同時に、進行中の紹介も打ち切る」運用にしたい場合は、
`processReferralMilestones` の判定を登録日ではなく当日に変えること。

---

## 7. 動作確認

純粋ロジック（クーポンの利用可否、値引きの配分、レッスン完了の判定、紹介コードの正規化、
キャンペーン期間、各種定数）は自動チェックできる。

```bash
npm --prefix functions run verify:campaigns
```

Firestore / Stripe が絡む部分（トランザクションの排他、webhook の冪等性、
実際の決済金額）はこのスクリプトでは確認できない。エミュレータまたは
Stripe のテストモードでの通し確認が必要。

---

## 8. 残タスク

- [ ] 規約・キャンペーン規約への追記（クーポンの有効期限・併用不可・現金交換不可・不正時の無効化）
- [ ] `finalizeCompletedLessons` は日次のため、レッスン完了から特典付与まで最大1日かかる。
      即時性が必要なら実行間隔を短くする
- [ ] SNS 共有（今回はコピー機能のみ実装）
- [ ] キャンペーンの終了手順（`COUPON_SPECS` の停止と、付与関数の無効化）
- [ ] 無効化したクーポンが決済済みだった場合の返金運用（現状は Stripe 側で手動対応）
