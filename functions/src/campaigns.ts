// キャンペーン（クーポン・友達紹介）の共通ロジック
//
// index.ts から一方向に import される。ここから index.ts を import してはいけない
// （循環参照になる）。admin.initializeApp() は index.ts が行うため、
// このファイルではモジュール読み込み時に admin.firestore() を呼ばないこと。
import * as admin from "firebase-admin";
import { https, logger, pubsub } from "firebase-functions/v1";

// ========================================
// キャンペーンの識別子
// クーポンやレビューに保存し、後からキャンペーン単位で集計・打ち切りできるようにする。
// ========================================
export const REVIEW_CAMPAIGN_ID = "review-2026";
export const REFERRAL_CAMPAIGN_ID = "referral-2026";

/** 紹介者への特典が発生する、被紹介者の完了レッスン数 */
export const REFERRER_REWARD_LESSON_COUNT = 3;

// ========================================
// クーポンの仕様
// ========================================

/**
 * クーポンの状態。
 *  available: 利用可能
 *  reserved : Checkout 作成〜決済完了までの仮押さえ（他予約で使えない）
 *  used     : 決済完了により使用済み
 *  expired  : 有効期限切れ
 *  cancelled: 運営による無効化
 */
export type CouponStatus =
  | "available"
  | "reserved"
  | "used"
  | "expired"
  | "cancelled";

export type CouponType = "review" | "referral_referee" | "referral_referrer";

export type CouponSpec = {
  name: string;
  /** 値引き額（円・税込） */
  discountAmount: number;
  /** 最低利用金額。値引き前の小計がこの額未満だと使えない */
  minAmount: number;
  /** 発行日からの有効日数 */
  validDays: number;
  /** 利用条件の説明（画面表示用） */
  terms: string;
};

export const COUPON_SPECS: Record<CouponType, CouponSpec> = {
  review: {
    name: "レビュー投稿クーポン",
    discountAmount: 500,
    minAmount: 4000,
    validDays: 60,
    terms:
      "レッスン料 4,000円以上のご予約で利用できます。1回限り・他のクーポンとの併用不可。",
  },
  referral_referee: {
    name: "友達紹介クーポン（ご招待特典）",
    discountAmount: 500,
    minAmount: 4000,
    validDays: 60,
    terms:
      "レッスン料 4,000円以上のご予約で利用できます。1回限り・他のクーポンとの併用不可。",
  },
  referral_referrer: {
    name: "友達紹介クーポン（ご紹介特典）",
    discountAmount: 1000,
    minAmount: 4000,
    validDays: 60,
    terms:
      "レッスン料 4,000円以上のご予約で利用できます。1回限り・他のクーポンとの併用不可。",
  },
};

/** Stripe が受け付ける JPY の最小決済額。値引き後がこれを下回る組み合わせは拒否する */
export const MIN_PAYABLE_AMOUNT = 50;

/**
 * キャンセル時にクーポンを返すかどうか。
 * 生徒都合のキャンセルは原則として消費（戻さない）。運営・講師都合は返す。
 * 運用方針が変わったらこの表だけを変えれば済むよう、判定を1か所に集約している。
 */
export type CancelInitiator = "student" | "teacher" | "operator";

export const COUPON_ON_CANCEL: Record<CancelInitiator, "consume" | "restore"> = {
  student: "consume",
  teacher: "restore",
  operator: "restore",
};

// ========================================
// クーポンの発行・状態遷移
// ========================================

export type CouponSource = {
  /** 付与のきっかけ。"review" なら対象レビュー、紹介なら被紹介者の uid */
  campaign: string;
  reviewId?: string;
  reservationId?: string;
  refereeUid?: string;
  referrerUid?: string;
};

export function couponsCollection() {
  return admin.firestore().collection("coupons");
}

/**
 * 付与の重複防止用の台帳。ドキュメント ID を決め打ちにすることで、
 * トランザクション内で「クエリなしに」既付与を判定できる。
 * レビューを削除して再投稿しても、この台帳が残るため再付与されない。
 */
export function couponGrantRef(grantKey: string) {
  return admin.firestore().collection("couponGrants").doc(grantKey);
}

export const grantKeys = {
  /** 1ユーザー1回のレビューキャンペーン */
  reviewUser: (uid: string) => `review_user_${uid}`,
  /** 同じ予約に対する二重付与の防止 */
  reviewReservation: (reservationId: string) => `review_res_${reservationId}`,
  /** 被紹介者への初回特典 */
  referralReferee: (refereeUid: string) => `referral_referee_${refereeUid}`,
  /** 紹介者への3回目特典 */
  referralReferrer: (refereeUid: string) => `referral_referrer_${refereeUid}`,
};

export function expiresAtFromNow(validDays: number): admin.firestore.Timestamp {
  const d = new Date();
  d.setDate(d.getDate() + validDays);
  return admin.firestore.Timestamp.fromDate(d);
}

/**
 * クーポンを発行する（トランザクションの書き込みフェーズで呼ぶ）。
 * 付与台帳（couponGrants）の作成も同時に行い、再付与を防ぐ。
 */
export function issueCouponInTx(
  tx: FirebaseFirestore.Transaction,
  params: {
    userId: string;
    type: CouponType;
    source: CouponSource;
    /** 重複付与を防ぐための台帳キー */
    grantKey: string;
  }
): { couponId: string; discountAmount: number } {
  const spec = COUPON_SPECS[params.type];
  const ref = couponsCollection().doc();

  tx.set(ref, {
    couponId: ref.id,
    userId: params.userId,
    type: params.type,
    name: spec.name,
    discountAmount: spec.discountAmount,
    minAmount: spec.minAmount,
    terms: spec.terms,
    // 他クーポンとの併用は不可。1予約につき1枚だけ選べる。
    combinable: false,
    status: "available" as CouponStatus,
    issuedAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: expiresAtFromNow(spec.validDays),
    // 使用状況
    reservedReservationId: null,
    usedReservationId: null,
    usedAt: null,
    // 付与のきっかけ（運営が追跡できるように残す）
    source: params.source,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  tx.set(couponGrantRef(params.grantKey), {
    grantKey: params.grantKey,
    userId: params.userId,
    couponId: ref.id,
    type: params.type,
    source: params.source,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { couponId: ref.id, discountAmount: spec.discountAmount };
}

export type CouponUsability =
  | { usable: true; discount: number; data: FirebaseFirestore.DocumentData }
  | { usable: false; reason: string };

/**
 * 使用しようとしているクーポンを検証する。
 * 金額はフロントから送られた値ではなく、サーバーで組み立てた小計で判定する。
 */
export function judgeCoupon(
  data: FirebaseFirestore.DocumentData | undefined,
  params: { userId: string; subtotal: number; now?: Date }
): CouponUsability {
  if (!data) return { usable: false, reason: "クーポンが見つかりません。" };

  if (data.userId !== params.userId) {
    return { usable: false, reason: "このクーポンは利用できません。" };
  }

  const status = String(data.status || "");
  if (status === "used") {
    return { usable: false, reason: "使用済みのクーポンです。" };
  }
  if (status === "reserved") {
    return {
      usable: false,
      reason: "他のお手続きで使用中です。決済を完了するか、時間をおいてお試しください。",
    };
  }
  if (status === "cancelled") {
    return { usable: false, reason: "無効化されたクーポンです。" };
  }
  if (status !== "available") {
    return { usable: false, reason: "利用できないクーポンです。" };
  }

  const now = params.now ?? new Date();
  const expiresAt = data.expiresAt;
  if (
    expiresAt instanceof admin.firestore.Timestamp &&
    expiresAt.toDate().getTime() <= now.getTime()
  ) {
    return { usable: false, reason: "有効期限が切れています。" };
  }

  const minAmount = typeof data.minAmount === "number" ? data.minAmount : 0;
  if (params.subtotal < minAmount) {
    return {
      usable: false,
      reason: `${minAmount.toLocaleString("ja-JP")}円以上のご予約で利用できます。`,
    };
  }

  const discountAmount =
    typeof data.discountAmount === "number" ? data.discountAmount : 0;
  if (discountAmount <= 0) {
    return { usable: false, reason: "利用できないクーポンです。" };
  }

  // 値引き後が Stripe の最小決済額を下回る組み合わせは受け付けない
  if (params.subtotal - discountAmount < MIN_PAYABLE_AMOUNT) {
    return { usable: false, reason: "この予約金額では利用できません。" };
  }

  return { usable: true, discount: discountAmount, data };
}

/** Checkout 作成時の仮押さえ（トランザクションの書き込みフェーズで呼ぶ） */
export function reserveCouponInTx(
  tx: FirebaseFirestore.Transaction,
  couponRef: FirebaseFirestore.DocumentReference,
  reservationId: string
): void {
  tx.set(
    couponRef,
    {
      status: "reserved" as CouponStatus,
      reservedReservationId: reservationId,
      reservedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/**
 * 決済完了で使用済みにする。reserved 以外（再送イベントなど）は何もしない。
 * 予約IDが一致しない場合も触らない（別予約の仮押さえを壊さないため）。
 */
export async function markCouponUsed(
  couponId: string,
  reservationId: string
): Promise<boolean> {
  if (!couponId) return false;
  const ref = couponsCollection().doc(couponId);

  return admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const d = snap.data() || {};
    if (d.status === "used" && d.usedReservationId === reservationId) {
      return false; // 冪等: 既に確定済み
    }
    if (d.status !== "reserved" || d.reservedReservationId !== reservationId) {
      return false;
    }

    tx.set(
      ref,
      {
        status: "used" as CouponStatus,
        usedReservationId: reservationId,
        usedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  });
}

/**
 * 仮押さえを解放して available に戻す（Checkout 期限切れ・決済失敗・ロールバック時）。
 * 期限を過ぎていたら available ではなく expired にする。
 */
export async function releaseCoupon(
  couponId: string,
  reservationId: string
): Promise<boolean> {
  if (!couponId) return false;
  const ref = couponsCollection().doc(couponId);

  return admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const d = snap.data() || {};
    if (d.status !== "reserved" || d.reservedReservationId !== reservationId) {
      return false;
    }

    const expiresAt = d.expiresAt;
    const isExpired =
      expiresAt instanceof admin.firestore.Timestamp &&
      expiresAt.toMillis() <= Date.now();

    tx.set(
      ref,
      {
        status: (isExpired ? "expired" : "available") as CouponStatus,
        reservedReservationId: null,
        reservedAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  });
}

/**
 * 使用済みクーポンを利用可能に戻す（運営・講師都合のキャンセル時）。
 * 有効期限が切れていても、戻す以上は使えるように期限を延長する。
 */
export async function restoreUsedCoupon(
  couponId: string,
  reservationId: string,
  extendDays = 30
): Promise<boolean> {
  if (!couponId) return false;
  const ref = couponsCollection().doc(couponId);

  return admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const d = snap.data() || {};
    if (d.usedReservationId !== reservationId) return false;
    if (d.status !== "used" && d.status !== "reserved") return false;

    const expiresAt = d.expiresAt;
    const stillValid =
      expiresAt instanceof admin.firestore.Timestamp &&
      expiresAt.toMillis() > Date.now();

    tx.set(
      ref,
      {
        status: "available" as CouponStatus,
        usedReservationId: null,
        usedAt: null,
        reservedReservationId: null,
        reservedAt: null,
        expiresAt: stillValid ? expiresAt : expiresAtFromNow(extendDays),
        restoredFromReservationId: reservationId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  });
}

// ========================================
// レッスン完了の判定
// ========================================

/** JST の YYYY-MM-DD（index.ts の todayJst と同じ考え方。循環参照を避けるため複製） */
export function todayJstDate(offsetDays = 0): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() + offsetDays);
  return jst.toISOString().slice(0, 10);
}

/**
 * 「レッスンが正常に完了した」とみなせるか。
 * 予約に completed という状態は持たせず、支払い確定済み・キャンセルされていない・
 * レッスン日が過ぎている、の3条件から導出する。
 */
export function isLessonCompleted(
  r: FirebaseFirestore.DocumentData,
  today = todayJstDate()
): boolean {
  if (r.paymentStatus !== "paid") return false;
  if (r.reservationStatus !== "confirmed") return false;
  const lessonDate = typeof r.lessonDate === "string" ? r.lessonDate : "";
  if (!lessonDate) return false;
  // レッスン日当日はまだ実施前の可能性があるため、翌日以降に完了とみなす
  return lessonDate < today;
}

// ========================================
// 紹介コード
// ========================================

// 見間違えやすい 0/O/1/I/L は使わない。連番ではなく乱数で発行する。
const REFERRAL_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const REFERRAL_CODE_LENGTH = 6;

export function generateReferralCode(): string {
  let body = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    const idx = Math.floor(Math.random() * REFERRAL_CODE_ALPHABET.length);
    body += REFERRAL_CODE_ALPHABET[idx];
  }
  return `GC-${body}`;
}

/** 入力ゆれ（小文字・全角ハイフン・空白・GC- の省略）を吸収して正規化する */
export function normalizeReferralCode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const compact = raw
    .trim()
    .toUpperCase()
    .replace(/[\s　]/g, "")
    .replace(/[−–—ー―]/g, "-");
  if (!compact) return "";
  const body = compact.startsWith("GC-") ? compact.slice(3) : compact;
  if (!new RegExp(`^[${REFERRAL_CODE_ALPHABET}]{${REFERRAL_CODE_LENGTH}}$`).test(body)) {
    return "";
  }
  return `GC-${body}`;
}

export function referralCodeRef(code: string) {
  return admin.firestore().collection("referralCodes").doc(code);
}

/** 被紹介者1人につき1件。ドキュメント ID を被紹介者の uid にして重複登録を防ぐ */
export function referralRef(refereeUid: string) {
  return admin.firestore().collection("referrals").doc(refereeUid);
}

/**
 * ユーザーの紹介コードを取得する。未発行なら採番して users と referralCodes に保存する。
 * 衝突したら引き直す（referralCodes の作成をトランザクションで排他する）。
 */
export async function ensureReferralCode(uid: string): Promise<string> {
  const userRef = admin.firestore().collection("users").doc(uid);
  const userSnap = await userRef.get();
  const existing = userSnap.exists ? userSnap.data()?.referralCode : null;
  if (typeof existing === "string" && existing) return existing;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateReferralCode();
    const created = await admin.firestore().runTransaction(async (tx) => {
      const codeRef = referralCodeRef(code);
      const [codeSnap, freshUser] = await Promise.all([
        tx.get(codeRef),
        tx.get(userRef),
      ]);

      // 並行呼び出しで先に採番されていたらそれを使う
      const already = freshUser.exists ? freshUser.data()?.referralCode : null;
      if (typeof already === "string" && already) return already;
      if (codeSnap.exists) return null; // 衝突。引き直す

      tx.set(codeRef, {
        code,
        uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(
        userRef,
        {
          referralCode: code,
          referralCodeIssuedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return code;
    });

    if (created) return created;
  }

  throw new Error("紹介コードの採番に失敗しました。");
}

/** 同一人物判定用。ハイフン等を除いた数字だけを比べる */
export function normalizePhone(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[^0-9]/g, "");
}

export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase();
}

// ========================================
// Callable: 自分の紹介コードを取得（未発行なら採番）
// ========================================
export const getMyReferralCode = https.onCall(
  async (_data: unknown, context): Promise<{ ok: boolean; code: string }> => {
    if (!context.auth) {
      throw new https.HttpsError("unauthenticated", "ログインが必要です。");
    }
    const uid = context.auth.uid;

    const userSnap = await admin.firestore().collection("users").doc(uid).get();
    if (!userSnap.exists || String(userSnap.data()?.role || "") !== "student") {
      throw new https.HttpsError(
        "permission-denied",
        "紹介コードは生徒アカウントでご利用いただけます。"
      );
    }

    const code = await ensureReferralCode(uid);
    return { ok: true, code };
  }
);

// ========================================
// Callable: 紹介コードの存在確認（入力中の検証用）
//
// 紹介者が誰かは返さない。存在するかどうかだけを返し、
// コードの総当たりで会員情報を引き当てられないようにする。
// ========================================
export const checkReferralCode = https.onCall(
  async (
    data: { code?: string },
    context
  ): Promise<{ ok: boolean; valid: boolean; message: string }> => {
    const code = normalizeReferralCode(data?.code);
    if (!code) {
      return {
        ok: true,
        valid: false,
        message: "紹介コードの形式が正しくありません（例: GC-8F3K2M）。",
      };
    }

    const snap = await referralCodeRef(code).get();
    if (!snap.exists) {
      return {
        ok: true,
        valid: false,
        message: "この紹介コードは見つかりませんでした。",
      };
    }

    // 自分自身のコードは使えない
    if (context.auth && snap.data()?.uid === context.auth.uid) {
      return {
        ok: true,
        valid: false,
        message: "ご自身の紹介コードは利用できません。",
      };
    }

    return { ok: true, valid: true, message: "有効な紹介コードです。" };
  }
);

// ========================================
// Callable: 紹介コードの適用（会員登録時 or 初回予約前）
//
// 一度登録したら変更できない。既に決済まで進んだ予約があるユーザーは対象外。
// 同一人物が疑われるケースは blocked を立てて特典を止め、運営が手動で
// 解除できる余地を残す（referrals/{uid}.blocked を false にすれば復活する）。
// ========================================
export const applyReferralCode = https.onCall(
  async (
    data: { code?: string },
    context
  ): Promise<{ ok: boolean; message: string }> => {
    if (!context.auth) {
      throw new https.HttpsError("unauthenticated", "ログインが必要です。");
    }
    const uid = context.auth.uid;

    const code = normalizeReferralCode(data?.code);
    if (!code) {
      throw new https.HttpsError(
        "invalid-argument",
        "紹介コードの形式が正しくありません（例: GC-8F3K2M）。"
      );
    }

    const db = admin.firestore();

    const [userSnap, codeSnap] = await Promise.all([
      db.collection("users").doc(uid).get(),
      referralCodeRef(code).get(),
    ]);

    if (!userSnap.exists || String(userSnap.data()?.role || "") !== "student") {
      throw new https.HttpsError(
        "permission-denied",
        "紹介コードは生徒アカウントでご利用いただけます。"
      );
    }
    if (!codeSnap.exists) {
      throw new https.HttpsError(
        "not-found",
        "この紹介コードは見つかりませんでした。"
      );
    }

    const referrerUid = String(codeSnap.data()?.uid || "");
    if (!referrerUid || referrerUid === uid) {
      throw new https.HttpsError(
        "failed-precondition",
        "ご自身の紹介コードは利用できません。"
      );
    }

    const referrerSnap = await db.collection("users").doc(referrerUid).get();
    if (
      !referrerSnap.exists ||
      String(referrerSnap.data()?.role || "") !== "student"
    ) {
      throw new https.HttpsError(
        "failed-precondition",
        "この紹介コードは現在ご利用いただけません。"
      );
    }

    // 「既存ユーザーが後から入力する」ことを防ぐ。決済まで進んだ予約が
    // 1件でもあれば、初回予約前ではないため受け付けない。
    const existingReservations = await db
      .collection("reservations")
      .where("userId", "==", uid)
      .limit(50)
      .get();
    const hasPaidReservation = existingReservations.docs.some((d) => {
      const status = String((d.data() || {}).paymentStatus || "");
      return status === "paid" || status === "authorized";
    });
    if (hasPaidReservation) {
      throw new https.HttpsError(
        "failed-precondition",
        "紹介コードは、初回レッスンのご予約前までにご登録ください。"
      );
    }

    // 同一人物と判断できるケース（同じメール・電話）は特典を止める。
    // 登録自体は通し、運営が個別に判断できるよう理由を残す。
    const me = userSnap.data() || {};
    const referrer = referrerSnap.data() || {};
    const sameEmail =
      !!normalizeEmail(me.email) &&
      normalizeEmail(me.email) === normalizeEmail(referrer.email);
    const samePhone =
      !!normalizePhone(me.phone) &&
      normalizePhone(me.phone) === normalizePhone(referrer.phone);
    const blockedReason = sameEmail
      ? "same_email"
      : samePhone
        ? "same_phone"
        : "";

    await db.runTransaction(async (tx) => {
      const ref = referralRef(uid);
      const snap = await tx.get(ref);
      // 初回登録後は変更できない
      if (snap.exists) {
        throw new https.HttpsError(
          "already-exists",
          "紹介コードはすでに登録済みです。変更はできません。"
        );
      }

      tx.set(ref, {
        campaign: REFERRAL_CAMPAIGN_ID,
        refereeUid: uid,
        referrerUid,
        code,
        status: "pending",
        completedLessonCount: 0,
        refereeCouponId: null,
        referrerCouponId: null,
        firstLessonCompletedAt: null,
        rewardLessonCompletedAt: null,
        // 同一人物が疑われる場合は特典を止める。運営が false にすれば復活する。
        blocked: !!blockedReason,
        blockedReason: blockedReason || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    logger.info("applyReferralCode done", {
      uid,
      referrerUid,
      code,
      blockedReason,
    });

    return {
      ok: true,
      message: blockedReason
        ? "紹介コードを登録しました。特典の付与については運営より別途ご連絡します。"
        : "紹介コードを登録しました。初回レッスンの完了後にクーポンをお届けします。",
    };
  }
);

// ========================================
// 友達紹介: マイルストーン判定
//
// 被紹介者の完了レッスン数が 1 / 3 に達した時点で、それぞれにクーポンを付与する。
// 付与済みかどうかは couponGrants の決定的 ID で判定するため、
// 何度呼んでも二重に付与されない。
// ========================================
export async function processReferralMilestones(
  refereeUid: string
): Promise<void> {
  const db = admin.firestore();
  const refDoc = referralRef(refereeUid);
  const refSnap = await refDoc.get();
  if (!refSnap.exists) return;

  const referral = refSnap.data() || {};
  if (referral.blocked === true) return;

  const referrerUid = String(referral.referrerUid || "");
  if (!referrerUid || referrerUid === refereeUid) return;

  // キャンセル・返金された予約は lessonCompleted が立たないため回数に入らない
  const completedSnap = await db
    .collection("reservations")
    .where("userId", "==", refereeUid)
    .where("lessonCompleted", "==", true)
    .get();
  const completedCount = completedSnap.size;

  const refereeGrantRef = couponGrantRef(grantKeys.referralReferee(refereeUid));
  const referrerGrantRef = couponGrantRef(grantKeys.referralReferrer(refereeUid));

  // 紹介者側の条件: 紹介者自身が過去に1回以上レッスンを完了していること
  let referrerHasCompletedLesson = false;
  if (completedCount >= REFERRER_REWARD_LESSON_COUNT) {
    const referrerCompleted = await db
      .collection("reservations")
      .where("userId", "==", referrerUid)
      .where("lessonCompleted", "==", true)
      .limit(1)
      .get();
    referrerHasCompletedLesson = !referrerCompleted.empty;
  }

  await db.runTransaction(async (tx) => {
    const [freshReferral, refereeGrant, referrerGrant] = await Promise.all([
      tx.get(refDoc),
      tx.get(refereeGrantRef),
      tx.get(referrerGrantRef),
    ]);
    if (!freshReferral.exists) return;
    if ((freshReferral.data() || {}).blocked === true) return;

    const update: Record<string, unknown> = {
      completedLessonCount: completedCount,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // 特典1: 被紹介者の初回レッスン完了で 500円
    if (completedCount >= 1 && !refereeGrant.exists) {
      const issued = issueCouponInTx(tx, {
        userId: refereeUid,
        type: "referral_referee",
        grantKey: grantKeys.referralReferee(refereeUid),
        source: {
          campaign: REFERRAL_CAMPAIGN_ID,
          refereeUid,
          referrerUid,
        },
      });
      update.refereeCouponId = issued.couponId;
      update.firstLessonCompletedAt =
        admin.firestore.FieldValue.serverTimestamp();
      update.status = "first_lesson_done";
    }

    // 特典2: 被紹介者の3回目のレッスン完了で、紹介者に 1,000円
    if (
      completedCount >= REFERRER_REWARD_LESSON_COUNT &&
      referrerHasCompletedLesson &&
      !referrerGrant.exists
    ) {
      const issued = issueCouponInTx(tx, {
        userId: referrerUid,
        type: "referral_referrer",
        grantKey: grantKeys.referralReferrer(refereeUid),
        source: {
          campaign: REFERRAL_CAMPAIGN_ID,
          refereeUid,
          referrerUid,
        },
      });
      update.referrerCouponId = issued.couponId;
      update.rewardLessonCompletedAt =
        admin.firestore.FieldValue.serverTimestamp();
      update.status = "reward_granted";
    }

    tx.set(refDoc, update, { merge: true });
  });
}

// ========================================
// Scheduled: レッスン完了の確定とキャンペーン判定
//
// 予約に completed という状態は増やさず（既存の画面・条件分岐に影響するため）、
// lessonCompleted フラグだけを立てる。紹介特典の回数はこのフラグで数える。
// ========================================
export const finalizeCompletedLessons = pubsub
  .schedule("every day 03:00")
  .timeZone("Asia/Tokyo")
  .onRun(async () => {
    const db = admin.firestore();
    const today = todayJstDate();
    const affectedUserIds = new Set<string>();
    let marked = 0;

    // 等価条件のみで絞る（範囲条件を混ぜると複合インデックスが必要になるため、
    // レッスン日の判定はメモリ上で行う）。
    const snap = await db
      .collection("reservations")
      .where("paymentStatus", "==", "paid")
      .where("reservationStatus", "==", "confirmed")
      .where("lessonCompleted", "==", false)
      .limit(500)
      .get();

    for (const doc of snap.docs) {
      const r = doc.data() || {};
      if (!isLessonCompleted(r, today)) continue;

      try {
        await doc.ref.set(
          {
            lessonCompleted: true,
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        marked += 1;
        if (typeof r.userId === "string" && r.userId) {
          affectedUserIds.add(r.userId);
        }
      } catch (error) {
        logger.error("finalizeCompletedLessons: 完了フラグの更新に失敗", {
          reservationId: doc.id,
          error,
        });
      }
    }

    // 完了数が変わったユーザーについてのみ紹介特典を判定する
    for (const uid of affectedUserIds) {
      try {
        await processReferralMilestones(uid);
      } catch (error) {
        logger.error("finalizeCompletedLessons: 紹介特典の判定に失敗", {
          uid,
          error,
        });
      }
    }

    logger.info("finalizeCompletedLessons done", {
      marked,
      users: affectedUserIds.size,
    });
  });

// ========================================
// Scheduled: 期限切れクーポンの整理
//
// 期限判定は利用時にも行っているため、これは一覧表示を正しく保つための後片付け。
// 仮押さえ中（reserved）のものは決済処理の途中なので触らない。
// ========================================
export const expireCoupons = pubsub
  .schedule("every day 04:00")
  .timeZone("Asia/Tokyo")
  .onRun(async () => {
    const now = Date.now();
    let expired = 0;

    // 等価条件のみで取得し、期限の比較はメモリ上で行う（複合インデックス不要）
    const snap = await admin
      .firestore()
      .collection("coupons")
      .where("status", "==", "available")
      .limit(500)
      .get();

    for (const doc of snap.docs) {
      const expiresAt = (doc.data() || {}).expiresAt;
      if (
        !(expiresAt instanceof admin.firestore.Timestamp) ||
        expiresAt.toMillis() > now
      ) {
        continue;
      }
      try {
        await doc.ref.set(
          {
            status: "expired" as CouponStatus,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        expired += 1;
      } catch (error) {
        logger.error("expireCoupons: 更新に失敗", { couponId: doc.id, error });
      }
    }

    logger.info("expireCoupons done", { expired });
  });

// ========================================
// Callable: レビュー投稿（レビュー投稿キャンペーン）
//
// レビューの作成をサーバー経由にしているのは、クーポン付与の条件
// （本人・支払い済み・完了済み・重複なし）をクライアントに委ねられないため。
// firestore.rules 側でも reviews の直接作成は禁止している。
// ========================================
export const submitReview = https.onCall(
  async (
    data: {
      reservationId?: string;
      rating?: number;
      comment?: string;
    },
    context
  ): Promise<{
    ok: boolean;
    reviewId: string;
    couponIssued: boolean;
    couponId: string | null;
    /** クーポンが出なかった理由（画面表示用。レビュー自体は成功している） */
    couponMessage: string;
  }> => {
    if (!context.auth) {
      throw new https.HttpsError("unauthenticated", "ログインが必要です。");
    }
    const uid = context.auth.uid;

    const reservationId =
      typeof data?.reservationId === "string" ? data.reservationId.trim() : "";
    const rating = Number(data?.rating);
    const comment = typeof data?.comment === "string" ? data.comment.trim() : "";

    if (!reservationId) {
      throw new https.HttpsError(
        "invalid-argument",
        "レビュー対象の予約が指定されていません。"
      );
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new https.HttpsError("invalid-argument", "評価は1〜5で選択してください。");
    }
    if (!comment) {
      throw new https.HttpsError("invalid-argument", "コメントを入力してください。");
    }
    if (comment.length > 2000) {
      throw new https.HttpsError(
        "invalid-argument",
        "コメントは2000文字以内で入力してください。"
      );
    }

    // 管理者・講師アカウントからの投稿はキャンペーン対象外（クーポンも出さない）。
    const userSnap = await admin.firestore().collection("users").doc(uid).get();
    const role = userSnap.exists ? String(userSnap.data()?.role || "") : "";
    const isStudent = role === "student";

    const reservationRef = admin
      .firestore()
      .collection("reservations")
      .doc(reservationId);

    const reviewRef = admin.firestore().collection("reviews").doc();
    const resGrantRef = couponGrantRef(grantKeys.reviewReservation(reservationId));
    const userGrantRef = couponGrantRef(grantKeys.reviewUser(uid));

    const result = await admin.firestore().runTransaction(async (tx) => {
      // --- 読み取りフェーズ ---
      const [resSnap, resGrantSnap, userGrantSnap] = await Promise.all([
        tx.get(reservationRef),
        tx.get(resGrantRef),
        tx.get(userGrantRef),
      ]);

      if (!resSnap.exists) {
        throw new https.HttpsError("not-found", "予約が見つかりませんでした。");
      }
      const r = resSnap.data() || {};

      // 1つの予約につきレビューは1件。ただし本人が削除した場合は投稿し直せる
      // （クーポンの再付与は couponGrants の台帳が防ぐため、書き直しは許してよい）。
      if (typeof r.reviewId === "string" && r.reviewId) {
        const prevReview = await tx.get(
          admin.firestore().collection("reviews").doc(r.reviewId)
        );
        if (prevReview.exists) {
          throw new https.HttpsError(
            "already-exists",
            "この予約にはすでにレビューを投稿済みです。編集は講師ページのレビュー一覧から行えます。"
          );
        }
      }

      if (r.userId !== uid) {
        throw new https.HttpsError(
          "permission-denied",
          "ご自身が予約されたレッスンにのみレビューを投稿できます。"
        );
      }
      if (!isLessonCompleted(r)) {
        throw new https.HttpsError(
          "failed-precondition",
          "レビューを投稿できるのは、お支払いが完了し受講を終えたレッスンのみです。"
        );
      }

      // --- クーポン付与の可否を判定 ---
      let couponIssued = false;
      let couponId: string | null = null;
      let couponMessage = "";

      if (!isStudent) {
        couponMessage = "運営・講師アカウントはキャンペーンの対象外です。";
      } else if (resGrantSnap.exists) {
        // レビューを削除して再投稿しても、この台帳が残っているため再付与されない
        couponMessage = "この予約では、すでにクーポンを受け取り済みです。";
      } else if (userGrantSnap.exists) {
        couponMessage =
          "レビュー投稿キャンペーンはお一人様1回までのため、今回はクーポンの付与はありません。";
      } else {
        const issued = issueCouponInTx(tx, {
          userId: uid,
          type: "review",
          grantKey: grantKeys.reviewUser(uid),
          source: {
            campaign: REVIEW_CAMPAIGN_ID,
            reviewId: reviewRef.id,
            reservationId,
          },
        });
        couponId = issued.couponId;
        couponIssued = true;
        couponMessage = `${issued.discountAmount.toLocaleString(
          "ja-JP"
        )}円クーポンを付与しました。`;

        // 予約単位の台帳。issueCouponInTx はユーザー単位の台帳しか作らないため別途書く。
        tx.set(resGrantRef, {
          grantKey: grantKeys.reviewReservation(reservationId),
          userId: uid,
          couponId: issued.couponId,
          type: "review",
          source: { campaign: REVIEW_CAMPAIGN_ID, reservationId },
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // --- レビュー本体 ---
      tx.set(reviewRef, {
        // teacherId には講師の表示名が入る（既存データとの互換のため変更しない）
        teacherId: typeof r.teacherName === "string" ? r.teacherName : "",
        teacherAuthUid: typeof r.teacherId === "string" ? r.teacherId : "",
        userId: uid,
        reservationId,
        rating,
        comment,
        // キャンペーン対象として投稿されたレビューにだけ注記を出す。
        // 通常投稿・過去のレビューには付かない。
        campaign: couponIssued ? REVIEW_CAMPAIGN_ID : null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 予約から逆引きできるようにしておく（二重投稿の判定に使う）
      tx.set(
        reservationRef,
        {
          reviewId: reviewRef.id,
          reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return { couponIssued, couponId, couponMessage };
    });

    logger.info("submitReview done", {
      uid,
      reservationId,
      reviewId: reviewRef.id,
      couponIssued: result.couponIssued,
    });

    return {
      ok: true,
      reviewId: reviewRef.id,
      couponIssued: result.couponIssued,
      couponId: result.couponId,
      couponMessage: result.couponMessage,
    };
  }
);
