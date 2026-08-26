// src/components/ReviewList.tsx
import { useEffect, useState } from "react";
import { deleteDoc } from "firebase/firestore";
import { db, auth } from "../firebase";
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  updateDoc,
} from "firebase/firestore";

interface Props {
  /** 講師の表示名。reviews の teacherId は表示名で保存されている */
  teacherId: string;
  /** 講師の Firebase Auth uid。返信できるのはこの uid の本人だけ */
  teacherAuthUid?: string;
}

type Review = {
  id: string;
  userId?: string;
  /** 担当講師の uid。これを持たない古いレビューには返信できない */
  teacherAuthUid?: string;
  rating: number;
  comment: string;
  // 旧データは timestamp フィールドに保存されているため両方を許容する
  createdAt?: { seconds: number };
  timestamp?: { seconds: number };
  reply?: string;
  /** 投稿キャンペーンの対象として投稿されたレビューにのみ入る。
   *  通常投稿・キャンペーン開始前のレビューには存在しない。 */
  campaign?: string | null;
};

// createdAt（新）/ timestamp（旧）のどちらかから投稿時刻を取り出す
function reviewSeconds(r: Review): number {
  return r.createdAt?.seconds ?? r.timestamp?.seconds ?? 0;
}

export default function ReviewList({ teacherId, teacherAuthUid }: Props) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editComment, setEditComment] = useState("");
  const [editRating, setEditRating] = useState<number>(0);
  const [replyText, setReplyText] = useState("");
  const [replyingId, setReplyingId] = useState<string | null>(null);

  useEffect(() => {
    const fetchReviews = async () => {
      try {
        // orderBy("createdAt") を付けると createdAt を持たない旧データ
        // （timestamp フィールドのみ）が結果から除外されるため、
        // 取得後にクライアント側でソートする
        const q = query(
          collection(db, "reviews"),
          where("teacherId", "==", teacherId)
        );
        const querySnapshot = await getDocs(q);
        const reviewData = querySnapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as Review[];
        reviewData.sort((a, b) => reviewSeconds(b) - reviewSeconds(a));
        setReviews(reviewData);
      } catch (error) {
        console.error("レビューの取得に失敗しました", error);
      } finally {
        setLoading(false);
      }
    };

    fetchReviews();
  }, [teacherId]);

  // 返信ボタンを出す条件: ログイン中のユーザーがこのレビューの担当講師本人であること。
  // teacherAuthUid を持たない古いレビューはルール側でも更新できないため対象外。
  const canReply = (review: Review): boolean => {
    const uid = auth.currentUser?.uid;
    if (!uid || !teacherAuthUid) return false;
    return uid === teacherAuthUid && review.teacherAuthUid === teacherAuthUid;
  };

  const startEdit = (review: Review) => {
    setEditingId(review.id);
    setEditComment(review.comment);
    setEditRating(review.rating);
  };

  const saveEdit = async (id: string) => {
    try {
      const reviewRef = doc(db, "reviews", id);
      await updateDoc(reviewRef, {
        comment: editComment,
        rating: editRating,
      });
      setReviews((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, comment: editComment, rating: editRating } : r
        )
      );
      setEditingId(null);
    } catch (err) {
      alert("更新に失敗しました");
    }
  };

  const deleteReview = async (id: string) => {
    if (!window.confirm("このレビューを削除してもよろしいですか？")) return;

    try {
      await deleteDoc(doc(db, "reviews", id));
      setReviews((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      alert("削除に失敗しました。もう一度お試しください。");
    }
  };

  const handleReplySubmit = async (id: string) => {
    try {
      const reviewRef = doc(db, "reviews", id);
      await updateDoc(reviewRef, {
        reply: replyText,
      });
      setReviews((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, reply: replyText } : r
        )
      );
      setReplyingId(null);
      setReplyText("");
    } catch (err) {
      console.error("返信の送信に失敗しました:", err);
      alert("返信の送信に失敗しました。");
    }
  };

  if (loading) return <p>読み込み中...</p>;

  return (
    <div className="review-list">
      <h4>レビュー一覧</h4>
      {reviews.length === 0 ? (
        <p className="review-empty-note">
          レビューを募集しています。受講された方は、ぜひ最初のレビューをお寄せください。
        </p>
      ) : (
        <ul>
          {reviews.map((r) => (
            <li key={r.id}>
              {editingId === r.id ? (
                <>
                  <select
                    value={editRating}
                    onChange={(e) => setEditRating(Number(e.target.value))}
                  >
                    {[1, 2, 3, 4, 5].map((num) => (
                      <option key={num} value={num}>
                        ★ {num}
                      </option>
                    ))}
                  </select>
                  <textarea
                    value={editComment}
                    onChange={(e) => setEditComment(e.target.value)}
                  />
                  <button type="button" onClick={() => saveEdit(r.id)}>保存</button>
                  <button type="button" onClick={() => setEditingId(null)}>キャンセル</button>
                </>
              ) : (
                <>
                  <strong>
                    評価: {"★".repeat(r.rating)}
                    {"☆".repeat(5 - r.rating)}
                  </strong>
                  <p>{r.comment}</p>
                  {/* 対価（クーポン）を伴う投稿であることの明示。
                      campaign を持たない過去のレビュー・通常のレビューには出さない。 */}
                  {r.campaign && (
                    <p
                      className="review-campaign-note"
                      style={{
                        fontSize: '0.8rem',
                        color: '#777',
                        background: '#f7f7f7',
                        borderRadius: 4,
                        padding: '6px 8px',
                        margin: '4px 0 8px',
                      }}
                    >
                      このレビューは、投稿キャンペーンの対象として投稿されました。
                      評価・内容は投稿者本人の自由な意見です。
                    </p>
                  )}
                  {reviewSeconds(r) > 0 && (
                    <small>
                      投稿日:{" "}
                      {new Date(reviewSeconds(r) * 1000).toLocaleDateString()}
                    </small>
                  )}
                  {r.reply && (
                    <div
                      className="reply-box"
                      style={{
                        marginTop: "8px",
                        paddingLeft: "12px",
                        borderLeft: "3px solid #ccc",
                      }}
                    >
                      <strong>先生からの返信:</strong>
                      <p>{r.reply}</p>
                    </div>
                  )}
                  <br />
                  {/* 編集・削除は投稿者本人にのみ表示（Firestore Rules でも本人のみ許可） */}
                  {r.userId && r.userId === auth.currentUser?.uid && (
                    <>
                      <button type="button" onClick={() => startEdit(r)}>編集</button>
                      <button type="button"
                        onClick={() => deleteReview(r.id)}
                        className="delete-button"
                      >
                        削除
                      </button>
                    </>
                  )}
                  {/* 返信できるのは担当講師本人のみ（Firestore Rules でも
                      teacherAuthUid が一致する場合の reply 更新だけを許可） */}
                  {canReply(r) && (
                    <button type="button"
                      onClick={() => {
                        setReplyingId(r.id);
                        setReplyText(r.reply ?? "");
                      }}
                    >
                      {r.reply ? "返信を編集" : "返信する"}
                    </button>
                  )}
                  {replyingId === r.id && (
                    <div style={{ marginTop: "8px" }}>
                      <textarea
                        placeholder="返信内容を入力してください"
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        style={{ width: "100%", minHeight: "60px" }}
                      />
                      <br />
                      <button type="button" onClick={() => handleReplySubmit(r.id)}>送信</button>
                      <button type="button"
                        onClick={() => {
                          setReplyingId(null);
                          setReplyText("");
                        }}
                      >
                        キャンセル
                      </button>
                    </div>
                  )}
                  <hr />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
