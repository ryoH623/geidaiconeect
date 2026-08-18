// src/pages/ReviewSubmissionPage.tsx
//
// レビューは Cloud Functions（submitReview）経由で作成する。
// レビュー投稿キャンペーンの付与条件（支払い済み・受講済み・本人・1回まで）を
// クライアントでは検証できないため、Firestore への直接書き込みは禁止している。
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../firebase';
import { useAuth } from '../contexts/AuthContext';

type ReviewableReservation = {
  id: string;
  teacherName: string;
  lessonCourse: string;
  lessonDate: string;
  lessonTime: string;
  reviewId?: string | null;
};

type SubmitReviewResult = {
  ok: boolean;
  reviewId: string;
  couponIssued: boolean;
  couponId: string | null;
  couponMessage: string;
};

/** JST の今日（YYYY-MM-DD） */
function todayJst(): string {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

export default function ReviewSubmissionPage() {
  const [searchParams] = useSearchParams();
  const teacherFromQuery = searchParams.get('teacher') || '';
  const { user, loading: authLoading } = useAuth();

  const [reservations, setReservations] = useState<ReviewableReservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [reservationId, setReservationId] = useState('');
  const [rating, setRating] = useState('');
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitReviewResult | null>(null);
  const [error, setError] = useState('');

  // レビュー対象は「支払いが確定し、レッスン日が過ぎた自分の予約」。
  // サーバー側（submitReview）でも同じ条件を検証している。
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        // 投稿済みの判定には、予約の reviewId が指すレビューが「今も存在するか」を使う。
        // 本人が削除した場合は投稿し直せる仕様のため、reviewId の有無だけでは判定しない。
        const [snap, myReviews] = await Promise.all([
          getDocs(
            query(
              collection(db, 'reservations'),
              where('userId', '==', user.uid),
              where('paymentStatus', '==', 'paid')
            )
          ),
          getDocs(query(collection(db, 'reviews'), where('userId', '==', user.uid))),
        ]);
        if (cancelled) return;

        const liveReviewIds = new Set(myReviews.docs.map((d) => d.id));

        const today = todayJst();
        const list = snap.docs
          .map((d) => {
            const x = d.data();
            return {
              id: d.id,
              teacherName: String(x.teacherName ?? ''),
              lessonCourse: String(x.lessonCourse ?? ''),
              lessonDate: String(x.lessonDate ?? ''),
              lessonTime: String(x.lessonTime ?? ''),
              reservationStatus: String(x.reservationStatus ?? ''),
              reviewId:
                typeof x.reviewId === 'string' && liveReviewIds.has(x.reviewId)
                  ? x.reviewId
                  : null,
            };
          })
          .filter(
            (r) =>
              r.reservationStatus === 'confirmed' &&
              r.lessonDate &&
              r.lessonDate < today
          )
          .sort((a, b) => (a.lessonDate < b.lessonDate ? 1 : -1));

        setReservations(list);
        setLoadError('');
      } catch (err) {
        console.error('受講済みレッスンの取得に失敗しました', err);
        if (!cancelled) setLoadError('受講済みレッスンの取得に失敗しました。');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, authLoading]);

  // 未投稿のものだけを選択肢にする
  const selectable = useMemo(
    () => reservations.filter((r) => !r.reviewId),
    [reservations]
  );

  // 講師ページから「レビューを書く」で来た場合はその講師の予約を初期選択する
  useEffect(() => {
    if (reservationId || selectable.length === 0) return;
    const preferred = teacherFromQuery
      ? selectable.find((r) => r.teacherName === teacherFromQuery)
      : null;
    setReservationId((preferred ?? selectable[0]).id);
  }, [selectable, teacherFromQuery, reservationId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!reservationId) {
      setError('レビュー対象のレッスンを選択してください。');
      return;
    }

    try {
      setSubmitting(true);
      const callable = httpsCallable<
        { reservationId: string; rating: number; comment: string },
        SubmitReviewResult
      >(functions, 'submitReview');

      const res = await callable({
        reservationId,
        rating: Number(rating),
        comment,
      });

      setResult(res.data);
      setRating('');
      setComment('');
      // 投稿済みにして選択肢から外す
      setReservations((prev) =>
        prev.map((r) =>
          r.id === reservationId ? { ...r, reviewId: res.data.reviewId } : r
        )
      );
      setReservationId('');
    } catch (err: unknown) {
      console.error('レビュー保存エラー:', err);
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : 'レビューの送信に失敗しました。';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const containerStyle: React.CSSProperties = {
    marginTop: '10rem',
    padding: '2rem',
    maxWidth: '640px',
    marginLeft: 'auto',
    marginRight: 'auto',
  };

  if (authLoading || loading) {
    return (
      <div className="review-form-container" style={containerStyle}>
        <h2>レビューを投稿</h2>
        <p>読み込み中です…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="review-form-container" style={containerStyle}>
        <h2>レビューを投稿</h2>
        <p>
          レビューの投稿にはログインが必要です。
          <Link to="/login">ログインはこちら</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="review-form-container" style={containerStyle}>
      <h2>レビューを投稿</h2>

      {/* キャンペーンの説明。星の数や内容で付与を左右しないことを明示する。 */}
      <div
        style={{
          border: '1px solid #e0d5b8',
          background: '#fdf9ef',
          borderRadius: 8,
          padding: '1rem',
          margin: '1rem 0 1.5rem',
          fontSize: '0.9rem',
          lineHeight: 1.7,
        }}
      >
        <strong>レビュー投稿キャンペーン</strong>
        <p style={{ margin: '0.5rem 0 0' }}>
          レッスン受講後、率直なレビューをご投稿いただいた方に、次回のレッスンで利用できる
          500円クーポンをプレゼントします。評価内容や星の数は、クーポンの付与条件に影響しません。
          キャンペーンはお一人様1回までです。
        </p>
        <p style={{ margin: '0.5rem 0 0', color: '#666', fontSize: '0.85rem' }}>
          ※ クーポンは 4,000円以上のご予約で利用でき、有効期限は発行日から60日間です。
        </p>
      </div>

      {result && (
        <div
          style={{
            border: '1px solid #cfe3cf',
            background: '#f4faf4',
            borderRadius: 8,
            padding: '1rem',
            marginBottom: '1.5rem',
          }}
        >
          <p style={{ margin: 0 }}>レビューを投稿しました。ありがとうございます。</p>
          <p style={{ margin: '0.5rem 0 0' }}>{result.couponMessage}</p>
          {result.couponIssued && (
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem' }}>
              次回のご予約時に、予約フォームのクーポン欄から選択してご利用ください。
            </p>
          )}
        </div>
      )}

      {loadError && <p className="error">{loadError}</p>}

      {selectable.length === 0 ? (
        <p>
          レビューを投稿できる受講済みのレッスンがありません。
          レッスンの受講後（レッスン日の翌日以降）にご投稿いただけます。
        </p>
      ) : (
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '1rem' }}>
            <label>対象のレッスン</label>
            <br />
            <select
              value={reservationId}
              onChange={(e) => setReservationId(e.target.value)}
              required
              style={{ width: '100%' }}
            >
              {selectable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.lessonDate} {r.lessonTime} / {r.teacherName} / {r.lessonCourse}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label>評価（1〜5）</label>
            <br />
            <select
              value={rating}
              onChange={(e) => setRating(e.target.value)}
              required
            >
              <option value="">選択してください</option>
              {[1, 2, 3, 4, 5].map((num) => (
                <option key={num} value={num}>
                  {num}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label>コメント</label>
            <br />
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              required
              rows={5}
              style={{ width: '100%' }}
              placeholder="講師の対応やレッスンの感想などをご記入ください"
            />
          </div>

          {error && <p className="error">{error}</p>}

          <button type="submit" disabled={submitting}>
            {submitting ? '送信中…' : '投稿'}
          </button>
        </form>
      )}
    </div>
  );
}
