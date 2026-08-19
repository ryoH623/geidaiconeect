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
    data: { name?: string; email?: string; teacherId?: string },
    context
  ): Promise<{ ok: boolean; token: string; url: string; expiresAt: string }> => {
    await assertAdmin(context.auth?.uid);

    const name = typeof data?.name === "string" ? data.name.trim().slice(0, 100) : "";
    const email =
      typeof data?.email === "string" ? data.email.trim().toLowerCase().slice(0, 200) : "";
    const teacherId = normalizeSlug(data?.teacherId);

    if (!name) {
      throw new https.HttpsError("invalid-argument", "講師名を入力してください。");
    }
    if (!teacherId) {
      throw new https.HttpsError(
        "invalid-argument",
        "講師ページのURL（英数字）を入力してください。"
      );
    }

    const db = admin.firestore();

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

    await db.collection(INVITES).doc(token).set({
      token,
      name,
      email: email || null,
      teacherId,
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
  ): Promise<{ ok: boolean; valid: boolean; name: string; message: string }> => {
    const token = typeof data?.token === "string" ? data.token.trim() : "";
    if (!token) {
      return { ok: true, valid: false, name: "", message: "招待コードが指定されていません。" };
    }

    const snap = await admin.firestore().collection(INVITES).doc(token).get();
    if (!snap.exists) {
      return {
        ok: true,
        valid: false,
        name: "",
        message: "この招待URLは見つかりませんでした。運営にお問い合わせください。",
      };
    }

    const invite = snap.data() || {};
    if (invite.used === true) {
      return {
        ok: true,
        valid: false,
        name: "",
        message: "この招待URLは既に使用されています。",
      };
    }

    const expiresAt = invite.expiresAt;
    if (expiresAt instanceof admin.firestore.Timestamp && expiresAt.toMillis() < Date.now()) {
      return {
        ok: true,
        valid: false,
        name: "",
        message: "この招待URLは有効期限が切れています。運営にお問い合わせください。",
      };
    }

    return {
      ok: true,
      valid: true,
      name: String(invite.name || ""),
      message: "",
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
        tx.set(profileRef, {
          authUid: uid,
          name: displayName,
          furigana: "",
          prefecture: String(user.prefecture || ""),
          city: "",
          genres: [],
          tags: [],
          profile: "",
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
