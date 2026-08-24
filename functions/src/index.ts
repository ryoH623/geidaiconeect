import * as admin from "firebase-admin";
import { auth as v1auth, https, logger, pubsub } from "firebase-functions/v1";
import { defineString } from "firebase-functions/params";
import nodemailer from "nodemailer";
import type { Response } from "express";
import { google } from "googleapis";

import {
  COUPON_ON_CANCEL,
  judgeCoupon,
  markCouponUsed,
  releaseCoupon,
  reserveCouponInTx,
  restoreUsedCoupon,
  type CancelInitiator,
} from "./campaigns";

const Stripe = require("stripe");

if (!admin.apps.length) {
  admin.initializeApp();
}

// キャンペーン（レビュー投稿クーポン・友達紹介）の関数群。
// 実装は campaigns.ts にあり、ここでは公開（デプロイ対象化）するだけ。
export {
  submitReview,
  getMyReferralCode,
  checkReferralCode,
  applyReferralCode,
  finalizeCompletedLessons,
  expireCoupons,
  adminIssueCoupon,
  adminCancelCoupon,
  adminSetReferralBlocked,
} from "./campaigns";

// 検索ログ（0件検索の記録）。実装は searchLogs.ts にある。
export { logSearch, purgeOldSearchLogs } from "./searchLogs";

// 講師の招待（role: teacher の付与）。実装は teacherInvites.ts にある。
export {
  adminCreateTeacherInvite,
  checkTeacherInvite,
  acceptTeacherInvite,
} from "./teacherInvites";

// 講師本人によるプロフィール・コースの編集。実装は teacherProfileEdit.ts にある。
export { saveMyTeacherProfile } from "./teacherProfileEdit";

// ========================================
// Environment variables
// ========================================
const SMTP_HOST = defineString("SMTP_HOST");
const SMTP_PORT = defineString("SMTP_PORT");
const SMTP_USER = defineString("SMTP_USER");
const SMTP_PASS = defineString("SMTP_PASS");
const APP_URL = defineString("APP_URL");

// お問い合わせフォームの通知先（運営宛）
const CONTACT_TO = defineString("CONTACT_TO", {
  default: "info@geidaiconnect.com",
});

const STRIPE_SECRET_KEY = defineString("STRIPE_SECRET_KEY");
const STRIPE_SUCCESS_URL = defineString("STRIPE_SUCCESS_URL");
const STRIPE_CANCEL_URL = defineString("STRIPE_CANCEL_URL");
const STRIPE_WEBHOOK_SECRET = defineString("STRIPE_WEBHOOK_SECRET");

// スタジオの外部空き照会（Google カレンダー free/busy）の有効/無効。
// ローカル・エミュレータでは "false" にすると外部呼び出しをスキップし常に空き扱いにできる。
const STUDIO_FREEBUSY_ENABLED = defineString("STUDIO_FREEBUSY_ENABLED", {
  default: "true",
});

// 【一時】カレンダー連携セットアップ用の管理関数のシークレット（作業後に関数ごと削除する）
const STUDIO_ADMIN_SECRET = defineString("STUDIO_ADMIN_SECRET", { default: "" });


// ========================================
// SMTP / Email
// ========================================
function makeTransport() {
  const port = Number(SMTP_PORT.value());

  logger.info("makeTransport config", {
    host: SMTP_HOST.value(),
    port,
    secure: port === 465,
    user: SMTP_USER.value(),
    passExists: !!SMTP_PASS.value(),
    passLength: SMTP_PASS.value()?.length ?? 0,
  });

  return nodemailer.createTransport({
    host: SMTP_HOST.value(),
    port,
    secure: port === 465,
    auth: {
      user: SMTP_USER.value(),
      pass: SMTP_PASS.value(),
    },
  });
}

async function verifyTransport() {
  const transporter = makeTransport();

  logger.info("SMTP config check", {
    host: SMTP_HOST.value(),
    port: SMTP_PORT.value(),
    secure: Number(SMTP_PORT.value()) === 465,
    user: SMTP_USER.value(),
    userExists: !!SMTP_USER.value(),
    passExists: !!SMTP_PASS.value(),
    userLength: SMTP_USER.value()?.length ?? 0,
    passLength: SMTP_PASS.value()?.length ?? 0,
  });

  logger.info("before transporter.verify()");
  await transporter.verify();
  logger.info("SMTP verify success");

  return transporter;
}

function buildVerifyEmailHtml(displayName: string, link: string) {
  return `
    <div style="font-family: Arial, 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif; line-height: 1.8; color: #333;">
      <p>${displayName} 様</p>

      <p>Geidai Connect へのご登録ありがとうございます。</p>

      <p>
        メールアドレスの確認を完了するには、以下のボタンをクリックしてください。
      </p>

      <p style="margin: 24px 0;">
        <a
          href="${link}"
          style="
            display: inline-block;
            padding: 12px 20px;
            text-decoration: none;
            border-radius: 6px;
            background-color: #ffffff;
            color: #333333;
            border: 1px solid #cccccc;
          "
        >
          メールアドレスを確認する
        </a>
      </p>

      <p>ボタンが押せない場合は、以下のURLをブラウザに貼り付けてください。</p>
      <p style="word-break: break-all;">
        <a href="${link}">${link}</a>
      </p>

      <p>このメールに心当たりがない場合は、そのまま破棄してください。</p>

      <hr style="margin: 32px 0; border: none; border-top: 1px solid #e5e5e5;" />

      <p style="font-size: 12px; color: #666;">
        Geidai Connect<br />
        送信元: ${SMTP_USER.value()}<br />
        お問い合わせ: support@geidaiconnect.com
      </p>
    </div>
  `;
}

// ========================================
// 予約関連メールの共通基盤
// ========================================

/** HTML に埋め込むユーザー入力値のエスケープ */
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * users/{uid} → 無ければ Auth からメールアドレスと表示名を解決する。
 * 予約ドキュメントの teacherEmail はフロントが空文字を渡すため信用しない。
 */
async function getUserContact(
  uid: string
): Promise<{ email: string | null; displayName: string }> {
  let email: string | null = null;
  let displayName = "";

  try {
    const snap = await admin.firestore().collection("users").doc(uid).get();
    if (snap.exists) {
      const data = snap.data() || {};
      if (typeof data.email === "string" && data.email) {
        email = data.email;
      }
      if (typeof data.displayName === "string" && data.displayName) {
        displayName = data.displayName;
      }
    }
  } catch (error) {
    logger.warn("getUserContact: users ドキュメントの取得に失敗", { uid, error });
  }

  if (!email || !displayName) {
    try {
      const userRecord = await admin.auth().getUser(uid);
      if (!email) {
        email = userRecord.email ?? null;
      }
      if (!displayName) {
        displayName = userRecord.displayName ?? "";
      }
    } catch (error) {
      logger.warn("getUserContact: Auth ユーザーの取得に失敗", { uid, error });
    }
  }

  return { email, displayName };
}

/**
 * メール送信（失敗しても throw しない）。
 * Webhook・スケジュール実行など、送信失敗で本処理を止めたくない箇所から使う。
 */
async function sendMailSafe(mail: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}): Promise<boolean> {
  try {
    const transporter = makeTransport();
    await transporter.sendMail({
      from: `Geidai Connect <${SMTP_USER.value()}>`,
      to: mail.to,
      replyTo: mail.replyTo ?? "support@geidaiconnect.com",
      subject: mail.subject,
      html: mail.html,
    });
    logger.info("sendMailSafe success", { to: mail.to, subject: mail.subject });
    return true;
  } catch (error) {
    logger.error("sendMailSafe failed", {
      to: mail.to,
      subject: mail.subject,
      error,
    });
    return false;
  }
}

/** サーバーのタイムゾーンに依存せず JST の "YYYY-MM-DD" を返す */
function todayJst(offsetDays = 0): string {
  const jst = new Date(
    Date.now() + (9 * 60 + offsetDays * 24 * 60) * 60 * 1000
  );
  return jst.toISOString().slice(0, 10);
}

/**
 * 案内メールの共通レイアウト。
 * intro / outro は HTML として挿入するため、ユーザー入力を含める場合は
 * 呼び出し側で escapeHtml すること。rows の値は内部でエスケープする。
 */
function buildInfoMailHtml(params: {
  greetingName: string;
  intro: string[];
  rows: Array<[string, string]>;
  outro?: string[];
}): string {
  const introHtml = params.intro.map((p) => `<p>${p}</p>`).join("\n");
  const rowsHtml = params.rows
    .filter(([, value]) => value !== "")
    .map(
      ([key, value]) =>
        `<tr>` +
        `<td style="padding: 4px 16px 4px 0; color: #666; white-space: nowrap; vertical-align: top;">${escapeHtml(
          key
        )}</td>` +
        `<td style="padding: 4px 0;">${escapeHtml(value)}</td>` +
        `</tr>`
    )
    .join("\n");
  const outroHtml = (params.outro ?? []).map((p) => `<p>${p}</p>`).join("\n");

  return `
    <div style="font-family: Arial, 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif; line-height: 1.8; color: #333;">
      <p>${escapeHtml(params.greetingName)} 様</p>

      ${introHtml}

      <table style="margin: 16px 0; border-collapse: collapse;">
        ${rowsHtml}
      </table>

      ${outroHtml}

      <hr style="margin: 32px 0; border: none; border-top: 1px solid #e5e5e5;" />

      <p style="font-size: 12px; color: #666;">
        Geidai Connect<br />
        お問い合わせ: support@geidaiconnect.com
      </p>
    </div>
  `;
}

/** 予約内容の共通行（生徒向け・講師向けメールで共用） */
function reservationRows(r: any): Array<[string, string]> {
  const isOnline = r?.lessonType === "オンライン";
  const meetingUrl = typeof r?.meetingUrl === "string" ? r.meetingUrl : "";
  const yen = (v: number) => `${v.toLocaleString("ja-JP")}円`;

  // クーポンを使った予約は、レッスン料と実際の請求額が食い違う。
  // 金額の行だけ見て「請求が多い」と誤解されないよう、内訳を出す。
  const couponDiscount =
    typeof r?.couponDiscount === "number" ? r.couponDiscount : 0;
  const couponRows: Array<[string, string]> =
    couponDiscount > 0
      ? [
          [
            "クーポン",
            `${String(r?.couponName ?? "クーポン")} -${yen(couponDiscount)}`,
          ],
          [
            "お支払い金額",
            typeof r?.totalAmount === "number" ? yen(r.totalAmount) : "",
          ],
        ]
      : [];

  return [
    ["講師", String(r?.teacherName ?? "")],
    ["コース", String(r?.lessonCourse ?? "")],
    ["日時", `${r?.lessonDate ?? ""} ${r?.lessonTime ?? ""}`.trim()],
    [
      "場所",
      isOnline
        ? meetingUrl
          ? `オンライン（参加URL: ${meetingUrl}）`
          : "オンライン（参加URLは講師から登録され次第ご案内します）"
        : String(r?.location ?? ""),
    ],
    [
      couponDiscount > 0 ? "レッスン料" : "金額",
      typeof r?.lessonAmount === "number" ? yen(r.lessonAmount) : "",
    ],
    ...couponRows,
  ];
}

/** 予約ドキュメントから生徒の連絡先メールを取り出す */
function studentEmailOf(r: any): string {
  if (typeof r?.email === "string" && r.email) return r.email;
  if (typeof r?.userEmail === "string" && r.userEmail) return r.userEmail;
  return "";
}

/**
 * 決済完了時の通知メール（生徒: 予約確定 / 講師: 新規予約）。
 * Webhook から呼ぶため、失敗しても throw しない。
 */
async function sendPaymentCompletedEmails(reservationId: string): Promise<void> {
  try {
    const snap = await admin
      .firestore()
      .collection("reservations")
      .doc(reservationId)
      .get();

    if (!snap.exists) {
      logger.warn("sendPaymentCompletedEmails: 予約が見つかりません", {
        reservationId,
      });
      return;
    }

    const r = snap.data() || {};
    const studentEmail = studentEmailOf(r);

    if (studentEmail) {
      await sendMailSafe({
        to: studentEmail,
        subject: "【Geidai Connect】ご予約が確定しました",
        html: buildInfoMailHtml({
          greetingName: String(r.name || "ご利用者"),
          intro: [
            "お支払いが完了し、レッスンのご予約が確定しました。",
            "ご予約内容は以下のとおりです。",
          ],
          rows: reservationRows(r),
          outro: [
            "レッスン当日はどうぞよろしくお願いいたします。",
            "ご予約内容はマイページの「予約履歴」からもご確認いただけます。",
          ],
        }),
      });
    } else {
      logger.warn("sendPaymentCompletedEmails: 生徒メール不明のためスキップ", {
        reservationId,
      });
    }

    const teacherId = typeof r.teacherId === "string" ? r.teacherId : "";
    if (teacherId) {
      const teacher = await getUserContact(teacherId);
      if (teacher.email) {
        await sendMailSafe({
          to: teacher.email,
          subject: "【Geidai Connect】新しい予約が入りました",
          html: buildInfoMailHtml({
            greetingName: teacher.displayName || String(r.teacherName || "講師"),
            intro: ["新しいレッスン予約が確定しました（お支払い完了済み）。"],
            rows: [
              ...reservationRows(r),
              ["生徒氏名", String(r.name ?? "")],
              ["フリガナ", String(r.furigana ?? "")],
              ["生徒メール", studentEmail],
              ["生徒電話番号", String(r.phone ?? "")],
              ["ご要望", String(r.notes ?? "")],
            ],
            outro: ["詳細はマイページの予約一覧からご確認ください。"],
          }),
        });
      } else {
        logger.warn(
          "sendPaymentCompletedEmails: 講師メール未解決のためスキップ",
          { reservationId, teacherId }
        );
      }
    }
  } catch (error) {
    logger.error("sendPaymentCompletedEmails failed", { reservationId, error });
  }
}

// ========================================
// Stripe
// ========================================
function getStripeClient() {
  const secretKey = STRIPE_SECRET_KEY.value();

  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY が設定されていません。");
  }

  const StripeCtor: any = Stripe;
  return new StripeCtor(secretKey);
}

// ========================================
// Types
// ========================================
type CreateCheckoutSessionData = {
  reservationId: string;
  teacherId: string;
  teacherName: string;
  courseName: string;
  amount: number;
  lessonDate: string;
  lessonTime: string;
};

type CreateCheckoutSessionResult = {
  ok: boolean;
  sessionId: string;
  url: string | null;
};

type CreateReservationAndCheckoutData = {
  teacherId: string;
  teacherName: string;
  teacherEmail?: string;
  lessonCourse: string;
  lessonAmount: number;
  date: string;
  time: string;
  name: string;
  furigana: string;
  email: string;
  phone: string;
  location: string;
  notes?: string;
  // 支払い方法。現在はカードのみ（与信→締切キャプチャ）。
  // フィールド自体は既存データとの互換と将来の手段追加のために残している。
  paymentMethod?: "card";
  // レッスン種別（自宅/スタジオ/出張）。移動バッファ判定の場所種別に使う
  lessonType?: string;
  // レッスン所要時間(分)。未指定時は lessonCourse タイトルから推定
  durationMin?: number;
  // 出張レッスン時の生徒宅の座標（任意）。移動バッファ判定に使う
  studentLat?: number;
  studentLng?: number;
  // スタジオ予約時のみ。料金はサーバ側で studios から再取得するため studioFee は参考値
  studioId?: string;
  studioName?: string;
  studioFee?: number;
  // 利用するクーポン。値引き額はサーバー側で再計算するため、
  // フロントから割引後の金額を受け取ることはしない。
  couponId?: string;
};

type CreateReservationAndCheckoutResult = {
  ok: boolean;
  reservationId: string;
  sessionId: string;
  url: string | null;
};

// ========================================
// Utility
// ========================================
function allowCors(req: https.Request, res: Response<any>) {
  const origin = req.get("origin") || "";

  const allowedOrigins = [
    "https://geidaiconnect.com",
    "https://www.geidaiconnect.com",
    "http://localhost:5173",
    "http://localhost:5174",
  ];

  if (allowedOrigins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
  } else {
    res.set("Access-Control-Allow-Origin", "https://geidaiconnect.com");
  }

  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone: string) {
  return /^\d{10,11}$/.test(phone);
}

function buildScheduleDocId(teacherId: string, date: string, time: string): string {
  return `${teacherId}_${date}_${time.replace(":", "")}`;
}

// ========================================
// スタジオ（空き検索・予約ロック）ユーティリティ
// ========================================

// 予約済み・受付停止とみなすステータス（schedules / studioBookings 共通）
const UNAVAILABLE_STATUSES = new Set(["closed", "reserved", "booked", "pending"]);

/** studioBookings の決定的ドキュメント ID（schedules と同じ方式 → 複合インデックス不要） */
function buildStudioBookingDocId(
  studioId: string,
  date: string,
  time: string
): string {
  return `${studioId}_${date}_${time.replace(":", "")}`;
}

/**
 * pending 状態のドキュメントが期限切れかどうか（pendingExpiresAt を過ぎているか）。
 * pendingExpiresAt が無い pending は「期限切れでない」扱い（保守的）。
 */
function isPendingExpired(
  data: FirebaseFirestore.DocumentData,
  now: Date = new Date()
): boolean {
  if (String(data.status || "").toLowerCase() !== "pending") return false;
  const exp = data.pendingExpiresAt;
  return (
    exp instanceof admin.firestore.Timestamp && exp.toMillis() <= now.getTime()
  );
}

/** 緯度経度から 2 点間の直線距離(km)を求める（ハバーサイン公式） */
function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const R = 6371; // 地球半径(km)
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 講師拠点からスタジオまで到達可能か（距離ベースの判定）。
 * 拠点座標 or maxTravelKm が未設定なら判定不能として「到達可能扱い・距離 null」を返す。
 * ※ 所要時間ベースに切り替える場合はこの関数だけ Google Distance Matrix 等へ差し替える。
 */
function judgeReachable(
  base: { lat?: number; lng?: number; maxKm?: number },
  studio: { lat: number; lng: number }
): { reachable: boolean; distanceKm: number | null } {
  if (
    typeof base.lat !== "number" ||
    typeof base.lng !== "number" ||
    typeof base.maxKm !== "number" ||
    base.maxKm <= 0
  ) {
    return { reachable: true, distanceKm: null };
  }

  const distanceKm = haversineKm(base.lat, base.lng, studio.lat, studio.lng);
  return { reachable: distanceKm <= base.maxKm, distanceKm };
}

/**
 * スタジオの指定 30 分枠が外部（Google カレンダー free/busy）で空いているか。
 * - STUDIO_FREEBUSY_ENABLED !== "true"（ローカル/dev）: 外部照会をスキップし常に空き扱い。
 * - calendarId が空: 外部照会をスキップし常に空き扱い（未連携スタジオ）。
 * - 照会失敗: フォールバックで「空きでない」扱い（＝一覧から除外）。
 */
async function isStudioFreeExternal(
  calendarId: string,
  date: string,
  time: string,
  slotMinutes = 30
): Promise<boolean> {
  if (STUDIO_FREEBUSY_ENABLED.value() !== "true") {
    return true;
  }
  if (!calendarId) {
    return true;
  }

  try {
    const startDate = new Date(`${date}T${time}:00+09:00`);
    const endDate = new Date(startDate.getTime() + slotMinutes * 60 * 1000);

    const authClient = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });
    const calendar = google.calendar({ version: "v3", auth: authClient });

    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: startDate.toISOString(),
        timeMax: endDate.toISOString(),
        items: [{ id: calendarId }],
      },
    });

    const busy = res.data.calendars?.[calendarId]?.busy ?? [];
    return busy.length === 0;
  } catch (error) {
    logger.error("isStudioFreeExternal failed", { calendarId, date, time, error });
    return false;
  }
}

/** 講師の users ドキュメントから拠点・移動可能距離を読む */
async function loadTeacherTravelBase(
  teacherId: string
): Promise<{ lat?: number; lng?: number; maxKm?: number }> {
  const snap = await admin.firestore().collection("users").doc(teacherId).get();
  const u = snap.exists ? snap.data() || {} : {};
  return {
    lat: typeof u.baseLat === "number" ? u.baseLat : undefined,
    lng: typeof u.baseLng === "number" ? u.baseLng : undefined,
    maxKm: typeof u.maxTravelKm === "number" ? u.maxTravelKm : undefined,
  };
}

type GetAvailableStudiosData = {
  teacherId: string;
  date: string;
  time: string;
  /** 都道府県。生徒座標＋半径で検索する場合は不要（県境をまたいで探すため） */
  prefecture?: string;
  city?: string;
  /** 生徒の基準地点の座標（町名の代表座標または駅の座標）。指定時は近い順に並べ替える */
  studentLat?: number;
  studentLng?: number;
  /** 基準地点からの検索半径(km)。座標とセットで指定した場合のみ距離で絞り込む */
  radiusKm?: number;
  /** レッスン所要時間(分)。移動バッファ判定に使う。未指定時は既定値 */
  durationMin?: number;
};

/** 半径検索で指定できる最大距離(km)。想定外の巨大値でスキャンが膨らむのを防ぐ */
const MAX_SEARCH_RADIUS_KM = 50;

type AvailableStudioItem = {
  id: string;
  name: string;
  address?: string;
  pricePerSlot: number;
  distanceKm: number | null;
  /** 生徒が選択した町名からの直線距離(km)。座標未指定時は null */
  studentDistanceKm: number | null;
};

/** 生徒座標として妥当か（有限数かつ日本近辺の範囲内） */
function isValidStudentCoords(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= 20 &&
    lat <= 46 &&
    lng >= 122 &&
    lng <= 154
  );
}

type GetAvailableStudiosResult = {
  ok: boolean;
  studios: AvailableStudioItem[];
};

function addMinutesToDate(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

// ========================================
// 移動バッファ（連続予約間に確保する移動時間）ユーティリティ
// ※ 直線距離ベースの近似。将来 Google Distance Matrix 等の実所要時間へ差し替える場合は
//    travelBufferMin() の距離→時間の部分だけ置き換えればよい。
// ========================================

/** 移動バッファ算出パラメータ（運用に応じて調整可能） */
const TRAVEL_AVG_SPEED_KMH = 20; // 平均移動速度(km/h)。都市部の徒歩/公共交通/車混在を保守的に想定
const TRAVEL_DETOUR_FACTOR = 1.3; // 直線距離→実移動距離の迂回係数
const TRAVEL_PREP_MIN = 10; // 準備・片付けの固定バッファ(分)
const TRAVEL_SLOT_MIN = 30; // 枠粒度(分)。移動バッファはこの単位に切り上げる
const TRAVEL_UNKNOWN_BUFFER_MIN = 60; // 座標不明かつ別拠点の場合の保守的バッファ(分)
const DEFAULT_LESSON_DURATION_MIN = 60; // 所要時間が判定できないときの既定(分)

// 生徒が予約できる上限（本日から何日先まで）。フロント（BookingCalendar）と一致させること。
// カードの与信は最長30日ホールドのため、締切キャプチャが間に合う30日以内に制限する。
const MAX_BOOKING_DAYS_AHEAD = 30;

/**
 * カード与信の締切キャプチャ予定時刻。
 * キャンセル締切＝レッスン前日23:59 のため、その直後＝レッスン当日 00:00(JST) を請求予定とする。
 * lessonDate は "YYYY-MM-DD"。
 */
function chargeDueTimestamp(lessonDate: string): admin.firestore.Timestamp {
  return admin.firestore.Timestamp.fromDate(
    new Date(`${lessonDate}T00:00:00+09:00`)
  );
}

/** レッスンの場所（座標が分かれば座標、分からなくても key で同一拠点かを判定できる） */
type LessonLoc = { lat?: number; lng?: number; key: string };

/** コースタイトル（例:「出張レッスン（60分）」）から所要時間(分)を推定 */
function parseLessonDurationMin(courseTitle: unknown): number {
  const m = String(courseTitle ?? "").match(/(\d+)\s*分/);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_LESSON_DURATION_MIN;
}

/** "HH:MM" を 0時からの分に変換（不正なら NaN） */
function timeToMin(time: unknown): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 2 つのレッスン場所の間に必要な移動バッファ(分)。
 * - 同一拠点（同じ key）: 0（例:同じスタジオの連続予約は移動不要）
 * - 双方の座標あり: 距離×迂回係数÷速度＋準備時間を枠単位に切り上げ
 * - 座標不明で別拠点: 保守的な固定バッファ
 */
function travelBufferMin(a: LessonLoc, b: LessonLoc): number {
  if (a.key && b.key && a.key === b.key) return 0;

  const aok = typeof a.lat === "number" && typeof a.lng === "number";
  const bok = typeof b.lat === "number" && typeof b.lng === "number";
  if (aok && bok) {
    const km =
      haversineKm(a.lat as number, a.lng as number, b.lat as number, b.lng as number) *
      TRAVEL_DETOUR_FACTOR;
    const minutes = (km / TRAVEL_AVG_SPEED_KMH) * 60 + TRAVEL_PREP_MIN;
    return Math.ceil(minutes / TRAVEL_SLOT_MIN) * TRAVEL_SLOT_MIN;
  }
  return TRAVEL_UNKNOWN_BUFFER_MIN;
}

/** 予約の占有ステータス判定に使う「無効（占有しない）」ステータス */
const INACTIVE_RESERVATION_STATUSES = new Set([
  "expired",
  "cancelled",
  "canceled",
  "failed",
  "refunded",
]);

/** 既存予約1件を移動判定用の {開始,終了,場所} に変換（不正な時刻は null） */
type DayBooking = { start: number; end: number; loc: LessonLoc };
function reservationToDayBooking(r: FirebaseFirestore.DocumentData): DayBooking | null {
  const start = timeToMin(r.lessonTime);
  if (!Number.isFinite(start)) return null;
  const dur =
    typeof r.durationMin === "number" && r.durationMin > 0
      ? r.durationMin
      : parseLessonDurationMin(r.lessonCourse);

  const key =
    typeof r.locationKey === "string" && r.locationKey
      ? r.locationKey
      : r.studioId
        ? `studio:${r.studioId}`
        : // オンラインは会場がないが、講師は自宅等の拠点から実施する前提。
          // 拠点と同じ扱いにすると、オンライン同士・オンラインと自宅の間で
          // 移動時間が要求されず、スタジオとの間だけ正しくバッファが効く。
          r.lessonType === "自宅" || r.lessonType === "オンライン"
          ? `base:${r.teacherId}`
          : r.lessonType === "出張"
            ? `home:${r.userId}`
            : `loc:${String(r.location ?? "")}`;

  const lat = typeof r.lessonLat === "number" ? r.lessonLat : undefined;
  const lng = typeof r.lessonLng === "number" ? r.lessonLng : undefined;

  return { start, end: start + dur, loc: { lat, lng, key } };
}

/**
 * 候補レッスンが既存予約群と両立するか判定。
 * - 時間帯が重なる → overlap
 * - 直前/直後の予約との間に移動時間が足りない → travel（必要バッファ分を返す）
 * 問題なければ null。
 */
function findScheduleConflict(
  cand: DayBooking,
  existing: DayBooking[]
): { type: "overlap" } | { type: "travel"; neededMin: number } | null {
  for (const b of existing) {
    // 時間帯の重なり
    if (cand.start < b.end && b.start < cand.end) {
      return { type: "overlap" };
    }
    if (b.end <= cand.start) {
      // b が前 → b終了 + 移動 ≤ cand開始
      const buf = travelBufferMin(b.loc, cand.loc);
      if (cand.start - b.end < buf) return { type: "travel", neededMin: buf };
    } else {
      // b が後（b.start >= cand.end）→ cand終了 + 移動 ≤ b開始
      const buf = travelBufferMin(cand.loc, b.loc);
      if (b.start - cand.end < buf) return { type: "travel", neededMin: buf };
    }
  }
  return null;
}

/**
 * 指定講師・指定日の「占有中」予約一覧を取得（移動判定用）。
 * 複合インデックスを避けるため lessonDate の単一 where のみで引き、teacherId とステータスは
 * コード側で絞る。トランザクション内から呼ぶ場合は tx を渡す（読み取りは書き込みより前に）。
 */
async function loadTeacherDayBookings(
  teacherId: string,
  date: string,
  opts: {
    excludeReservationIds?: Set<string>;
    tx?: FirebaseFirestore.Transaction;
  } = {}
): Promise<DayBooking[]> {
  const query = admin
    .firestore()
    .collection("reservations")
    .where("lessonDate", "==", date);
  const snap = opts.tx ? await opts.tx.get(query) : await query.get();

  const out: DayBooking[] = [];
  for (const doc of snap.docs) {
    if (opts.excludeReservationIds?.has(doc.id)) continue;
    const r = doc.data() || {};
    if (r.teacherId !== teacherId) continue;
    const payment = String(r.paymentStatus ?? "").toLowerCase();
    const rstatus = String(r.reservationStatus ?? "").toLowerCase();
    // pending(決済保留)は占有扱い（他者の割り込み防止）。expired/cancelled 等は除外
    if (
      INACTIVE_RESERVATION_STATUSES.has(payment) ||
      INACTIVE_RESERVATION_STATUSES.has(rstatus)
    ) {
      continue;
    }
    const b = reservationToDayBooking(r);
    if (b) out.push(b);
  }
  return out;
}

// ========================================
// Auth trigger: send verify email on sign up
// ========================================
export const sendVerifyEmail = v1auth.user().onCreate(async (user) => {
  try {
    if (!user.email) {
      logger.warn("sendVerifyEmail skipped: user has no email", {
        uid: user.uid,
      });
      return;
    }

    logger.info("sendVerifyEmail start", {
      uid: user.uid,
      email: user.email,
      appUrl: APP_URL.value(),
    });

    logger.info("before generateEmailVerificationLink");
    const link = await admin.auth().generateEmailVerificationLink(user.email, {
      url: `${APP_URL.value()}/login`,
    });

    logger.info("generateEmailVerificationLink success", {
      uid: user.uid,
      email: user.email,
    });

    const transporter = await verifyTransport();
    const displayName = user.displayName?.trim() || "ご利用者";

    logger.info("before transporter.sendMail", {
      to: user.email,
      from: SMTP_USER.value(),
    });

    await transporter.sendMail({
      from: `Geidai Connect <${SMTP_USER.value()}>`,
      to: user.email,
      replyTo: "support@geidaiconnect.com",
      subject: "【Geidai Connect】メールアドレスの確認",
      html: buildVerifyEmailHtml(displayName, link),
    });

    logger.info("sendVerifyEmail success", {
      uid: user.uid,
      email: user.email,
    });
  } catch (error) {
    logger.error("sendVerifyEmail failed", error);
    throw error;
  }
});

// ========================================
// Callable: resend verification email
// ========================================
export const resendVerifyEmail = https.onCall(async (data, context) => {
  try {
    const emailFromData =
      typeof data?.email === "string" ? data.email.trim() : "";
    const emailFromToken =
      typeof context.auth?.token?.email === "string"
        ? context.auth.token.email.trim()
        : "";

    const email = emailFromData || emailFromToken;

    if (!email) {
      throw new https.HttpsError(
        "invalid-argument",
        "メールアドレスが指定されていません。"
      );
    }

    logger.info("resendVerifyEmail start", {
      callerUid: context.auth?.uid ?? null,
      email,
      appUrl: APP_URL.value(),
    });

    const userRecord = await admin.auth().getUserByEmail(email);

    if (userRecord.emailVerified) {
      logger.info("resendVerifyEmail skipped: already verified", {
        email,
        targetUid: userRecord.uid,
      });

      return {
        ok: true,
        alreadyVerified: true,
        message: "このメールアドレスは既に確認済みです。",
      };
    }

    logger.info("before generateEmailVerificationLink (resend)", {
      email,
    });

    const link = await admin.auth().generateEmailVerificationLink(email, {
      url: `${APP_URL.value()}/login`,
    });

    logger.info("generateEmailVerificationLink success (resend)", {
      email,
      targetUid: userRecord.uid,
    });

    const transporter = await verifyTransport();
    const displayName = userRecord.displayName?.trim() || "ご利用者";

    logger.info("before transporter.sendMail (resend)", {
      to: email,
      from: SMTP_USER.value(),
    });

    await transporter.sendMail({
      from: `Geidai Connect <${SMTP_USER.value()}>`,
      to: email,
      replyTo: "support@geidaiconnect.com",
      subject: "【Geidai Connect】メールアドレスの確認（再送）",
      html: buildVerifyEmailHtml(displayName, link),
    });

    logger.info("resendVerifyEmail success", {
      email,
      targetUid: userRecord.uid,
    });

    return {
      ok: true,
      alreadyVerified: false,
      message: "確認メールを再送しました。",
    };
  } catch (error: any) {
    logger.error("resendVerifyEmail failed", error);

    if (error?.code === "auth/user-not-found") {
      throw new https.HttpsError(
        "not-found",
        "指定されたメールアドレスのユーザーが見つかりません。"
      );
    }

    if (error instanceof https.HttpsError) {
      throw error;
    }

    throw new https.HttpsError(
      "internal",
      "確認メールの再送に失敗しました。"
    );
  }
});

// ========================================
// Callable: create Stripe Checkout Session
// （テスト用として残す）
// ========================================
export const createCheckoutSession = https.onCall(
  async (
    data: CreateCheckoutSessionData,
    context
  ): Promise<CreateCheckoutSessionResult> => {
    try {
      if (!context.auth) {
        throw new https.HttpsError("unauthenticated", "ログインが必要です。");
      }

      const {
        reservationId,
        teacherId,
        teacherName,
        courseName,
        amount,
        lessonDate,
        lessonTime,
      } = data || ({} as CreateCheckoutSessionData);

      if (
        !reservationId ||
        !teacherId ||
        !teacherName ||
        !courseName ||
        !lessonDate ||
        !lessonTime
      ) {
        throw new https.HttpsError(
          "invalid-argument",
          "必要な予約情報が不足しています。"
        );
      }

      if (!Number.isInteger(amount) || amount < 50) {
        throw new https.HttpsError("invalid-argument", "金額が不正です。");
      }

      const stripe = getStripeClient();

      logger.info("createCheckoutSession start", {
        uid: context.auth.uid,
        reservationId,
        teacherId,
        amount,
        lessonDate,
        lessonTime,
      });

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "jpy",
              unit_amount: amount,
              product_data: {
                name: "Geidai Connect レッスン予約",
                description: `${teacherName} / ${courseName} / ${lessonDate} ${lessonTime}`,
              },
            },
          },
        ],
        success_url: `${STRIPE_SUCCESS_URL.value()}?session_id={CHECKOUT_SESSION_ID}&reservationId=${encodeURIComponent(
          reservationId
        )}`,
        cancel_url: `${STRIPE_CANCEL_URL.value()}?reservationId=${encodeURIComponent(
          reservationId
        )}`,
        client_reference_id: reservationId,
        customer_email:
          typeof context.auth.token.email === "string"
            ? context.auth.token.email
            : undefined,
        metadata: {
          reservationId,
          teacherId,
          teacherName,
          courseName,
          lessonDate,
          lessonTime,
          userId: context.auth.uid,
        },
      });

      logger.info("createCheckoutSession success", {
        sessionId: session.id,
        reservationId,
        urlExists: !!session.url,
      });

      return {
        ok: true,
        sessionId: session.id,
        url: session.url ?? null,
      };
    } catch (error: any) {
      logger.error("createCheckoutSession failed", error);

      if (error instanceof https.HttpsError) {
        throw error;
      }

      throw new https.HttpsError(
        "internal",
        "決済画面の作成に失敗しました。"
      );
    }
  }
);

// ========================================
// Callable: create reservation + Stripe Checkout
// 本番用
// ========================================
// ========================================
// Callable: スタジオ空き検索
// 生徒が選んだ地域・日時に対し、講師が到達可能かつ空きのあるスタジオ一覧を返す
// ========================================
export const getAvailableStudios = https.onCall(
  async (
    data: GetAvailableStudiosData,
    context
  ): Promise<GetAvailableStudiosResult> => {
    if (!context.auth) {
      throw new https.HttpsError("unauthenticated", "ログインが必要です。");
    }

    const {
      teacherId,
      date,
      time,
      prefecture = "",
      city = "",
      studentLat,
      studentLng,
      radiusKm: radiusKmRaw,
      durationMin: durationMinRaw,
    } = data || ({} as GetAvailableStudiosData);

    // 生徒座標は任意。不正値でも検索自体は壊さない（地域指定での検索にフォールバック）
    const hasStudentCoords = isValidStudentCoords(studentLat, studentLng);
    if (
      !hasStudentCoords &&
      (studentLat !== undefined || studentLng !== undefined)
    ) {
      logger.warn("getAvailableStudios: 不正な生徒座標を無視します", {
        studentLat,
        studentLng,
      });
    }

    // 半径での絞り込みは「基準地点の座標」と「半径」が揃ったときだけ有効。
    // このときは県境をまたいだ最寄りも拾うため、都道府県での絞り込みを行わない。
    const radiusKm =
      hasStudentCoords &&
      typeof radiusKmRaw === "number" &&
      Number.isFinite(radiusKmRaw) &&
      radiusKmRaw > 0
        ? Math.min(radiusKmRaw, MAX_SEARCH_RADIUS_KM)
        : null;

    if (!teacherId || !date || !time || (!prefecture && !radiusKm)) {
      throw new https.HttpsError(
        "invalid-argument",
        "検索に必要な情報（講師・日時・地域）が不足しています。"
      );
    }

    logger.info("getAvailableStudios start", {
      uid: context.auth.uid,
      teacherId,
      date,
      time,
      prefecture,
      city,
      hasStudentCoords,
      radiusKm,
    });

    const base = await loadTeacherTravelBase(teacherId);

    // 移動バッファ判定: この日の講師の他予約と、候補レッスンの開始・終了時刻
    const durationMin =
      typeof durationMinRaw === "number" && durationMinRaw > 0
        ? durationMinRaw
        : DEFAULT_LESSON_DURATION_MIN;
    const candStart = timeToMin(time);
    const dayBookings = Number.isFinite(candStart)
      ? await loadTeacherDayBookings(teacherId, date)
      : [];

    // 半径検索のときは県境をまたいだ最寄りも候補にするため全件を読む
    // （studios はマスタで件数が少ない）。そうでなければ都道府県で一次絞り込みする。
    // 複合インデックスを避けるため単一 where のみ使い、active / city はコード側でフィルタする。
    const studiosRef = admin.firestore().collection("studios");
    const snap = await (radiusKm
      ? studiosRef.get()
      : studiosRef.where("prefecture", "==", prefecture).get());

    const results: AvailableStudioItem[] = [];
    const now = new Date();

    for (const doc of snap.docs) {
      const s = doc.data() || {};
      const studioId = typeof s.id === "string" && s.id ? s.id : doc.id;

      if (s.active === false) continue;
      if (typeof s.lat !== "number" || typeof s.lng !== "number") continue;

      // 生徒が指定した基準地点（町名の代表座標または駅）からの直線距離
      const studentDistanceRawKm = hasStudentCoords
        ? haversineKm(studentLat as number, studentLng as number, s.lat, s.lng)
        : null;

      // 0) 生徒からの距離で絞り込む。半径指定がない場合のみ市区町村の一致で絞る
      //    （市区町村の完全一致だけだと、区が違うだけの最寄りスタジオが落ちてしまうため）
      if (radiusKm !== null) {
        if (studentDistanceRawKm === null || studentDistanceRawKm > radiusKm) {
          continue;
        }
      } else if (city && s.city !== city) {
        continue;
      }

      // 1) 到達可否（拠点からの距離）
      const { reachable, distanceKm } = judgeReachable(base, {
        lat: s.lat,
        lng: s.lng,
      });
      if (!reachable) continue;

      // 2) 自アプリ内ロック（決定的ドキュメント ID を直読み）
      const bookingDocId = buildStudioBookingDocId(studioId, date, time);
      const bookingSnap = await admin
        .firestore()
        .collection("studioBookings")
        .doc(bookingDocId)
        .get();
      if (bookingSnap.exists) {
        const b = bookingSnap.data() || {};
        const st = String(b.status || "").toLowerCase();
        // 期限切れの pending（決済未完了のまま放置された仮押さえ）は空き扱い
        if (UNAVAILABLE_STATUSES.has(st) && !isPendingExpired(b, now)) {
          continue;
        }
      }

      // 3) 外部（Google カレンダー）空き
      const free = await isStudioFreeExternal(
        typeof s.calendarId === "string" ? s.calendarId : "",
        date,
        time
      );
      if (!free) continue;

      // 4) 同日の前後予約から、このスタジオへ移動が間に合うか（間に合わなければ除外）
      if (Number.isFinite(candStart) && dayBookings.length > 0) {
        const candBooking: DayBooking = {
          start: candStart,
          end: candStart + durationMin,
          loc: { lat: s.lat, lng: s.lng, key: `studio:${studioId}` },
        };
        if (findScheduleConflict(candBooking, dayBookings)) continue;
      }

      const studentDistanceKm =
        studentDistanceRawKm === null
          ? null
          : Math.round(studentDistanceRawKm * 10) / 10;

      results.push({
        id: studioId,
        name: typeof s.name === "string" ? s.name : studioId,
        address: typeof s.address === "string" ? s.address : undefined,
        pricePerSlot:
          typeof s.pricePerSlot === "number" ? s.pricePerSlot : 0,
        distanceKm:
          distanceKm === null ? null : Math.round(distanceKm * 10) / 10,
        studentDistanceKm,
      });
    }

    // 近い順に並べる（距離不明は末尾）。生徒座標があれば生徒基準、なければ講師拠点基準
    results.sort((a, b) => {
      const aKm = hasStudentCoords ? a.studentDistanceKm : a.distanceKm;
      const bKm = hasStudentCoords ? b.studentDistanceKm : b.distanceKm;
      if (aKm === null) return bKm === null ? 0 : 1;
      if (bKm === null) return -1;
      return aKm - bKm;
    });

    logger.info("getAvailableStudios result", {
      teacherId,
      count: results.length,
    });

    return { ok: true, studios: results };
  }
);

// ───────────────────────────────────────────────────────────
// 手数料の逓減制（変動手数料）
//
// 「同じ生徒 × 同じ講師」の累計成立レッスン数が増えるほど運営手数料を下げ、
// その分だけ講師の取り分を増やす。長期的な継続の動機付けと、
// プラットフォーム外での直接取引の抑止を狙う。
//
// 料率は予約作成時に reservationPayouts/{予約ID}.commissionRate へスナップショット保存する
// （reservations は生徒本人も読めるため、料率はそちらに置かない）。
// 後から料率表を変えても過去の精算額がぶれず、監査もできるようにするため。
// ※ フロント側の表示は src/lib/adminStats.ts の COMMISSION_TIERS と対になっている。
//    片方だけ変えないこと。
// ───────────────────────────────────────────────────────────
const COMMISSION_TIERS: { minCount: number; rate: number }[] = [
  { minCount: 0, rate: 0.18 },
  { minCount: 10, rate: 0.15 },
  { minCount: 50, rate: 0.1 },
];

/** 受講済み priorCount 回のペアに適用する手数料率。 */
function commissionRateFor(priorCount: number): number {
  let rate = COMMISSION_TIERS[0].rate;
  for (const t of COMMISSION_TIERS) {
    if (priorCount >= t.minCount) rate = t.rate;
  }
  return rate;
}

/**
 * この生徒×講師ペアで既に成立しているレッスン数を数える。
 * 返金・与信取消は paymentStatus が refunded / voided に変わるため自然に除外される。
 *
 * 等価条件2つ（userId, teacherId）のみで引き、paymentStatus はメモリ上で絞る。
 * 複合インデックスを不要にするため（ペアあたりの件数は小さい）。
 */
async function countPaidLessons(
  userId: string,
  teacherId: string
): Promise<number> {
  if (!userId || !teacherId) return 0;
  const snap = await admin
    .firestore()
    .collection("reservations")
    .where("userId", "==", userId)
    .where("teacherId", "==", teacherId)
    .get();
  return snap.docs.filter((d) => d.get("paymentStatus") === "paid").length;
}

export const createReservationAndCheckout = https.onCall(
  async (
    data: CreateReservationAndCheckoutData,
    context
  ): Promise<CreateReservationAndCheckoutResult> => {
    let reservationRef: FirebaseFirestore.DocumentReference | null = null;
    // 失敗時に仮押さえを解放するため、catch からも見える位置に持つ
    let reservedCouponId = "";

    try {
      if (!context.auth) {
        throw new https.HttpsError("unauthenticated", "ログインが必要です。");
      }

      const {
        teacherId,
        teacherName,
        teacherEmail = "",
        lessonCourse,
        lessonAmount,
        date,
        time,
        name,
        furigana,
        email,
        phone,
        location,
        notes = "",
        paymentMethod: paymentMethodRaw,
        lessonType = "",
        durationMin: durationMinRaw,
        studentLat,
        studentLng,
        studioId = "",
        couponId: couponIdRaw = "",
      } = data || ({} as CreateReservationAndCheckoutData);

      const couponId = typeof couponIdRaw === "string" ? couponIdRaw.trim() : "";

      // 支払い方法はカードのみ。旧クライアントが paypay を送ってきても card として扱う。
      const paymentMethod: "card" = "card";
      if (paymentMethodRaw && paymentMethodRaw !== "card") {
        logger.warn("非対応の支払い方法が指定されたためカードで処理します", {
          requested: paymentMethodRaw,
        });
      }

      if (
        !teacherId ||
        !teacherName ||
        !lessonCourse ||
        !date ||
        !time ||
        !name ||
        !furigana ||
        !email ||
        !phone ||
        !location
      ) {
        throw new https.HttpsError(
          "invalid-argument",
          "必要な予約情報が不足しています。"
        );
      }

      if (!Number.isInteger(lessonAmount) || lessonAmount < 50) {
        throw new https.HttpsError("invalid-argument", "金額が不正です。");
      }

      if (!isValidEmail(email)) {
        throw new https.HttpsError(
          "invalid-argument",
          "メールアドレスが不正です。"
        );
      }

      if (!isValidPhone(phone)) {
        throw new https.HttpsError(
          "invalid-argument",
          "電話番号が不正です。"
        );
      }

      // 予約可能期間チェック（本日〜約1ヶ月先）。過去日・上限超過を拒否する。
      const minDateStr = todayJst(0);
      const maxDateStr = todayJst(MAX_BOOKING_DAYS_AHEAD);
      if (date < minDateStr || date > maxDateStr) {
        throw new https.HttpsError(
          "failed-precondition",
          "ご予約は本日から約1ヶ月以内の日程でお願いします。"
        );
      }

      // スタジオ予約の場合: 料金・空きをサーバ側で再検証する（クライアント値は信用しない）
      let studioFee = 0;
      let resolvedStudioName = "";
      let studioBookingDocId = "";
      let studioLat: number | undefined;
      let studioLng: number | undefined;
      if (studioId) {
        const studioSnap = await admin
          .firestore()
          .collection("studios")
          .doc(studioId)
          .get();

        if (!studioSnap.exists) {
          throw new https.HttpsError(
            "not-found",
            "選択したスタジオが見つかりませんでした。"
          );
        }

        const studio = studioSnap.data() || {};
        studioFee =
          typeof studio.pricePerSlot === "number" ? studio.pricePerSlot : 0;
        resolvedStudioName =
          typeof studio.name === "string" ? studio.name : studioId;
        studioBookingDocId = buildStudioBookingDocId(studioId, date, time);
        studioLat = typeof studio.lat === "number" ? studio.lat : undefined;
        studioLng = typeof studio.lng === "number" ? studio.lng : undefined;

        // 到達可否の再検証（拠点未設定なら reachable 扱い）
        const base = await loadTeacherTravelBase(teacherId);
        const { reachable } = judgeReachable(base, {
          lat: typeof studio.lat === "number" ? studio.lat : 0,
          lng: typeof studio.lng === "number" ? studio.lng : 0,
        });
        if (!reachable) {
          throw new https.HttpsError(
            "failed-precondition",
            "このスタジオは講師の対応可能エリア外です。"
          );
        }

        // 外部空きの再検証
        const free = await isStudioFreeExternal(
          typeof studio.calendarId === "string" ? studio.calendarId : "",
          date,
          time
        );
        if (!free) {
          throw new https.HttpsError(
            "already-exists",
            "選択したスタジオはこの時間帯に空きがありません。"
          );
        }
      }

      // 金額の組み立て順:
      //   1. レッスン料 → 2. スタジオ代などの実費 → 3. クーポン値引き → 4. 決済金額
      // クーポンの値引き額はここでは決めず、トランザクション内でクーポン本体を
      // 読んでから確定する（フロントから送られた金額は一切使わない）。
      const subtotalAmount = lessonAmount + studioFee;

      const userId = context.auth.uid;
      const authEmail =
        typeof context.auth.token.email === "string"
          ? context.auth.token.email
          : null;

      // --- 移動バッファ判定用: 所要時間とレッスン場所（座標つき）を確定する ---
      const durationMin =
        typeof durationMinRaw === "number" && durationMinRaw > 0
          ? durationMinRaw
          : parseLessonDurationMin(lessonCourse);

      let candidateLoc: LessonLoc;
      if (studioId) {
        candidateLoc = { lat: studioLat, lng: studioLng, key: `studio:${studioId}` };
      } else if (lessonType === "自宅" || lessonType === "オンライン") {
        // 自宅レッスンは講師の拠点で実施 → 拠点座標
        // オンラインも講師は拠点から実施する前提で同じ扱いにする（移動時間が不要になる）
        const base = await loadTeacherTravelBase(teacherId);
        candidateLoc = { lat: base.lat, lng: base.lng, key: `base:${teacherId}` };
      } else if (lessonType === "出張") {
        // 出張は生徒宅。座標が渡っていれば使い、無ければ座標なし（別生徒宅は保守的バッファ）
        const hasCoords = isValidStudentCoords(studentLat, studentLng);
        candidateLoc = {
          lat: hasCoords ? (studentLat as number) : undefined,
          lng: hasCoords ? (studentLng as number) : undefined,
          key: `home:${userId}`,
        };
      } else {
        candidateLoc = { key: `loc:${String(location)}` };
      }

      const candStart = timeToMin(time);
      const candBooking: DayBooking = {
        start: candStart,
        end: candStart + durationMin,
        loc: candidateLoc,
      };

      reservationRef = admin.firestore().collection("reservations").doc();
      const reservationId = reservationRef.id;

      const scheduleDocId = buildScheduleDocId(teacherId, date, time);
      const scheduleRef = admin.firestore().collection("schedules").doc(scheduleDocId);
      const studioBookingRef = studioBookingDocId
        ? admin.firestore().collection("studioBookings").doc(studioBookingDocId)
        : null;

      // 手数料率は「この予約より前の成立回数」で決まる（非遡及）。
      // トランザクション外で数えるのは、同時予約が閾値をまたぐ稀なケースより
      // トランザクションの読み取り制約を避ける方を優先したため。
      // ずれても1件ぶんで、生徒に不利にはならない。
      const priorLessonCount = await countPaidLessons(userId, teacherId);
      const commissionRate = commissionRateFor(priorLessonCount);
      // 手数料は「クーポン値引き前のレッスン料」に対して計算する。
      // クーポンは運営が負担する販促費であり、講師の取り分を減らさない。
      const commissionAmount = Math.floor(lessonAmount * commissionRate);
      const teacherPayout = lessonAmount - commissionAmount;

      // クーポン。値引き額と利用可否はトランザクション内で確定する。
      const couponRef = couponId
        ? admin.firestore().collection("coupons").doc(couponId)
        : null;
      let couponDiscount = 0;
      let couponName = "";
      // 手数料の明細は予約と同じ ID で別コレクションに持つ（生徒からは読めない）
      const payoutRef = admin
        .firestore()
        .collection("reservationPayouts")
        .doc(reservationId);

      logger.info("createReservationAndCheckout start", {
        uid: userId,
        reservationId,
        teacherId,
        lessonAmount,
        date,
        time,
        scheduleDocId,
        priorLessonCount,
        commissionRate,
      });

      await admin.firestore().runTransaction(async (tx) => {
        // Firestore トランザクションは「全読み取り → 全書き込み」の順序必須
        const scheduleSnap = await tx.get(scheduleRef);
        const studioBookingSnap = studioBookingRef
          ? await tx.get(studioBookingRef)
          : null;

        // クーポンの検証。トランザクション内で読むことで、同じクーポンが
        // 複数の予約で同時に使われるのを防ぐ（後段で reserved に落とす）。
        // 再試行に備えて毎回初期化する。
        couponDiscount = 0;
        couponName = "";
        if (couponRef) {
          const couponSnap = await tx.get(couponRef);
          const judged = judgeCoupon(
            couponSnap.exists ? couponSnap.data() : undefined,
            { userId, subtotal: subtotalAmount }
          );
          if (!judged.usable) {
            throw new https.HttpsError("failed-precondition", judged.reason);
          }
          couponDiscount = judged.discount;
          couponName =
            typeof judged.data.name === "string" ? judged.data.name : "クーポン";
        }

        if (!scheduleSnap.exists) {
          throw new https.HttpsError(
            "not-found",
            "選択した時間枠が見つかりませんでした。"
          );
        }

        const txNow = new Date();
        // 期限切れ pending を奪取した場合、置き換えられた旧予約の ID を集めて
        // 後段（書き込みフェーズ）で expired に更新する
        const supersededReservationIds = new Set<string>();

        const schedule = scheduleSnap.data() || {};
        const currentStatus = String(schedule.status || "open").toLowerCase();
        const currentIsAvailable =
          typeof schedule.isAvailable === "boolean"
            ? schedule.isAvailable
            : true;

        const scheduleBlocked =
          !currentIsAvailable || UNAVAILABLE_STATUSES.has(currentStatus);
        // 期限切れの pending（決済未完了のまま放置）は上書き可能とする
        if (scheduleBlocked && !isPendingExpired(schedule, txNow)) {
          throw new https.HttpsError(
            "already-exists",
            "この時間枠はすでに予約済み、または受付停止です。"
          );
        }
        if (scheduleBlocked && typeof schedule.pendingReservationId === "string" && schedule.pendingReservationId) {
          supersededReservationIds.add(schedule.pendingReservationId);
        }

        // 講師がこの枠で許可したレッスン方法（自宅/スタジオ/出張）以外での予約を拒否する。
        // フロント（BookingCalendar）でも絞り込んでいるが、直接呼び出しに備えてサーバー側でも検証する。
        // lessonMethods が空・未設定の古い枠は後方互換のため通す。
        const allowedMethods = Array.isArray(schedule.lessonMethods)
          ? schedule.lessonMethods.filter(
              (v: unknown): v is string => typeof v === "string"
            )
          : [];
        const KNOWN_LESSON_METHODS = ["自宅", "スタジオ", "出張", "オンライン"];
        if (
          lessonType &&
          KNOWN_LESSON_METHODS.includes(lessonType) &&
          allowedMethods.length > 0 &&
          !allowedMethods.includes(lessonType)
        ) {
          throw new https.HttpsError(
            "failed-precondition",
            "選択した時間枠では、このレッスン方法（" +
              lessonType +
              "）は受け付けていません。別の枠をお選びください。"
          );
        }

        // スタジオロックの確認（他予約が押さえていないか）
        if (studioBookingSnap && studioBookingSnap.exists) {
          const b = studioBookingSnap.data() || {};
          const bStatus = String(b.status || "").toLowerCase();
          if (UNAVAILABLE_STATUSES.has(bStatus)) {
            if (!isPendingExpired(b, txNow)) {
              throw new https.HttpsError(
                "already-exists",
                "選択したスタジオはこの時間帯にすでに予約されています。"
              );
            }
            if (typeof b.pendingReservationId === "string" && b.pendingReservationId) {
              supersededReservationIds.add(b.pendingReservationId);
            }
          }
        }

        // 同日の他予約との「時間帯の重なり」と「移動時間の不足」を検証する。
        // 奪取対象（期限切れ pending）は自分自身との衝突になるため除外。
        if (Number.isFinite(candStart)) {
          const excludeIds = new Set(supersededReservationIds);
          excludeIds.add(reservationId);
          const dayBookings = await loadTeacherDayBookings(teacherId, date, {
            tx,
            excludeReservationIds: excludeIds,
          });
          const conflict = findScheduleConflict(candBooking, dayBookings);
          if (conflict) {
            logger.info("createReservationAndCheckout schedule conflict", {
              teacherId,
              date,
              time,
              conflict,
            });
            if (conflict.type === "overlap") {
              throw new https.HttpsError(
                "already-exists",
                "この時間帯は講師の他の予約と重複しています。別の時間をお選びください。"
              );
            }
            throw new https.HttpsError(
              "failed-precondition",
              "前後の予約との間に移動時間が確保できません。別の時間帯・場所をお選びください。"
            );
          }
        }

        // 置き換え対象の旧予約を読み取り（トランザクションの読み取りは書き込みより先）
        const supersededRefs: FirebaseFirestore.DocumentReference[] = [];
        for (const oldId of supersededReservationIds) {
          if (oldId === reservationId) continue;
          const oldRef = admin.firestore().collection("reservations").doc(oldId);
          const oldSnap = await tx.get(oldRef);
          if (
            oldSnap.exists &&
            (oldSnap.data() || {}).paymentStatus === "pending_payment"
          ) {
            supersededRefs.push(oldRef);
          }
        }

        const pendingExpiresAt = admin.firestore.Timestamp.fromDate(
          addMinutesToDate(new Date(), 30)
        );

        // 期限切れ hold を奪取した場合、旧予約を expired に（webhook 処理と冪等）
        for (const oldRef of supersededRefs) {
          tx.set(
            oldRef,
            {
              paymentStatus: "expired",
              reservationStatus: "expired",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        tx.update(scheduleRef, {
          status: "pending",
          isAvailable: false,
          pendingReservationId: reservationId,
          pendingUserId: userId,
          pendingExpiresAt,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // スタジオ枠をロック（30分の pending）
        if (studioBookingRef) {
          tx.set(
            studioBookingRef,
            {
              studioId,
              date,
              time,
              status: "pending",
              isAvailable: false,
              pendingReservationId: reservationId,
              pendingUserId: userId,
              pendingExpiresAt,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        tx.set(reservationRef!, {
          reservationId,
          userId,
          userEmail: authEmail ?? email,
          teacherId,
          teacherName,
          teacherEmail,
          lessonCourse,
          lessonAmount,
          lessonDate: date,
          lessonTime: time,
          scheduleDocId,
          name,
          furigana,
          email,
          phone,
          location,
          notes,
          // 移動バッファ判定に使う場所・時間情報
          lessonType: lessonType || null,
          durationMin,
          lessonLat: typeof candidateLoc.lat === "number" ? candidateLoc.lat : null,
          lessonLng: typeof candidateLoc.lng === "number" ? candidateLoc.lng : null,
          locationKey: candidateLoc.key,
          // スタジオ予約情報（非スタジオ時は null）
          studioId: studioId || null,
          studioName: studioId ? resolvedStudioName : null,
          studioFee: studioId ? studioFee : null,
          studioBookingDocId: studioBookingDocId || null,
          // 金額の内訳。totalAmount は実際に決済する金額（値引き後）。
          subtotalAmount,
          couponId: couponId || null,
          couponName: couponId ? couponName : null,
          couponDiscount,
          totalAmount: subtotalAmount - couponDiscount,
          // 紹介特典の回数カウント用。finalizeCompletedLessons が true にする。
          lessonCompleted: false,
          // 支払い方法と、カード与信の締切キャプチャ予定時刻
          paymentMethod,
          chargeDueAt: chargeDueTimestamp(date),
          paymentStatus: "pending_payment",
          reservationStatus: "pending",
          paymentProvider: "stripe",
          stripeSessionId: null,
          stripePaymentIntentId: null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          paidAt: null,
        });

        // 手数料・講師取り分は予約本体とは別コレクションに置く。
        // reservations は生徒本人も読めるため、同じドキュメントに入れると
        // 画面に出していなくても生徒側から料率が見えてしまう。
        // このコレクションは講師本人と admin のみ read 可（firestore.rules 参照）。
        tx.set(payoutRef, {
          reservationId,
          teacherId,
          lessonAmount,
          commissionRate,
          commissionAmount,
          teacherPayout,
          priorLessonCount,
          // クーポン値引きは運営負担。講師取り分には影響しないが、
          // 運営の手取り（手数料 − 値引き）を出すために記録しておく。
          couponDiscount,
          lessonDate: date,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // クーポンを仮押さえ（reserved）。決済完了で used、期限切れ・失敗で available に戻す。
        if (couponRef) {
          reserveCouponInTx(tx, couponRef, reservationId);
        }
      });

      // ここから先で失敗したら解放が必要になる
      reservedCouponId = couponId;

      const stripe = getStripeClient();

      const cancelUrl =
        `${STRIPE_CANCEL_URL.value()}?teacher=${encodeURIComponent(
          teacherName
        )}` +
        `&course=${encodeURIComponent(lessonCourse)}` +
        `&reservationId=${encodeURIComponent(reservationId)}` +
        `&canceled=1`;

      const successUrl =
        `${STRIPE_SUCCESS_URL.value()}?session_id={CHECKOUT_SESSION_ID}` +
        `&reservationId=${encodeURIComponent(reservationId)}`;

      const lineItems: any[] = [
        {
          quantity: 1,
          price_data: {
            currency: "jpy",
            unit_amount: lessonAmount,
            product_data: {
              name: "Geidai Connect レッスン予約",
              description: `${teacherName} / ${lessonCourse} / ${date} ${time}`,
            },
          },
        },
      ];

      // スタジオ代を 2 明細目として合算
      if (studioId && studioFee > 0) {
        lineItems.push({
          quantity: 1,
          price_data: {
            currency: "jpy",
            unit_amount: studioFee,
            product_data: {
              name: "スタジオ利用料",
              description: `${resolvedStudioName} / ${date} ${time}`,
            },
          },
        });
      }

      // クーポン値引き。Stripe の明細にマイナス行は作れないため、
      // 先頭（レッスン料）から順に単価を引いていく。
      // 値引き後の合計 = subtotalAmount - couponDiscount になる。
      if (couponDiscount > 0) {
        let remaining = couponDiscount;
        for (const item of lineItems) {
          if (remaining <= 0) break;
          const unit = item.price_data.unit_amount as number;
          const applied = Math.min(unit, remaining);
          item.price_data.unit_amount = unit - applied;
          item.price_data.product_data.description +=
            `（${couponName} -${applied.toLocaleString("ja-JP")}円）`;
          remaining -= applied;
        }
        if (remaining > 0) {
          // judgeCoupon で小計 ≧ 最低利用金額を確認しているため通常は起きない
          logger.error("クーポンの値引きを明細に配分しきれませんでした", {
            reservationId,
            couponId,
            couponDiscount,
            subtotalAmount,
          });
          throw new https.HttpsError(
            "failed-precondition",
            "クーポンを適用できませんでした。"
          );
        }
        // 0円になった明細は Stripe に送らない
        for (let i = lineItems.length - 1; i >= 0; i -= 1) {
          if (lineItems[i].price_data.unit_amount <= 0) lineItems.splice(i, 1);
        }
      }

      // カードのみ。与信（capture_method=manual）→ キャンセル締切日にキャプチャする。
      const sessionParams: any = {
        mode: "payment",
        payment_method_types: ["card"],
        line_items: lineItems,
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: reservationId,
        customer_email: email || authEmail || undefined,
        metadata: {
          reservationId,
          scheduleDocId,
          studioBookingDocId,
          teacherId,
          teacherName,
          lessonCourse,
          lessonDate: date,
          lessonTime: time,
          userId,
          studentName: name,
          studentEmail: email,
          paymentMethod,
          // webhook 側でクーポンを used / available に遷移させるために持たせる
          couponId,
        },
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      };

      if (paymentMethod === "card") {
        // 与信のみ確保し、締切日に captureDueAuthorizations がキャプチャする
        sessionParams.payment_intent_data = { capture_method: "manual" };
      }

      const session = await stripe.checkout.sessions.create(sessionParams);

      await reservationRef.set(
        {
          stripeSessionId: session.id,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      logger.info("createReservationAndCheckout success", {
        reservationId,
        sessionId: session.id,
        successUrl,
        cancelUrl,
        urlExists: !!session.url,
      });

      return {
        ok: true,
        reservationId,
        sessionId: session.id,
        url: session.url ?? null,
      };
    } catch (error: any) {
      logger.error("createReservationAndCheckout failed", error);

      if (reservationRef) {
        try {
          // 仮押さえしたクーポンを利用可能に戻す（予約が成立しなかったため）
          if (reservedCouponId) {
            await releaseCoupon(reservedCouponId, reservationRef.id);
          }

          const reservationSnap = await reservationRef.get();
          const reservationData = reservationSnap.exists ? reservationSnap.data() : null;
          const scheduleDocId = reservationData?.scheduleDocId;
          const studioBookingDocId = reservationData?.studioBookingDocId;

          if (scheduleDocId || studioBookingDocId) {
            const scheduleRef = scheduleDocId
              ? admin.firestore().collection("schedules").doc(scheduleDocId)
              : null;
            const studioBookingRef = studioBookingDocId
              ? admin.firestore().collection("studioBookings").doc(studioBookingDocId)
              : null;

            await admin.firestore().runTransaction(async (tx) => {
              // 全読み取りを先に行う
              const scheduleSnap = scheduleRef ? await tx.get(scheduleRef) : null;
              const studioBookingSnap = studioBookingRef
                ? await tx.get(studioBookingRef)
                : null;

              if (scheduleRef && scheduleSnap && scheduleSnap.exists) {
                const schedule = scheduleSnap.data() || {};
                if (schedule.pendingReservationId === reservationRef!.id) {
                  tx.update(scheduleRef, {
                    status: "open",
                    isAvailable: true,
                    pendingReservationId: admin.firestore.FieldValue.delete(),
                    pendingUserId: admin.firestore.FieldValue.delete(),
                    pendingExpiresAt: admin.firestore.FieldValue.delete(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });
                }
              }

              if (studioBookingRef && studioBookingSnap && studioBookingSnap.exists) {
                const b = studioBookingSnap.data() || {};
                if (b.pendingReservationId === reservationRef!.id) {
                  tx.update(studioBookingRef, {
                    status: "open",
                    isAvailable: true,
                    pendingReservationId: admin.firestore.FieldValue.delete(),
                    pendingUserId: admin.firestore.FieldValue.delete(),
                    pendingExpiresAt: admin.firestore.FieldValue.delete(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });
                }
              }

              tx.delete(reservationRef!);
              // 手数料明細は予約と同じ ID なので、予約を消すときは必ず一緒に消す
              tx.delete(
                admin
                  .firestore()
                  .collection("reservationPayouts")
                  .doc(reservationRef!.id)
              );
            });
          } else {
            await reservationRef.delete();
            await admin
              .firestore()
              .collection("reservationPayouts")
              .doc(reservationRef.id)
              .delete();
          }

          logger.info("createReservationAndCheckout rollback success", {
            reservationId: reservationRef.id,
          });
        } catch (rollbackError) {
          logger.error(
            "createReservationAndCheckout rollback failed",
            rollbackError
          );
        }
      }

      if (error instanceof https.HttpsError) {
        throw error;
      }

      throw new https.HttpsError(
        "internal",
        "予約と決済画面の作成に失敗しました。"
      );
    }
  }
);

// ========================================
// HTTP: get reservation for success page
// reservationId または session_id で取得可能
// ========================================
export const getReservationForSuccess = https.onRequest(async (req, res) => {
  try {
    allowCors(req, res);

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ ok: false, message: "Method Not Allowed" });
      return;
    }

    const authHeader = req.get("Authorization") || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.replace("Bearer ", "").trim()
      : "";

    if (!idToken) {
      res.status(401).json({ ok: false, message: "ログインが必要です。" });
      return;
    }

    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    const reservationId =
      typeof req.body?.reservationId === "string"
        ? req.body.reservationId.trim()
        : "";

    const sessionId =
      typeof req.body?.sessionId === "string"
        ? req.body.sessionId.trim()
        : typeof req.body?.session_id === "string"
        ? req.body.session_id.trim()
        : "";

    let snap: FirebaseFirestore.DocumentSnapshot | null = null;

    if (reservationId) {
      snap = await admin
        .firestore()
        .collection("reservations")
        .doc(reservationId)
        .get();
    } else if (sessionId) {
      const qs = await admin
        .firestore()
        .collection("reservations")
        .where("stripeSessionId", "==", sessionId)
        .limit(1)
        .get();

      if (!qs.empty) {
        snap = qs.docs[0];
      }
    } else {
      res.status(400).json({
        ok: false,
        message: "reservationId または sessionId が必要です。",
      });
      return;
    }

    if (!snap || !snap.exists) {
      res.status(404).json({
        ok: false,
        message: "予約情報が見つかりませんでした。",
      });
      return;
    }

    const reservation = snap.data() as any;

    if (reservation.userId !== uid) {
      res.status(403).json({
        ok: false,
        message: "この予約情報を表示する権限がありません。",
      });
      return;
    }

    res.status(200).json({
      ok: true,
      reservationId: snap.id,
      reservation: {
        teacherId: reservation.teacherId ?? "",
        teacherName: reservation.teacherName ?? "",
        teacherEmail: reservation.teacherEmail ?? "",
        lessonCourse: reservation.lessonCourse ?? "",
        lessonAmount: reservation.lessonAmount ?? 0,
        // クーポン利用時はレッスン料と請求額が異なるため、内訳も返す
        couponName: reservation.couponName ?? "",
        couponDiscount: reservation.couponDiscount ?? 0,
        totalAmount: reservation.totalAmount ?? 0,
        lessonDate: reservation.lessonDate ?? "",
        lessonTime: reservation.lessonTime ?? "",
        name: reservation.name ?? "",
        furigana: reservation.furigana ?? "",
        email: reservation.email ?? "",
        phone: reservation.phone ?? "",
        location: reservation.location ?? "",
        notes: reservation.notes ?? "",
        paymentStatus: reservation.paymentStatus ?? "",
        reservationStatus: reservation.reservationStatus ?? "",
        paymentProvider: reservation.paymentProvider ?? "",
        userEmail: reservation.userEmail ?? "",
        scheduleDocId: reservation.scheduleDocId ?? "",
      },
    });
  } catch (error: any) {
    logger.error("getReservationForSuccess failed", error);
    res.status(500).json({
      ok: false,
      message: error?.message ?? "予約情報の取得に失敗しました。",
    });
  }
});

// ========================================
// HTTP: Stripe Webhook
// ========================================
export const stripeWebhook = https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const signature = req.get("Stripe-Signature");
  const webhookSecret = STRIPE_WEBHOOK_SECRET.value();

  if (!signature) {
    logger.error("stripeWebhook: missing Stripe-Signature header");
    res.status(400).send("Missing signature");
    return;
  }

  if (!webhookSecret) {
    logger.error("stripeWebhook: STRIPE_WEBHOOK_SECRET is not set");
    res.status(500).send("Webhook secret is not configured");
    return;
  }

  // 署名検証の失敗は 400（Stripe はリトライしない）
  let event: any;
  try {
    const stripe = getStripeClient();
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      signature,
      webhookSecret
    );
  } catch (error: any) {
    logger.error("stripeWebhook: signature verification failed", error);
    res.status(400).send(`Webhook Error: ${error?.message ?? "unknown"}`);
    return;
  }

  // ここから先の失敗は 500 を返して Stripe にリトライさせる。
  // メール送信は sendMailSafe 内で握りつぶすため 500 の原因にはならない。
  try {
    logger.info("stripeWebhook received", {
      type: event.type,
      id: event.id,
    });

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as any;

      const reservationId =
        typeof session.client_reference_id === "string"
          ? session.client_reference_id
          : session.metadata?.reservationId;

      const scheduleDocId =
        typeof session.metadata?.scheduleDocId === "string"
          ? session.metadata.scheduleDocId
          : "";

      const studioBookingDocId =
        typeof session.metadata?.studioBookingDocId === "string"
          ? session.metadata.studioBookingDocId
          : "";

      if (!reservationId) {
        logger.error("stripeWebhook: reservationId not found", {
          sessionId: session.id,
        });
        res.status(400).send("reservationId not found");
        return;
      }

      const reservationRef = admin
        .firestore()
        .collection("reservations")
        .doc(reservationId);

      const isFirstPaid = await admin
        .firestore()
        .runTransaction(async (tx) => {
        // Stripe のイベント再送でメールが重複しないよう、初回遷移かどうかを判定する。
        // カード(manual capture)は Checkout 完了時点では「与信(authorized)」であり、
        // 実際の請求(paid)は締切日の captureDueAuthorizations で確定する。
        // paymentMethod 未設定は PayPay 廃止前・Phase B 以前の予約で、完了時点で paid 扱い。
        const prevSnap = await tx.get(reservationRef);
        const prev = prevSnap.exists ? prevSnap.data() || {} : {};
        const isCardAuth = prev.paymentMethod === "card";
        const alreadyFinal =
          prev.paymentStatus === "paid" || prev.paymentStatus === "authorized";
        // カードは capture 時に送るため、ここで送るのは paymentMethod 未設定の旧予約のみ。
        const shouldSendPaidEmail = !alreadyFinal && !isCardAuth;

        const stripePaymentIntentId =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : null;

        tx.set(
          reservationRef,
          isCardAuth
            ? {
                paymentStatus: "authorized",
                reservationStatus: "confirmed",
                paymentProvider: "stripe",
                stripeSessionId: session.id,
                stripePaymentIntentId,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              }
            : {
                paymentStatus: "paid",
                reservationStatus: "confirmed",
                paymentProvider: "stripe",
                stripeSessionId: session.id,
                stripePaymentIntentId,
                paidAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
          { merge: true }
        );

        if (scheduleDocId) {
          const scheduleRef = admin.firestore().collection("schedules").doc(scheduleDocId);

          tx.set(
            scheduleRef,
            {
              status: "reserved",
              isAvailable: false,
              reservationId,
              reservedAt: admin.firestore.FieldValue.serverTimestamp(),
              pendingReservationId: admin.firestore.FieldValue.delete(),
              pendingUserId: admin.firestore.FieldValue.delete(),
              pendingExpiresAt: admin.firestore.FieldValue.delete(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        if (studioBookingDocId) {
          const studioBookingRef = admin
            .firestore()
            .collection("studioBookings")
            .doc(studioBookingDocId);

          tx.set(
            studioBookingRef,
            {
              status: "reserved",
              isAvailable: false,
              reservationId,
              reservedAt: admin.firestore.FieldValue.serverTimestamp(),
              pendingReservationId: admin.firestore.FieldValue.delete(),
              pendingUserId: admin.firestore.FieldValue.delete(),
              pendingExpiresAt: admin.firestore.FieldValue.delete(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        return shouldSendPaidEmail;
      });

      // クーポンの使用確定。Checkout を作っただけでは used にせず、
      // 支払い完了（このイベント）を受けて初めて確定する。
      const couponId =
        typeof session.metadata?.couponId === "string"
          ? session.metadata.couponId
          : "";
      if (couponId) {
        const marked = await markCouponUsed(couponId, reservationId);
        logger.info("stripeWebhook: クーポンを使用済みにしました", {
          reservationId,
          couponId,
          marked,
        });
      }

      logger.info("stripeWebhook: checkout.session.completed 処理", {
        reservationId,
        sessionId: session.id,
        scheduleDocId,
        sendPaidEmail: isFirstPaid,
      });

      // 決済確定メール（paymentMethod 未設定の旧予約のみ。カードは capture 時に送る）
      if (isFirstPaid) {
        await sendPaymentCompletedEmails(reservationId);
      }
    }

    if (event.type === "checkout.session.expired") {
      const session = event.data.object as any;

      const reservationId =
        typeof session.client_reference_id === "string"
          ? session.client_reference_id
          : session.metadata?.reservationId;

      const scheduleDocId =
        typeof session.metadata?.scheduleDocId === "string"
          ? session.metadata.scheduleDocId
          : "";

      const studioBookingDocId =
        typeof session.metadata?.studioBookingDocId === "string"
          ? session.metadata.studioBookingDocId
          : "";

      if (reservationId) {
        const reservationRef = admin
          .firestore()
          .collection("reservations")
          .doc(reservationId);

        await admin.firestore().runTransaction(async (tx) => {
          // Firestore のトランザクションは「読み取り→書き込み」の順序必須のため、
          // 読み取りを先にまとめて行う
          let scheduleRef: FirebaseFirestore.DocumentReference | null = null;
          let shouldReopenSchedule = false;

          if (scheduleDocId) {
            scheduleRef = admin.firestore().collection("schedules").doc(scheduleDocId);
            const scheduleSnap = await tx.get(scheduleRef);

            if (scheduleSnap.exists) {
              const schedule = scheduleSnap.data() || {};
              shouldReopenSchedule =
                schedule.status === "pending" &&
                schedule.pendingReservationId === reservationId;
            }
          }

          let studioBookingRef: FirebaseFirestore.DocumentReference | null = null;
          let shouldReopenStudio = false;

          if (studioBookingDocId) {
            studioBookingRef = admin
              .firestore()
              .collection("studioBookings")
              .doc(studioBookingDocId);
            const studioBookingSnap = await tx.get(studioBookingRef);

            if (studioBookingSnap.exists) {
              const b = studioBookingSnap.data() || {};
              shouldReopenStudio =
                b.status === "pending" &&
                b.pendingReservationId === reservationId;
            }
          }

          tx.set(
            reservationRef,
            {
              paymentStatus: "expired",
              reservationStatus: "expired",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );

          if (shouldReopenSchedule && scheduleRef) {
            tx.update(scheduleRef, {
              status: "open",
              isAvailable: true,
              pendingReservationId: admin.firestore.FieldValue.delete(),
              pendingUserId: admin.firestore.FieldValue.delete(),
              pendingExpiresAt: admin.firestore.FieldValue.delete(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }

          if (shouldReopenStudio && studioBookingRef) {
            tx.update(studioBookingRef, {
              status: "open",
              isAvailable: true,
              pendingReservationId: admin.firestore.FieldValue.delete(),
              pendingUserId: admin.firestore.FieldValue.delete(),
              pendingExpiresAt: admin.firestore.FieldValue.delete(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        });

        // 決済されなかったので、仮押さえしていたクーポンを利用可能に戻す
        const couponId =
          typeof session.metadata?.couponId === "string"
            ? session.metadata.couponId
            : "";
        if (couponId) {
          await releaseCoupon(couponId, reservationId);
        }

        logger.info("stripeWebhook: expired session processed", {
          reservationId,
          sessionId: session.id,
          scheduleDocId,
          couponId,
        });
      }
    }

    res.status(200).send("ok");
  } catch (error: any) {
    logger.error("stripeWebhook processing failed", error);
    res.status(500).send("Webhook processing failed");
  }
});

// ========================================
// Scheduled: レッスン前日リマインダー
// 毎日 18:00 JST に、翌日の確定済みレッスンの生徒・講師へメールを送る
// ========================================
export const sendLessonReminders = pubsub
  .schedule("every day 18:00")
  .timeZone("Asia/Tokyo")
  .onRun(async () => {
    const targetDate = todayJst(1);

    const snapshot = await admin
      .firestore()
      .collection("reservations")
      .where("lessonDate", "==", targetDate)
      .where("reservationStatus", "==", "confirmed")
      .get();

    logger.info("sendLessonReminders start", {
      targetDate,
      total: snapshot.size,
    });

    let sent = 0;

    for (const docSnap of snapshot.docs) {
      // 1件の失敗で全体を止めない
      try {
        const r = docSnap.data() || {};

        // 二重送信防止
        if (r.reminderSentAt) {
          continue;
        }

        const studentEmail = studentEmailOf(r);
        if (studentEmail) {
          await sendMailSafe({
            to: studentEmail,
            subject: "【Geidai Connect】明日のレッスンのご案内",
            html: buildInfoMailHtml({
              greetingName: String(r.name || "ご利用者"),
              intro: ["明日、以下のレッスンのご予約があります。"],
              rows: reservationRows(r),
              outro: ["当日はどうぞよろしくお願いいたします。"],
            }),
          });
        }

        const teacherId = typeof r.teacherId === "string" ? r.teacherId : "";
        if (teacherId) {
          const teacher = await getUserContact(teacherId);
          if (teacher.email) {
            await sendMailSafe({
              to: teacher.email,
              subject: "【Geidai Connect】明日のレッスン予定のご案内",
              html: buildInfoMailHtml({
                greetingName:
                  teacher.displayName || String(r.teacherName || "講師"),
                intro: ["明日、以下のレッスン予定があります。"],
                rows: [
                  ...reservationRows(r),
                  ["生徒氏名", String(r.name ?? "")],
                  ["生徒電話番号", String(r.phone ?? "")],
                ],
                outro: ["当日はどうぞよろしくお願いいたします。"],
              }),
            });
          }
        }

        await docSnap.ref.set(
          { reminderSentAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
        sent += 1;
      } catch (error) {
        logger.error("sendLessonReminders: 1件の処理に失敗", {
          reservationId: docSnap.id,
          error,
        });
      }
    }

    logger.info("sendLessonReminders done", {
      targetDate,
      total: snapshot.size,
      sent,
    });
  });

// ========================================
// スケジュール実行: 期限切れ仮押さえの解放
// ========================================

/**
 * schedules / studioBookings の期限切れ pending を解放する定期掃除。
 * 通常は Stripe の checkout.session.expired webhook が解放するが、
 * webhook が届かなかった場合の保険（pendingExpiresAt を過ぎた枠を open に戻す）。
 * pending フィールドは昇格・解放時に削除されるため、
 * pendingExpiresAt の単一フィールド範囲クエリで stale なドキュメントのみヒットする。
 */
export const releaseExpiredHolds = pubsub
  .schedule("every 10 minutes")
  .timeZone("Asia/Tokyo")
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();
    const counts = { schedules: 0, studioBookings: 0, reservations: 0 };
    const staleReservationIds = new Set<string>();

    for (const collectionName of ["schedules", "studioBookings"] as const) {
      const snap = await admin
        .firestore()
        .collection(collectionName)
        .where("pendingExpiresAt", "<=", now)
        .limit(200)
        .get();

      for (const doc of snap.docs) {
        try {
          await admin.firestore().runTransaction(async (tx) => {
            const fresh = await tx.get(doc.ref);
            if (!fresh.exists) return;
            const data = fresh.data() || {};
            // 再読して pending かつ期限切れであることを確認（webhook との競合対策）
            if (!isPendingExpired(data)) return;

            if (
              typeof data.pendingReservationId === "string" &&
              data.pendingReservationId
            ) {
              staleReservationIds.add(data.pendingReservationId);
            }

            tx.update(doc.ref, {
              status: "open",
              isAvailable: true,
              pendingReservationId: admin.firestore.FieldValue.delete(),
              pendingUserId: admin.firestore.FieldValue.delete(),
              pendingExpiresAt: admin.firestore.FieldValue.delete(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            counts[collectionName] += 1;
          });
        } catch (error) {
          logger.error("releaseExpiredHolds: 解放に失敗", {
            collection: collectionName,
            docId: doc.id,
            error,
          });
        }
      }
    }

    // 解放した枠に紐づく予約を expired に（webhook 処理と冪等）
    for (const rid of staleReservationIds) {
      try {
        const couponId = await admin.firestore().runTransaction(async (tx) => {
          const ref = admin.firestore().collection("reservations").doc(rid);
          const snap = await tx.get(ref);
          if (!snap.exists) return "";
          const r = snap.data() || {};
          if (r.paymentStatus !== "pending_payment") return "";
          tx.set(
            ref,
            {
              paymentStatus: "expired",
              reservationStatus: "expired",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          counts.reservations += 1;
          return typeof r.couponId === "string" ? r.couponId : "";
        });

        // 決済に至らなかった予約が押さえていたクーポンを利用可能に戻す
        if (couponId) {
          await releaseCoupon(couponId, rid);
        }
      } catch (error) {
        logger.error("releaseExpiredHolds: 予約の expired 更新に失敗", {
          reservationId: rid,
          error,
        });
      }
    }

    logger.info("releaseExpiredHolds done", counts);
  });

// ========================================
// Scheduled: カード与信の締切キャプチャ（authorized → paid）
// キャンセル締切（レッスン前日23:59）を過ぎたカード予約を確定請求する。
// ========================================
export const captureDueAuthorizations = pubsub
  .schedule("every 15 minutes")
  .timeZone("Asia/Tokyo")
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();
    const stripe = getStripeClient();
    const counts = { captured: 0, failed: 0 };

    const snap = await admin
      .firestore()
      .collection("reservations")
      .where("paymentStatus", "==", "authorized")
      .limit(200)
      .get();

    for (const doc of snap.docs) {
      const r = doc.data() || {};
      const due = r.chargeDueAt;
      // 締切（chargeDueAt）を過ぎたものだけ請求する
      if (
        !(due instanceof admin.firestore.Timestamp) ||
        due.toMillis() > now.toMillis()
      ) {
        continue;
      }

      const paymentIntentId =
        typeof r.stripePaymentIntentId === "string" ? r.stripePaymentIntentId : "";
      if (!paymentIntentId) {
        logger.error("captureDueAuthorizations: PaymentIntent がありません", {
          reservationId: doc.id,
        });
        continue;
      }

      // Stripe でキャプチャ（確定）。既にキャプチャ済みなら成功扱い。
      let ok = false;
      try {
        await stripe.paymentIntents.capture(paymentIntentId);
        ok = true;
      } catch (error: any) {
        try {
          const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
          if (intent.status === "succeeded") ok = true;
        } catch {
          /* retrieve 失敗は失敗として扱う */
        }
        if (!ok) {
          logger.error("captureDueAuthorizations: capture 失敗", {
            reservationId: doc.id,
            paymentIntentId,
            error,
          });
        }
      }

      // Firestore を冪等に更新（authorized のときのみ遷移）
      let transitionedToPaid = false;
      try {
        await admin.firestore().runTransaction(async (tx) => {
          const fresh = await tx.get(doc.ref);
          if (!fresh.exists) return;
          if ((fresh.data() || {}).paymentStatus !== "authorized") return;

          if (ok) {
            tx.set(
              doc.ref,
              {
                paymentStatus: "paid",
                paidAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            transitionedToPaid = true;
          } else {
            // TODO(Phase C): 決済失敗リカバリ（生徒への再決済案内・自動キャンセル）
            tx.set(
              doc.ref,
              {
                paymentStatus: "payment_failed",
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          }
        });
      } catch (error) {
        logger.error("captureDueAuthorizations: Firestore 更新に失敗", {
          reservationId: doc.id,
          error,
        });
        continue;
      }

      if (transitionedToPaid) {
        counts.captured += 1;
        // 決済確定メール（capture 成功時）
        await sendPaymentCompletedEmails(doc.id);
      } else if (!ok) {
        counts.failed += 1;
        // 請求できなかったので、使用済みにしたクーポンは利用可能に戻す
        const couponId = typeof r.couponId === "string" ? r.couponId : "";
        if (couponId) {
          await restoreUsedCoupon(couponId, doc.id);
        }
      }
    }

    logger.info("captureDueAuthorizations done", counts);
  });

// ========================================
// Callable: 予約キャンセル（レッスン前日まで。与信のみなら取消、請求済みなら返金）
// ========================================
export const cancelReservation = https.onCall(
  async (
    data: { reservationId?: string },
    context
  ): Promise<{ ok: boolean; message: string }> => {
    if (!context.auth) {
      throw new https.HttpsError("unauthenticated", "ログインが必要です。");
    }

    const reservationId =
      typeof data?.reservationId === "string" ? data.reservationId.trim() : "";

    if (!reservationId) {
      throw new https.HttpsError(
        "invalid-argument",
        "予約IDが指定されていません。"
      );
    }

    const reservationRef = admin
      .firestore()
      .collection("reservations")
      .doc(reservationId);

    const snap = await reservationRef.get();
    if (!snap.exists) {
      throw new https.HttpsError("not-found", "予約が見つかりませんでした。");
    }

    const r = snap.data() || {};

    if (r.userId !== context.auth.uid) {
      throw new https.HttpsError(
        "permission-denied",
        "この予約をキャンセルする権限がありません。"
      );
    }

    // paid(即時決済済み) / authorized(カード与信のみ・未請求) のいずれもキャンセル可
    const cancellablePaymentStatuses = new Set(["paid", "authorized"]);
    if (
      r.reservationStatus !== "confirmed" ||
      !cancellablePaymentStatuses.has(r.paymentStatus)
    ) {
      throw new https.HttpsError(
        "failed-precondition",
        "この予約はキャンセルできません（未決済・キャンセル済み・期限切れのいずれか）。"
      );
    }

    // キャンセル期限: レッスン前日の 23:59（JST）まで。当日・過去は不可
    const lessonDate = typeof r.lessonDate === "string" ? r.lessonDate : "";
    if (!lessonDate || lessonDate <= todayJst()) {
      throw new https.HttpsError(
        "failed-precondition",
        "キャンセルはレッスン前日まで可能です。当日のキャンセルはお問い合わせください。"
      );
    }

    const paymentIntentId =
      typeof r.stripePaymentIntentId === "string"
        ? r.stripePaymentIntentId
        : "";

    if (!paymentIntentId) {
      logger.error("cancelReservation: stripePaymentIntentId がありません", {
        reservationId,
      });
      throw new https.HttpsError(
        "internal",
        "決済情報が見つからないため処理できません。お問い合わせください。"
      );
    }

    const isAuthorizedOnly = r.paymentStatus === "authorized";

    logger.info("cancelReservation start", {
      reservationId,
      uid: context.auth.uid,
      lessonDate,
      paymentIntentId,
      paymentStatus: r.paymentStatus,
    });

    // カード与信のみ(authorized)＝請求前なので与信取消（返金・手数料なし）。
    // paid＝全額返金。締切前は通常 authorized だが、キャプチャ直後の競合などに備えて残す。
    // いずれも失敗したら Firestore は変更しない。
    const stripe = getStripeClient();
    let refundId: string | null = null;
    try {
      if (isAuthorizedOnly) {
        await stripe.paymentIntents.cancel(paymentIntentId);
      } else {
        // 二重実行は Stripe 側が charge_already_refunded で拒否する
        const refund = await stripe.refunds.create({
          payment_intent: paymentIntentId,
        });
        refundId = refund?.id ?? null;
      }
    } catch (error: any) {
      logger.error("cancelReservation: 与信取消/返金に失敗", {
        reservationId,
        isAuthorizedOnly,
        error,
      });
      throw new https.HttpsError(
        "internal",
        "キャンセル処理に失敗しました。時間をおいて再度お試しいただくか、お問い合わせください。"
      );
    }

    // この関数は生徒本人からのキャンセルのみを受け付ける（上で userId を検証済み）。
    // 講師都合・運営都合のキャンセル経路を作るときは、ここを変えるのではなく
    // 別の呼び出し口から initiator を渡し、COUPON_ON_CANCEL の表に従わせる。
    const cancelInitiator: CancelInitiator = "student";

    // 返金成功後: 予約をキャンセル済みにし、枠を再開放する
    try {
      const scheduleDocId =
        typeof r.scheduleDocId === "string" ? r.scheduleDocId : "";
      const studioBookingDocId =
        typeof r.studioBookingDocId === "string" ? r.studioBookingDocId : "";

      await admin.firestore().runTransaction(async (tx) => {
        let scheduleRef: FirebaseFirestore.DocumentReference | null = null;
        let shouldReopenSchedule = false;

        if (scheduleDocId) {
          scheduleRef = admin
            .firestore()
            .collection("schedules")
            .doc(scheduleDocId);
          const scheduleSnap = await tx.get(scheduleRef);

          if (scheduleSnap.exists) {
            const schedule = scheduleSnap.data() || {};
            // この予約が押さえている枠のときだけ再開放する
            shouldReopenSchedule = schedule.reservationId === reservationId;
          }
        }

        let studioBookingRef: FirebaseFirestore.DocumentReference | null = null;
        let shouldReopenStudio = false;

        if (studioBookingDocId) {
          studioBookingRef = admin
            .firestore()
            .collection("studioBookings")
            .doc(studioBookingDocId);
          const studioBookingSnap = await tx.get(studioBookingRef);

          if (studioBookingSnap.exists) {
            const b = studioBookingSnap.data() || {};
            shouldReopenStudio = b.reservationId === reservationId;
          }
        }

        tx.set(
          reservationRef,
          {
            reservationStatus: "cancelled",
            // 与信取消は未請求のため voided、返金は refunded
            paymentStatus: isAuthorizedOnly ? "voided" : "refunded",
            refundId,
            cancelledBy: cancelInitiator,
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        if (shouldReopenSchedule && scheduleRef) {
          tx.set(
            scheduleRef,
            {
              status: "open",
              isAvailable: true,
              reservationId: admin.firestore.FieldValue.delete(),
              reservedAt: admin.firestore.FieldValue.delete(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        if (shouldReopenStudio && studioBookingRef) {
          tx.set(
            studioBookingRef,
            {
              status: "open",
              isAvailable: true,
              reservationId: admin.firestore.FieldValue.delete(),
              reservedAt: admin.firestore.FieldValue.delete(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
      });
    } catch (error) {
      // Stripe 側（与信取消/返金）は完了しているが Firestore 未反映 = 要手動対応
      logger.error(
        "cancelReservation: Stripe 処理後の Firestore 更新に失敗（要手動対応）",
        { reservationId, refundId, isAuthorizedOnly, error }
      );
      throw new https.HttpsError(
        "internal",
        "キャンセルは完了しましたが予約情報の更新に失敗しました。お手数ですがお問い合わせください。"
      );
    }

    // クーポンの扱いはキャンセルした側で決まる（COUPON_ON_CANCEL）。
    // 生徒都合は消費したまま。運営・講師都合のときだけ利用可能に戻す。
    const usedCouponId = typeof r.couponId === "string" ? r.couponId : "";
    if (usedCouponId) {
      if (COUPON_ON_CANCEL[cancelInitiator] === "restore") {
        await restoreUsedCoupon(usedCouponId, reservationId);
      } else {
        // 決済前（reserved のまま）にキャンセルされた場合だけは解放する。
        // 使わないまま塩漬けになるのを防ぐためで、使用済みのものは戻さない。
        await releaseCoupon(usedCouponId, reservationId);
      }
    }

    logger.info("cancelReservation success", {
      reservationId,
      refundId,
      isAuthorizedOnly,
      couponId: usedCouponId,
      cancelledBy: cancelInitiator,
    });

    // 通知メール（失敗してもキャンセル自体は成功として返す）
    const studentEmail = studentEmailOf(r);
    if (studentEmail) {
      await sendMailSafe({
        to: studentEmail,
        subject: isAuthorizedOnly
          ? "【Geidai Connect】ご予約をキャンセルしました"
          : "【Geidai Connect】ご予約をキャンセルしました（全額返金）",
        html: buildInfoMailHtml({
          greetingName: String(r.name || "ご利用者"),
          intro: isAuthorizedOnly
            ? [
                "以下のご予約のキャンセルを受け付けました。",
                "お支払い前のキャンセルのため、請求は発生しません。",
              ]
            : [
                "以下のご予約のキャンセルを受け付け、全額返金の手続きを行いました。",
                "返金の反映時期はカード会社等によって異なります。",
              ],
          rows: reservationRows(r),
          outro: ["またのご利用をお待ちしております。"],
        }),
      });
    }

    const teacherId = typeof r.teacherId === "string" ? r.teacherId : "";
    if (teacherId) {
      const teacher = await getUserContact(teacherId);
      if (teacher.email) {
        await sendMailSafe({
          to: teacher.email,
          subject: "【Geidai Connect】予約がキャンセルされました",
          html: buildInfoMailHtml({
            greetingName:
              teacher.displayName || String(r.teacherName || "講師"),
            intro: [
              "以下の予約が生徒によってキャンセルされました。",
              "該当の時間枠は再度予約可能な状態に戻っています。",
            ],
            rows: [...reservationRows(r), ["生徒氏名", String(r.name ?? "")]],
          }),
        });
      }
    }

    return {
      ok: true,
      message: isAuthorizedOnly
        ? "予約をキャンセルしました。お支払い前のため請求は発生しません。"
        : "予約をキャンセルし、全額返金の手続きを行いました。",
    };
  }
);

// ========================================
// Callable: 予約の日程変更（振替）
// 当日でもレッスン開始前まで／1予約1回まで／自宅・出張のみ（スタジオは対象外）。
// 支払いはそのまま新しい日時へ移し、新規課金・返金は行わない。
// ========================================
const RESCHEDULE_MAX_DAYS_AHEAD = 30;

export const rescheduleReservation = https.onCall(
  async (
    data: { reservationId?: string; newDate?: string; newTime?: string },
    context
  ): Promise<{ ok: boolean; message: string }> => {
    if (!context.auth) {
      throw new https.HttpsError("unauthenticated", "ログインが必要です。");
    }

    const reservationId =
      typeof data?.reservationId === "string" ? data.reservationId.trim() : "";
    const newDate = typeof data?.newDate === "string" ? data.newDate.trim() : "";
    const newTime = typeof data?.newTime === "string" ? data.newTime.trim() : "";

    if (
      !reservationId ||
      !/^\d{4}-\d{2}-\d{2}$/.test(newDate) ||
      !/^\d{2}:\d{2}$/.test(newTime)
    ) {
      throw new https.HttpsError("invalid-argument", "変更内容が正しくありません。");
    }

    const uid = context.auth.uid;
    const reservationRef = admin
      .firestore()
      .collection("reservations")
      .doc(reservationId);
    const snap = await reservationRef.get();
    if (!snap.exists) {
      throw new https.HttpsError("not-found", "予約が見つかりませんでした。");
    }
    const r = snap.data() || {};

    if (r.userId !== uid) {
      throw new https.HttpsError(
        "permission-denied",
        "この予約を変更する権限がありません。"
      );
    }

    // 確定済み & 決済が authorized(与信のみ)/paid(請求済み) のみ日程変更可
    const reschedulablePaymentStatuses = new Set(["authorized", "paid"]);
    if (
      r.reservationStatus !== "confirmed" ||
      !reschedulablePaymentStatuses.has(String(r.paymentStatus))
    ) {
      throw new https.HttpsError(
        "failed-precondition",
        "この予約は日程変更できません。"
      );
    }

    // スタジオレッスンは当面対象外（スタジオ枠の再ロックが必要なため）
    const lessonType = typeof r.lessonType === "string" ? r.lessonType : "";
    if (r.studioId || lessonType === "スタジオ") {
      throw new https.HttpsError(
        "failed-precondition",
        "スタジオレッスンの日程変更は、お手数ですがお問い合わせください。"
      );
    }
    // オンラインは会場の再確保が不要なので日程変更の対象に含める
    if (
      lessonType !== "自宅" &&
      lessonType !== "出張" &&
      lessonType !== "オンライン"
    ) {
      throw new https.HttpsError(
        "failed-precondition",
        "このレッスンは日程変更の対象外です。"
      );
    }

    // 日程変更は1予約につき1回まで
    const rescheduleCount =
      typeof r.rescheduleCount === "number" ? r.rescheduleCount : 0;
    if (rescheduleCount >= 1) {
      throw new https.HttpsError(
        "failed-precondition",
        "日程変更は1回までです。以降の変更はお問い合わせください。"
      );
    }

    const now = new Date();
    const origDate = typeof r.lessonDate === "string" ? r.lessonDate : "";
    const origTime = typeof r.lessonTime === "string" ? r.lessonTime : "";
    // 元レッスンの開始時刻より前のみ変更可（当日でも開始前ならOK）
    const origStart = new Date(`${origDate}T${origTime || "00:00"}:00+09:00`);
    if (!(now < origStart)) {
      throw new https.HttpsError(
        "failed-precondition",
        "レッスン開始後は日程変更できません。"
      );
    }

    const newStart = new Date(`${newDate}T${newTime}:00+09:00`);
    if (!(now < newStart)) {
      throw new https.HttpsError(
        "failed-precondition",
        "変更先はこれからの日時をお選びください。"
      );
    }
    if (newDate > todayJst(RESCHEDULE_MAX_DAYS_AHEAD)) {
      throw new https.HttpsError(
        "failed-precondition",
        `日程変更はレッスンの${RESCHEDULE_MAX_DAYS_AHEAD}日先まででお選びください。`
      );
    }

    const teacherId = typeof r.teacherId === "string" ? r.teacherId : "";
    if (!teacherId) {
      throw new https.HttpsError("internal", "講師情報が見つかりません。");
    }
    const oldScheduleDocId =
      typeof r.scheduleDocId === "string" ? r.scheduleDocId : "";
    const newScheduleDocId = buildScheduleDocId(teacherId, newDate, newTime);
    if (newScheduleDocId === oldScheduleDocId) {
      throw new https.HttpsError(
        "failed-precondition",
        "現在と同じ日時です。別の日時をお選びください。"
      );
    }

    // 移動バッファ判定用の候補予約（場所は元予約の座標・キーを流用）
    const durationMin =
      typeof r.durationMin === "number" && r.durationMin > 0
        ? r.durationMin
        : parseLessonDurationMin(r.lessonCourse);
    const candStart = timeToMin(newTime);
    const candBooking: DayBooking = {
      start: candStart,
      end: candStart + durationMin,
      loc: {
        lat: typeof r.lessonLat === "number" ? r.lessonLat : undefined,
        lng: typeof r.lessonLng === "number" ? r.lessonLng : undefined,
        key:
          typeof r.locationKey === "string" && r.locationKey
            ? r.locationKey
            : `res:${reservationId}`,
      },
    };

    await admin.firestore().runTransaction(async (tx) => {
      const newSchedRef = admin
        .firestore()
        .collection("schedules")
        .doc(newScheduleDocId);
      const newSchedSnap = await tx.get(newSchedRef);
      if (!newSchedSnap.exists) {
        throw new https.HttpsError(
          "not-found",
          "選択した時間枠は登録されていません。"
        );
      }
      const ns = newSchedSnap.data() || {};
      const txNow = new Date();

      const nsStatus = String(ns.status || "open").toLowerCase();
      const nsAvailable =
        typeof ns.isAvailable === "boolean" ? ns.isAvailable : true;
      const nsBlocked = !nsAvailable || UNAVAILABLE_STATUSES.has(nsStatus);
      if (nsBlocked && !isPendingExpired(ns, txNow)) {
        throw new https.HttpsError(
          "already-exists",
          "選択した時間枠はすでに予約済み、または受付停止です。"
        );
      }

      // 枠が許可するレッスン方法（自宅/出張）か
      const allowedMethods = Array.isArray(ns.lessonMethods)
        ? ns.lessonMethods.filter((v: unknown): v is string => typeof v === "string")
        : [];
      if (allowedMethods.length > 0 && !allowedMethods.includes(lessonType)) {
        throw new https.HttpsError(
          "failed-precondition",
          "選択した時間枠では、このレッスン方法は受け付けていません。"
        );
      }

      // 新日付での移動時間・重複チェック（自分自身は除外）
      const dayBookings = await loadTeacherDayBookings(teacherId, newDate, {
        tx,
        excludeReservationIds: new Set([reservationId]),
      });
      const conflict = findScheduleConflict(candBooking, dayBookings);
      if (conflict) {
        if (conflict.type === "overlap") {
          throw new https.HttpsError(
            "already-exists",
            "この時間帯は講師の他の予約と重複しています。別の時間をお選びください。"
          );
        }
        throw new https.HttpsError(
          "failed-precondition",
          "前後の予約との間に移動時間が確保できません。別の時間帯をお選びください。"
        );
      }

      // 旧枠を再開放するか（この予約が押さえている枠のときだけ）
      let reopenOldRef: FirebaseFirestore.DocumentReference | null = null;
      if (oldScheduleDocId) {
        const oldRef = admin
          .firestore()
          .collection("schedules")
          .doc(oldScheduleDocId);
        const oldSnap = await tx.get(oldRef);
        if (
          oldSnap.exists &&
          (oldSnap.data() || {}).reservationId === reservationId
        ) {
          reopenOldRef = oldRef;
        }
      }

      // --- 書き込み ---
      // 新しい枠を確保
      tx.set(
        newSchedRef,
        {
          status: "reserved",
          isAvailable: false,
          reservationId,
          reservedAt: admin.firestore.FieldValue.serverTimestamp(),
          pendingReservationId: admin.firestore.FieldValue.delete(),
          pendingUserId: admin.firestore.FieldValue.delete(),
          pendingExpiresAt: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // 旧枠を再開放
      if (reopenOldRef) {
        tx.set(
          reopenOldRef,
          {
            status: "open",
            isAvailable: true,
            reservationId: admin.firestore.FieldValue.delete(),
            reservedAt: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      // 予約本体を新日時へ。支払いはそのまま、締切キャプチャ予定を新レッスン前日に。
      tx.set(
        reservationRef,
        {
          lessonDate: newDate,
          lessonTime: newTime,
          scheduleDocId: newScheduleDocId,
          chargeDueAt: chargeDueTimestamp(newDate),
          rescheduleCount: rescheduleCount + 1,
          rescheduledAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    logger.info("rescheduleReservation success", {
      reservationId,
      uid,
      from: `${origDate} ${origTime}`,
      to: `${newDate} ${newTime}`,
    });

    // 通知メール（失敗しても振替自体は成功として返す）
    const updated = { ...r, lessonDate: newDate, lessonTime: newTime };
    const studentEmail = studentEmailOf(r);
    if (studentEmail) {
      await sendMailSafe({
        to: studentEmail,
        subject: "【Geidai Connect】ご予約の日程を変更しました",
        html: buildInfoMailHtml({
          greetingName: String(r.name || "ご利用者"),
          intro: [
            "以下のとおり、ご予約の日程を変更しました。",
            `変更前：${origDate} ${origTime}`,
          ],
          rows: reservationRows(updated),
          outro: ["当日はお気をつけてお越しください。"],
        }),
      });
    }

    if (teacherId) {
      const teacher = await getUserContact(teacherId);
      if (teacher.email) {
        await sendMailSafe({
          to: teacher.email,
          subject: "【Geidai Connect】予約の日程が変更されました",
          html: buildInfoMailHtml({
            greetingName:
              teacher.displayName || String(r.teacherName || "講師"),
            intro: [
              "生徒により予約の日程が変更されました。",
              `変更前：${origDate} ${origTime}`,
              "変更前の時間枠は再度予約可能な状態に戻っています。",
            ],
            rows: [...reservationRows(updated), ["生徒氏名", String(r.name ?? "")]],
          }),
        });
      }
    }

    return {
      ok: true,
      message: `予約を ${newDate} ${newTime} に変更しました。`,
    };
  }
);

// ========================================
// Callable: オンラインレッスンの参加URLを講師が登録する
// 予約ドキュメントの update ルールは生徒本人のみに開いているため、
// 講師からの更新は Admin SDK 経由（この関数）で行う。
// ========================================
export const setMeetingUrl = https.onCall(
  async (
    data: { reservationId?: string; meetingUrl?: string },
    context
  ): Promise<{ ok: boolean; message: string }> => {
    if (!context.auth) {
      throw new https.HttpsError("unauthenticated", "ログインが必要です。");
    }

    const reservationId =
      typeof data?.reservationId === "string" ? data.reservationId.trim() : "";
    const meetingUrl =
      typeof data?.meetingUrl === "string" ? data.meetingUrl.trim() : "";

    if (!reservationId) {
      throw new https.HttpsError("invalid-argument", "予約が指定されていません。");
    }

    // 空文字は「URLを取り消す」意味として許可する
    if (meetingUrl) {
      if (meetingUrl.length > 500) {
        throw new https.HttpsError(
          "invalid-argument",
          "URLが長すぎます（500文字以内）。"
        );
      }
      // http:// を弾き https のみ許可（生徒に安全でないリンクを送らせない）
      let parsed: URL;
      try {
        parsed = new URL(meetingUrl);
      } catch {
        throw new https.HttpsError(
          "invalid-argument",
          "URLの形式が正しくありません。https:// から始まるURLを入力してください。"
        );
      }
      if (parsed.protocol !== "https:") {
        throw new https.HttpsError(
          "invalid-argument",
          "https:// から始まるURLを入力してください。"
        );
      }
    }

    const ref = admin.firestore().collection("reservations").doc(reservationId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new https.HttpsError("not-found", "予約が見つかりません。");
    }

    const r = snap.data() || {};
    if (r.teacherId !== context.auth.uid) {
      throw new https.HttpsError(
        "permission-denied",
        "この予約のURLを登録する権限がありません。"
      );
    }
    if (r.lessonType !== "オンライン") {
      throw new https.HttpsError(
        "failed-precondition",
        "オンラインレッスン以外にはURLを登録できません。"
      );
    }

    await ref.update({
      meetingUrl: meetingUrl || null,
      meetingUrlUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info("setMeetingUrl updated", {
      reservationId,
      teacherId: context.auth.uid,
      cleared: !meetingUrl,
    });

    return {
      ok: true,
      message: meetingUrl
        ? "参加URLを登録しました。生徒に案内されます。"
        : "参加URLを取り消しました。",
    };
  }
);

// ========================================
// Callable: お問い合わせフォーム送信（未ログインでも可）
// ========================================
export const submitContact = https.onCall(
  async (
    data: {
      name?: string;
      email?: string;
      subject?: string;
      message?: string;
    },
    context
  ): Promise<{ ok: boolean; message: string }> => {
    const name = typeof data?.name === "string" ? data.name.trim() : "";
    const email = typeof data?.email === "string" ? data.email.trim() : "";
    const subject =
      typeof data?.subject === "string" ? data.subject.trim() : "";
    const message =
      typeof data?.message === "string" ? data.message.trim() : "";

    if (!name || !email || !subject || !message) {
      throw new https.HttpsError(
        "invalid-argument",
        "お名前・メールアドレス・件名・お問い合わせ内容をすべて入力してください。"
      );
    }

    // App Check 未導入のため、スパム対策は入力検証のみ（将来課題）
    if (name.length > 100 || subject.length > 200 || message.length > 5000) {
      throw new https.HttpsError(
        "invalid-argument",
        "入力された文字数が上限を超えています。"
      );
    }

    if (!isValidEmail(email)) {
      throw new https.HttpsError(
        "invalid-argument",
        "メールアドレスの形式が正しくありません。"
      );
    }

    const docRef = await admin.firestore().collection("contacts").add({
      name,
      email,
      subject,
      message,
      userId: context.auth?.uid ?? null,
      status: "new",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info("submitContact saved", {
      contactId: docRef.id,
      userId: context.auth?.uid ?? null,
    });

    // 運営宛通知（失敗しても Firestore 保存済みなので成功として返す）
    await sendMailSafe({
      to: CONTACT_TO.value(),
      replyTo: email,
      subject: `【Geidai Connect】お問い合わせ: ${subject}`,
      html: buildInfoMailHtml({
        greetingName: "運営ご担当者",
        intro: ["お問い合わせフォームから新しいお問い合わせが届きました。"],
        rows: [
          ["お名前", name],
          ["メールアドレス", email],
          ["件名", subject],
          ["ユーザーID", context.auth?.uid ?? "未ログイン"],
        ],
        outro: [
          "―― お問い合わせ内容 ――",
          escapeHtml(message).replace(/\n/g, "<br />"),
        ],
      }),
    });

    return {
      ok: true,
      message: "お問い合わせを受け付けました。",
    };
  }
);

// ========================================
// Callable: 演奏・展示などの依頼フォーム送信（未ログインでも可）
// ========================================
const REQUEST_TYPE_VALUES = [
  "演奏の依頼",
  "展示・制作の依頼",
  "レッスン・講演の依頼",
  "その他",
] as const;

export const submitRequest = https.onCall(
  async (
    data: {
      requestType?: string;
      name?: string;
      furigana?: string;
      email?: string;
      phone?: string;
      organization?: string;
      eventDate?: string;
      venue?: string;
      budget?: string;
      genre?: string;
      message?: string;
    },
    context
  ): Promise<{ ok: boolean; message: string }> => {
    const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

    const requestType = str(data?.requestType);
    const name = str(data?.name);
    const furigana = str(data?.furigana);
    const email = str(data?.email);
    const phone = str(data?.phone);
    const organization = str(data?.organization);
    const eventDate = str(data?.eventDate);
    const venue = str(data?.venue);
    const budget = str(data?.budget);
    const genre = str(data?.genre);
    const message = str(data?.message);

    if (!requestType || !name || !furigana || !email || !phone || !message) {
      throw new https.HttpsError(
        "invalid-argument",
        "依頼の種類・お名前・ふりがな・メールアドレス・電話番号・依頼内容をすべて入力してください。"
      );
    }

    if (!(REQUEST_TYPE_VALUES as readonly string[]).includes(requestType)) {
      throw new https.HttpsError(
        "invalid-argument",
        "依頼の種類の値が正しくありません。"
      );
    }

    // App Check 未導入のため、スパム対策は入力検証のみ（submitContact と同方針）
    if (
      name.length > 100 ||
      furigana.length > 100 ||
      phone.length > 30 ||
      organization.length > 200 ||
      eventDate.length > 100 ||
      venue.length > 300 ||
      budget.length > 100 ||
      genre.length > 200 ||
      message.length > 5000
    ) {
      throw new https.HttpsError(
        "invalid-argument",
        "入力された文字数が上限を超えています。"
      );
    }

    if (!isValidEmail(email)) {
      throw new https.HttpsError(
        "invalid-argument",
        "メールアドレスの形式が正しくありません。"
      );
    }

    const docRef = await admin.firestore().collection("requests").add({
      requestType,
      name,
      furigana,
      email,
      phone,
      organization,
      eventDate,
      venue,
      budget,
      genre,
      message,
      userId: context.auth?.uid ?? null,
      status: "new",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info("submitRequest saved", {
      requestId: docRef.id,
      requestType,
      userId: context.auth?.uid ?? null,
    });

    // 運営宛通知（失敗しても Firestore 保存済みなので成功として返す）
    await sendMailSafe({
      to: CONTACT_TO.value(),
      replyTo: email,
      subject: `【Geidai Connect】${requestType}: ${name}`,
      html: buildInfoMailHtml({
        greetingName: "運営ご担当者",
        intro: ["依頼フォームから新しい依頼が届きました。"],
        rows: [
          ["依頼の種類", requestType],
          ["お名前", name],
          ["ふりがな", furigana],
          ["メールアドレス", email],
          ["電話番号", phone],
          ["会社・団体名", organization || "未入力"],
          ["希望日・時期", eventDate || "未定"],
          ["開催場所", venue || "未定"],
          ["ご予算", budget || "未定"],
          ["希望ジャンル・楽器", genre || "未入力"],
          ["ユーザーID", context.auth?.uid ?? "未ログイン"],
        ],
        outro: [
          "―― 依頼内容 ――",
          escapeHtml(message).replace(/\n/g, "<br />"),
        ],
      }),
    });

    return {
      ok: true,
      message: "依頼を受け付けました。",
    };
  }
);

// ========================================
// Callable: 講師応募フォーム送信（未ログインでも可）
// ========================================
export const submitTeacherApplication = https.onCall(
  async (
    data: {
      name?: string;
      furigana?: string;
      email?: string;
      phone?: string;
      address?: {
        prefecture?: string;
        city?: string;
        town?: string;
        line?: string;
      };
      subject?: string;
      graduationYear?: number;
      bio?: string;
    },
    context
  ): Promise<{ ok: boolean; message: string }> => {
    const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

    const name = str(data?.name);
    const furigana = str(data?.furigana);
    const email = str(data?.email);
    const phone = str(data?.phone);
    const address = {
      prefecture: str(data?.address?.prefecture),
      city: str(data?.address?.city),
      town: str(data?.address?.town),
      line: str(data?.address?.line),
    };
    const subject = str(data?.subject);
    const bio = str(data?.bio);
    const graduationYear = data?.graduationYear;

    if (
      !name ||
      !furigana ||
      !email ||
      !phone ||
      !address.prefecture ||
      !address.city ||
      !address.town ||
      !address.line ||
      !subject ||
      !bio
    ) {
      throw new https.HttpsError(
        "invalid-argument",
        "応募フォームの必須項目をすべて入力してください。"
      );
    }

    // App Check 未導入のため、スパム対策は入力検証のみ（将来課題）
    if (
      name.length > 100 ||
      furigana.length > 100 ||
      subject.length > 50 ||
      address.prefecture.length > 20 ||
      address.city.length > 50 ||
      address.town.length > 50 ||
      address.line.length > 200 ||
      bio.length > 2000
    ) {
      throw new https.HttpsError(
        "invalid-argument",
        "入力された文字数が上限を超えています。"
      );
    }

    if (!isValidEmail(email)) {
      throw new https.HttpsError(
        "invalid-argument",
        "メールアドレスの形式が正しくありません。"
      );
    }

    if (!/^\d{10,11}$/.test(phone)) {
      throw new https.HttpsError(
        "invalid-argument",
        "電話番号は10〜11桁の数字で入力してください。"
      );
    }

    const currentYear = new Date().getFullYear();
    if (
      typeof graduationYear !== "number" ||
      !Number.isInteger(graduationYear) ||
      graduationYear < 1950 ||
      graduationYear > currentYear
    ) {
      throw new https.HttpsError(
        "invalid-argument",
        "卒業年が正しくありません。"
      );
    }


    const docRef = await admin
      .firestore()
      .collection("teacherApplications")
      .add({
        name,
        furigana,
        email,
        phone,
        address,
        subject,
        graduationYear,
        bio,
        userId: context.auth?.uid ?? null,
        status: "new",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    logger.info("submitTeacherApplication saved", {
      applicationId: docRef.id,
      userId: context.auth?.uid ?? null,
    });

    // 運営宛通知（失敗しても Firestore 保存済みなので成功として返す）
    await sendMailSafe({
      to: CONTACT_TO.value(),
      replyTo: email,
      subject: `【Geidai Connect】講師応募: ${name}（${subject}）`,
      html: buildInfoMailHtml({
        greetingName: "運営ご担当者",
        intro: ["講師募集フォームから新しい応募が届きました。"],
        rows: [
          ["氏名", name],
          ["ふりがな", furigana],
          ["メールアドレス", email],
          ["電話番号", phone],
          [
            "住所",
            `${address.prefecture}${address.city}${address.town} ${address.line}`,
          ],
          ["専攻", subject],
          ["卒業年", `${graduationYear}年`],
          ["ユーザーID", context.auth?.uid ?? "未ログイン"],
        ],
        outro: [
          "―― 経歴・自己PR ――",
          escapeHtml(bio).replace(/\n/g, "<br />"),
        ],
      }),
    });

    return {
      ok: true,
      message: "ご応募を受け付けました。",
    };
  }
);

// ========================================
// 【一時】カレンダー連携セットアップ用の管理関数（作業後に削除する）
// GET /studioAdminHttp?secret=..&action=whoami|enableCalendarApi|freebusyTest|setCalendar
// ========================================
export const studioAdminHttp = https.onRequest(async (req, res) => {
  try {
    const secret = typeof req.query.secret === "string" ? req.query.secret : "";
    const expected = STUDIO_ADMIN_SECRET.value();
    if (!expected || secret !== expected) {
      res.status(403).send("forbidden");
      return;
    }

    const action =
      typeof req.query.action === "string" ? req.query.action : "";

    if (action === "whoami") {
      // 実行中の Functions ランタイム サービスアカウントのメールを metadata から取得
      const meta = await fetch(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
        { headers: { "Metadata-Flavor": "Google" } }
      );
      const email = (await meta.text()).trim();
      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });
      const projectId = await auth.getProjectId();
      res.status(200).json({ ok: true, serviceAccount: email, projectId });
      return;
    }

    if (action === "enableCalendarApi") {
      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });
      const projectId = await auth.getProjectId();
      const su = google.serviceusage({ version: "v1", auth });
      const op = await su.services.enable({
        name: `projects/${projectId}/services/calendar-json.googleapis.com`,
      });
      res.status(200).json({ ok: true, done: op.data.done ?? null, name: op.data.name ?? null });
      return;
    }

    if (action === "freebusyTest") {
      const calendarId =
        typeof req.query.calendarId === "string" ? req.query.calendarId : "";
      const date = typeof req.query.date === "string" ? req.query.date : "";
      const time = typeof req.query.time === "string" ? req.query.time : "";
      if (!calendarId || !date || !time) {
        res.status(400).json({ ok: false, error: "calendarId/date/time required" });
        return;
      }
      const start = new Date(`${date}T${time}:00+09:00`);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      });
      const calendar = google.calendar({ version: "v3", auth });
      const r = await calendar.freebusy.query({
        requestBody: {
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          items: [{ id: calendarId }],
        },
      });
      const cal = r.data.calendars?.[calendarId];
      res.status(200).json({
        ok: true,
        calendarId,
        window: { timeMin: start.toISOString(), timeMax: end.toISOString() },
        busy: cal?.busy ?? [],
        errors: cal?.errors ?? [],
        free: (cal?.busy ?? []).length === 0 && (cal?.errors ?? []).length === 0,
      });
      return;
    }

    if (action === "setCalendar") {
      const studioId =
        typeof req.query.studioId === "string" ? req.query.studioId : "";
      const calendarId =
        typeof req.query.calendarId === "string" ? req.query.calendarId : "";
      if (!studioId) {
        res.status(400).json({ ok: false, error: "studioId required" });
        return;
      }
      await admin
        .firestore()
        .collection("studios")
        .doc(studioId)
        .set(
          { calendarId, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
      res.status(200).json({ ok: true, studioId, calendarId });
      return;
    }

    res.status(400).json({ ok: false, error: "unknown action" });
  } catch (error: any) {
    logger.error("studioAdminHttp failed", error);
    res.status(500).json({
      ok: false,
      error: String(error?.message || error),
      details: error?.errors || error?.response?.data || null,
    });
  }
});
