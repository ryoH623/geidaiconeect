// 検索ログ。
//
// 目的は「どの条件で検索されて、結果が0件だったか」を貯めること。
// 0件の検索は取りこぼした需要そのもので、講師をどの分野・地域から増やすべきかの
// 判断材料になる。0件だけでなく全件を記録するのは、分母（総検索数）がないと
// 「0件が多い」と言えないため。
//
// 書き込みはこの callable 経由のみ。クライアントから直接書けるようにすると
// 件数をいくらでも水増しできてしまうため、firestore.rules では write を禁じている。
import * as admin from "firebase-admin";
import { https, pubsub } from "firebase-functions/v1";
import { logger } from "firebase-functions";

/** 保存するキーワードの最大長。これ以上は切り捨てる */
const MAX_KEYWORD_LENGTH = 100;

/** ログの保持期間。これを過ぎたものは日次ジョブで削除する */
const RETENTION_DAYS = 180;

/** 1回の削除ジョブで消す上限（タイムアウト回避） */
const PURGE_BATCH_LIMIT = 400;

/**
 * 検索キーワードの正規化。
 *
 * 集計時に「ピアノ」「ピアノ 」「ＰＩＡＮＯ」がばらけないよう、
 * 前後の空白を落とし、全角英数を半角にして小文字へ寄せたものを
 * keywordNormalized として別に持つ。表示用の原文は keyword に残す。
 */
export function normalizeSearchKeyword(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0)
    )
    .replace(/\s+/g, " ")
    .toLowerCase()
    .slice(0, MAX_KEYWORD_LENGTH);
}

/** 表示用。原文のまま（長さだけ制限する） */
export function trimSearchKeyword(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, MAX_KEYWORD_LENGTH);
}

// ========================================
// Callable: 検索の記録
//
// 未ログインでも検索はできるので auth は必須にしない。
// 記録に失敗してもクライアント側の検索体験は壊さない（呼び出し側で握りつぶす）。
// ========================================
export const logSearch = https.onCall(
  async (
    data: { keyword?: string; category?: string; resultCount?: number },
    context
  ): Promise<{ ok: boolean }> => {
    const keyword = trimSearchKeyword(data?.keyword);
    const keywordNormalized = normalizeSearchKeyword(data?.keyword);
    const category =
      typeof data?.category === "string" ? data.category.trim().slice(0, 50) : "";

    // 条件なしの検索（全件表示）は需要の手がかりにならないので記録しない
    if (!keyword && !category) {
      return { ok: true };
    }

    const rawCount = data?.resultCount;
    const resultCount =
      typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount >= 0
        ? Math.floor(rawCount)
        : 0;

    try {
      await admin
        .firestore()
        .collection("searchLogs")
        .add({
          keyword,
          keywordNormalized,
          category,
          resultCount,
          hit: resultCount > 0,
          // 誰が検索したかは必須ではないが、同一人物の連打を後から除きたい場合に使う
          uid: context.auth?.uid || null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (error) {
      // 記録できなくても検索自体は成立している。エラーを投げ返さない。
      logger.error("logSearch: 保存に失敗", { error });
    }

    return { ok: true };
  }
);

// ========================================
// Scheduled: 古い検索ログの削除
//
// 検索のたびに1件増えるコレクションなので、放っておくと際限なく育つ。
// 集計に使うのは直近の傾向なので、保持期間を過ぎたものは消す。
// ========================================
export const purgeOldSearchLogs = pubsub
  .schedule(`every day 05:00`)
  .timeZone("Asia/Tokyo")
  .onRun(async () => {
    const threshold = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    );

    const snap = await admin
      .firestore()
      .collection("searchLogs")
      .where("createdAt", "<", threshold)
      .limit(PURGE_BATCH_LIMIT)
      .get();

    if (snap.empty) return null;

    const batch = admin.firestore().batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    logger.info("purgeOldSearchLogs done", { deleted: snap.size });
    return null;
  });
