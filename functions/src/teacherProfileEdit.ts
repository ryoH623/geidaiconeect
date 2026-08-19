// 講師本人によるプロフィール・コースの編集。
//
// 書き込みをクライアントから直接させない理由は2つある。
//   1. published を自分で true にできてしまうと、運営の確認を通さずに公開できる
//   2. 料金の下限のような検証は firestore.rules では配列の中身まで見きれない
// そのため保存はこの callable のみで行い、rules では講師の直接書き込みを禁じている。
import * as admin from "firebase-admin";
import { https } from "firebase-functions/v1";
import { logger } from "firebase-functions";

const TEACHER_PROFILES = "teacherProfiles";

/**
 * レッスン料の下限。
 *
 * 手数料が逓減制（18%→15%→10%）のため、極端に安い設定をされると
 * 手数料が運営コストを下回る。金額は自由入力だが、ここだけは守らせる。
 * フロント側の MIN_LESSON_PRICE と揃えること。
 */
const MIN_LESSON_PRICE = 3000;

/** 現実的な上限。桁の打ち間違い（60,000円のつもりで600,000円）を止める */
const MAX_LESSON_PRICE = 100000;

/** 1人が登録できるコース数の上限 */
const MAX_COURSES = 20;

const LESSON_TYPES = ["自宅", "スタジオ", "出張", "オンライン"];

function str(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

function strArray(v: unknown, max: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, max)
    .map((x) => x.slice(0, maxLen));
}

type CourseInput = {
  type?: string;
  title?: string;
  price?: number;
  note?: string;
  locationDisplay?: string;
  isTrial?: boolean;
};

/** コース1件を検証して整える。問題があれば HttpsError を投げる */
function sanitizeCourse(raw: CourseInput, index: number) {
  const label = `${index + 1}件目のコース`;

  const type = str(raw?.type, 20);
  if (!LESSON_TYPES.includes(type)) {
    throw new https.HttpsError(
      "invalid-argument",
      `${label}: レッスン形態を選択してください。`
    );
  }

  const title = str(raw?.title, 100);
  if (!title) {
    throw new https.HttpsError("invalid-argument", `${label}: コース名を入力してください。`);
  }

  const price = typeof raw?.price === "number" ? Math.floor(raw.price) : NaN;
  if (!Number.isFinite(price)) {
    throw new https.HttpsError("invalid-argument", `${label}: 料金を入力してください。`);
  }
  if (price < MIN_LESSON_PRICE) {
    throw new https.HttpsError(
      "invalid-argument",
      `${label}: 料金は${MIN_LESSON_PRICE.toLocaleString()}円以上で設定してください。`
    );
  }
  if (price > MAX_LESSON_PRICE) {
    throw new https.HttpsError(
      "invalid-argument",
      `${label}: 料金が高すぎます。桁をご確認ください（上限${MAX_LESSON_PRICE.toLocaleString()}円）。`
    );
  }

  const course: Record<string, unknown> = { type, title, price };

  const note = str(raw?.note, 300);
  if (note) course.note = note;

  // オンラインは会場がないので所在地を持たせない
  const locationDisplay = type === "オンライン" ? "" : str(raw?.locationDisplay, 200);
  if (locationDisplay) course.locationDisplay = locationDisplay;

  if (raw?.isTrial === true) course.isTrial = true;

  return course;
}

// ========================================
// Callable: 自分の講師プロフィールを保存する
//
// submit が true なら「公開申請」として status を pending にする。
// published はここでは一切触らない（公開の判断は運営だけが行う）。
// ========================================
export const saveMyTeacherProfile = https.onCall(
  async (
    data: {
      name?: string;
      furigana?: string;
      prefecture?: string;
      city?: string;
      genres?: string[];
      tags?: string[];
      profile?: string;
      photo?: string;
      courses?: CourseInput[];
      onlineAvailable?: boolean;
      onlineLessonPrice?: number;
      submit?: boolean;
    },
    context
  ): Promise<{ ok: boolean; teacherId: string; status: string }> => {
    const uid = context.auth?.uid;
    if (!uid) {
      throw new https.HttpsError("unauthenticated", "ログインが必要です。");
    }

    const db = admin.firestore();

    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists || String(userSnap.data()?.role || "") !== "teacher") {
      throw new https.HttpsError("permission-denied", "講師アカウントのみ編集できます。");
    }

    // 自分のプロフィールを authUid から引く。teacherId をクライアントから
    // 受け取ると、他人のプロフィールを指定される余地が生まれる。
    const found = await db
      .collection(TEACHER_PROFILES)
      .where("authUid", "==", uid)
      .limit(1)
      .get();
    if (found.empty) {
      throw new https.HttpsError(
        "not-found",
        "講師プロフィールが見つかりません。運営にお問い合わせください。"
      );
    }
    const profileRef = found.docs[0].ref;

    const name = str(data?.name, 100);
    if (!name) {
      throw new https.HttpsError("invalid-argument", "お名前を入力してください。");
    }

    const rawCourses = Array.isArray(data?.courses) ? data.courses : [];
    if (rawCourses.length > MAX_COURSES) {
      throw new https.HttpsError(
        "invalid-argument",
        `コースは${MAX_COURSES}件までです。`
      );
    }
    const courses = rawCourses.map((c, i) => sanitizeCourse(c, i));

    const submit = data?.submit === true;
    if (submit && courses.length === 0) {
      throw new https.HttpsError(
        "failed-precondition",
        "公開申請にはコースが1件以上必要です。"
      );
    }

    const onlineAvailable = data?.onlineAvailable === true;
    const rawOnlinePrice =
      typeof data?.onlineLessonPrice === "number"
        ? Math.floor(data.onlineLessonPrice)
        : NaN;
    if (onlineAvailable && Number.isFinite(rawOnlinePrice)) {
      if (rawOnlinePrice < MIN_LESSON_PRICE || rawOnlinePrice > MAX_LESSON_PRICE) {
        throw new https.HttpsError(
          "invalid-argument",
          `オンラインレッスンの料金は${MIN_LESSON_PRICE.toLocaleString()}円以上${MAX_LESSON_PRICE.toLocaleString()}円以下で設定してください。`
        );
      }
    }

    const update: Record<string, unknown> = {
      name,
      furigana: str(data?.furigana, 100),
      prefecture: str(data?.prefecture, 20),
      city: str(data?.city, 50),
      genres: strArray(data?.genres, 10, 30),
      tags: strArray(data?.tags, 10, 30),
      profile: str(data?.profile, 2000),
      courses,
      onlineAvailable,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (onlineAvailable && Number.isFinite(rawOnlinePrice)) {
      update.onlineLessonPrice = rawOnlinePrice;
    } else {
      update.onlineLessonPrice = admin.firestore.FieldValue.delete();
    }

    // 公開申請。published は触らない。公開中の講師が編集した場合も
    // 公開を止めない（毎回サイトから消えると講師が編集しづらいため）。
    if (submit) update.status = "pending";

    await profileRef.update(update);

    logger.info("saveMyTeacherProfile done", {
      uid,
      teacherId: profileRef.id,
      courses: courses.length,
      submit,
    });

    const after = await profileRef.get();
    return {
      ok: true,
      teacherId: profileRef.id,
      status: String(after.data()?.status || "draft"),
    };
  }
);
