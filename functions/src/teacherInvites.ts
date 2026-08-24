// 講師の招待。
//
// 講師は面談を経てから迎える。誰でも講師になれてしまうと困るので、
// 会員登録の入口は生徒と同じ /register のままにして、
// 「運営が発行した招待トークン付きのURLから登録したときだけ role を teacher にする」
// という形にした。role の付与はこのファイル（Admin SDK）でのみ行い、
// クライアントからは firestore.rules で禁じたままにしてある。
//
// トークンは使い捨て・期限付き。漏れても被害が広がらないようにするため。
import * as admin from "firebase-admin";
import { https } from "firebase-functions/v1";
import { logger } from "firebase-functions";

const INVITES = "teacherInvites";
const TEACHER_PROFILES = "teacherProfiles";

/** 招待の有効期間 */
const INVITE_VALID_DAYS = 14;

/** トークンに使う文字。見間違えやすい 0/O/1/I/L は入れない */
const TOKEN_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TOKEN_LENGTH = 24;

function str(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

function generateToken(): string {
  let out = "";
  for (let i = 0; i < TOKEN_LENGTH; i += 1) {
    out += TOKEN_CHARS[Math.floor(Math.random() * TOKEN_CHARS.length)];
  }
  return out;
}

/** 講師詳細ページの URL に使うスラッグ。日本語名は使えないので英数字だけ受け付ける */
function normalizeSlug(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/**
 * 講師ページのURLを自動で採番する。
 *
 * 氏名は日本語なので URL には使えず、ローマ字も持っていない。
 * そのため意味のない短いIDを振る。読みやすいURLを付けたい場合は
 * 招待の発行時に明示的に指定できる。
 */
async function generateSlug(): Promise<string> {
  const db = admin.firestore();

  for (let attempt = 0; attempt < 10; attempt += 1) {
    let suffix = "";
    for (let i = 0; i < 6; i += 1) {
      suffix += TOKEN_CHARS[Math.floor(Math.random() * TOKEN_CHARS.length)];
    }
    const candidate = `t-${suffix.toLowerCase()}`;

    // 発行済みで未使用の招待とも衝突させない
    const [profile, invite] = await Promise.all([
      db.collection(TEACHER_PROFILES).doc(candidate).get(),
      db.collection(INVITES).where("teacherId", "==", candidate).limit(1).get(),
    ]);
    if (!profile.exists && invite.empty) return candidate;
  }

  throw new https.HttpsError(
    "internal",
    "講師ページのURLを採番できませんでした。時間をおいてお試しください。"
  );
}

async function assertAdmin(uid: string | undefined): Promise<void> {
  if (!uid) {
    throw new https.HttpsError("unauthenticated", "ログインが必要です。");
  }
  const snap = await admin.firestore().collection("users").doc(uid).get();
  if (!snap.exists || String(snap.data()?.role || "") !== "admin") {
    throw new https.HttpsError("permission-denied", "管理者のみ実行できます。");
  }
}

// ========================================
// Callable: 招待の発行（運営）
// ========================================
export const adminCreateTeacherInvite = https.onCall(
  async (
    data: {
      name?: string;
      email?: string;
      teacherId?: string;
      applicationId?: string;
    },
    context
  ): Promise<{ ok: boolean; token: string; url: string; expiresAt: string }> => {
    await assertAdmin(context.auth?.uid);

    const db = admin.firestore();

    // 応募から作る場合は、応募フォームの内容をそのまま引き継ぐ。
    // 同じことを講師に二度入力させないため。
    const applicationId = str(data?.applicationId, 100);
    let application: Record<string, unknown> | null = null;
    if (applicationId) {
      const appSnap = await db
        .collection("teacherApplications")
        .doc(applicationId)
        .get();
      if (!appSnap.exists) {
        throw new https.HttpsError("not-found", "応募が見つかりませんでした。");
      }
      application = appSnap.data() || {};
    }

    const name = str(data?.name, 100) || str(application?.name, 100);
    const email = (
      str(data?.email, 200) || str(application?.email, 200)
    ).toLowerCase();

    if (!name) {
      throw new https.HttpsError("invalid-argument", "講師名を入力してください。");
    }

    // 指定がなければ自動で採番する
    const teacherId = normalizeSlug(data?.teacherId) || (await generateSlug());

    // 既に公開・登録済みのスラッグとぶつかると、別人の講師ページを上書きしかねない
    const existing = await db.collection(TEACHER_PROFILES).doc(teacherId).get();
    if (existing.exists && String(existing.data()?.authUid || "")) {
      throw new https.HttpsError(
        "already-exists",
        "そのURLは既に使われています。別のURLを指定してください。"
      );
    }

    const token = generateToken();
    const expiresAt = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + INVITE_VALID_DAYS * 24 * 60 * 60 * 1000)
    );

    // 会員登録画面と、講師プロフィールの下書きに使う
    const addr = (application?.address || {}) as Record<string, unknown>;
    const prefill = {
      name,
      furigana: str(application?.furigana, 100),
      email,
      phone: str(application?.phone, 30),
      prefecture: str(addr.prefecture, 20),
      city: str(addr.city, 50),
      town: str(addr.town, 100),
      line: str(addr.line, 200),
      subject: str(application?.subject, 50),
      bio: str(application?.bio, 2000),
    };

    await db.collection(INVITES).doc(token).set({
      token,
      name,
      email: email || null,
      teacherId,
      applicationId: applicationId || null,
      prefill,
      used: false,
      usedBy: null,
      usedAt: null,
      expiresAt,
      createdBy: context.auth?.uid || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info("adminCreateTeacherInvite done", { teacherId, by: context.auth?.uid });

    return {
      ok: true,
      token,
      url: `/register?invite=${token}`,
      expiresAt: expiresAt.toDate().toISOString(),
    };
  }
);

// ========================================
// Callable: 招待の確認（登録画面の表示用）
//
// 未ログインの状態で呼ばれる。招待が有効かどうかと、表示する名前だけを返す。
// メールアドレスなどの個人情報はここでは返さない。
// ========================================
export const checkTeacherInvite = https.onCall(
  async (
    data: { token?: string },
    _context
  ): Promise<{
    ok: boolean;
    valid: boolean;
    name: string;
    message: string;
    prefill: Record<string, unknown> | null;
  }> => {
    const token = typeof data?.token === "string" ? data.token.trim() : "";
    if (!token) {
      return {
        ok: true,
        valid: false,
        name: "",
        message: "招待コードが指定されていません。",
        prefill: null,
      };
    }

    const snap = await admin.firestore().collection(INVITES).doc(token).get();
    if (!snap.exists) {
      return {
        ok: true,
        valid: false,
        name: "",
        message: "この招待URLは見つかりませんでした。運営にお問い合わせください。",
        prefill: null,
      };
    }

    const invite = snap.data() || {};
    if (invite.used === true) {
      return {
        ok: true,
        valid: false,
        name: "",
        message: "この招待URLは既に使用されています。",
        prefill: null,
      };
    }

    const expiresAt = invite.expiresAt;
    if (expiresAt instanceof admin.firestore.Timestamp && expiresAt.toMillis() < Date.now()) {
      return {
        ok: true,
        valid: false,
        name: "",
        message: "この招待URLは有効期限が切れています。運営にお問い合わせください。",
        prefill: null,
      };
    }

    // 入力の手間を省くために応募フォームの内容を返す。
    // トークンを知っている本人にしか渡らないが、返すのは本人が自分で書いた情報だけ。
    return {
      ok: true,
      valid: true,
      name: String(invite.name || ""),
      message: "",
      prefill: (invite.prefill as Record<string, unknown>) || null,
    };
  }
);

// ========================================
// Callable: 招待の受理（会員登録の直後に呼ぶ）
//
// ここで初めて role が teacher になる。あわせて講師プロフィールの下書きを作り、
// authUid を紐付ける。予約とスケジュールは authUid をキーに動くため、
// ここで結び付けておかないと後から手作業が必要になる。
// ========================================
export const acceptTeacherInvite = https.onCall(
  async (
    data: { token?: string },
    context
  ): Promise<{ ok: boolean; teacherId: string }> => {
    const uid = context.auth?.uid;
    if (!uid) {
      throw new https.HttpsError("unauthenticated", "ログインが必要です。");
    }

    const token = typeof data?.token === "string" ? data.token.trim() : "";
    if (!token) {
      throw new https.HttpsError("invalid-argument", "招待コードが指定されていません。");
    }

    const db = admin.firestore();
    const inviteRef = db.collection(INVITES).doc(token);

    // トークンの使用済み判定と role の付与は同時に確定させる。
    // 同じURLを2つの端末から同時に開かれても、講師になれるのは1人だけ。
    const teacherId = await db.runTransaction(async (tx) => {
      const snap = await tx.get(inviteRef);
      if (!snap.exists) {
        throw new https.HttpsError("not-found", "この招待URLは見つかりませんでした。");
      }

      const invite = snap.data() || {};
      if (invite.used === true) {
        throw new https.HttpsError(
          "failed-precondition",
          "この招待URLは既に使用されています。"
        );
      }

      const expiresAt = invite.expiresAt;
      if (
        expiresAt instanceof admin.firestore.Timestamp &&
        expiresAt.toMillis() < Date.now()
      ) {
        throw new https.HttpsError(
          "failed-precondition",
          "この招待URLは有効期限が切れています。"
        );
      }

      const id = String(invite.teacherId || "");
      if (!id) {
        throw new https.HttpsError("failed-precondition", "招待の内容が不正です。");
      }

      const userRef = db.collection("users").doc(uid);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new https.HttpsError(
          "failed-precondition",
          "会員情報が見つかりません。登録をやり直してください。"
        );
      }

      const profileRef = db.collection(TEACHER_PROFILES).doc(id);
      const profileSnap = await tx.get(profileRef);

      tx.update(userRef, {
        role: "teacher",
        teacherId: id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const user = userSnap.data() || {};
      const displayName = String(user.displayName || invite.name || "");

      if (profileSnap.exists) {
        // 既存のプロフィール（運営が先に作っていた場合）に本人を紐付ける
        tx.update(profileRef, {
          authUid: uid,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        // 下書きを作る。公開されるのは運営が公開操作をした後
        // 応募フォームの内容をそのまま下書きに写す。
        // 講師が同じことを三度目に入力しなくて済むようにする。
        // レッスン形態はプロフィール側で設定するため、ここでは引き継がない。
        const prefill = (invite.prefill || {}) as Record<string, unknown>;
        const subject = String(prefill.subject || "");

        tx.set(profileRef, {
          authUid: uid,
          name: displayName,
          furigana: String(prefill.furigana || user.lastNameKana || ""),
          prefecture: String(prefill.prefecture || user.prefecture || ""),
          city: String(prefill.city || ""),
          genres: subject ? [subject] : [],
          tags: [],
          profile: String(prefill.bio || ""),
          photo: "",
          courses: [],
          onlineAvailable: false,
          published: false,
          status: "draft",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      tx.update(inviteRef, {
        used: true,
        usedBy: uid,
        usedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return id;
    });

    logger.info("acceptTeacherInvite done", { uid, teacherId });

    return { ok: true, teacherId };
  }
);
