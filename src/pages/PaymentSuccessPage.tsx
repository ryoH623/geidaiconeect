import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { getAuth, onAuthStateChanged, type User } from 'firebase/auth';

type ReservationResponse = {
  ok: boolean;
  reservationId?: string;
  reservation?: {
    teacherId?: string;
    teacherName?: string;
    teacherEmail?: string;
    lessonCourse?: string;
    lessonAmount?: number;
    // クーポン利用時のみ入る。レッスン料と実際の請求額が異なるため内訳を出す。
    couponName?: string;
    couponDiscount?: number;
    totalAmount?: number;
    lessonDate?: string;
    lessonTime?: string;
    name?: string;
    furigana?: string;
    email?: string;
    phone?: string;
    location?: string;
    notes?: string;
    paymentStatus?: string;
    reservationStatus?: string;
    paymentProvider?: string;
    userEmail?: string;
  };
  message?: string;
};

const PaymentSuccessPage: React.FC = () => {
  const location = useLocation();
  const auth = getAuth();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reservationId, setReservationId] = useState('');
  const [reservation, setReservation] = useState<ReservationResponse['reservation'] | null>(null);

  const queryParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const sessionId = queryParams.get('session_id') || '';
  const reservationIdFromQuery = queryParams.get('reservationId') || '';

  // 予約が成立したら、予約フォームに残っている下書き（reserveDraft:*）を破棄する。
  // 決済キャンセルで /reservation に戻る場合は残したいので、成功時のみここで消す。
  useEffect(() => {
    try {
      Object.keys(sessionStorage)
        .filter((key) => key.startsWith('reserveDraft:'))
        .forEach((key) => sessionStorage.removeItem(key));
    } catch (error) {
      console.warn('予約フォームの下書き破棄に失敗しました:', error);
    }
  }, []);

  const GET_RESERVATION_FOR_SUCCESS_URL =
    import.meta.env.VITE_GET_RESERVATION_FOR_SUCCESS_URL ||
    'https://us-central1-geidaiconnect.cloudfunctions.net/getReservationForSuccess';

  useEffect(() => {
    const fetchReservation = async (user: User | null) => {
      try {
        setLoading(true);
        setError('');

        if (!user) {
          throw new Error('ログイン状態を確認できませんでした。再度ログインしてください。');
        }

        if (!sessionId && !reservationIdFromQuery) {
          throw new Error('session_id または reservationId が見つかりませんでした。');
        }

        const idToken = await user.getIdToken();

        const body: Record<string, string> = {};
        if (reservationIdFromQuery) {
          body.reservationId = reservationIdFromQuery;
        }
        if (sessionId) {
          body.session_id = sessionId;
        }

        const response = await fetch(GET_RESERVATION_FOR_SUCCESS_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify(body),
        });

        const result: ReservationResponse = await response.json();

        if (!response.ok || !result.ok) {
          throw new Error(result.message || '予約情報の取得に失敗しました。');
        }

        setReservationId(result.reservationId || reservationIdFromQuery || '');
        setReservation(result.reservation || null);
      } catch (err: any) {
        console.error('[PaymentSuccessPage] fetchReservation failed', err);
        setError(
          typeof err?.message === 'string' && err.message
            ? err.message
            : '予約情報の取得に失敗しました。'
        );
      } finally {
        setLoading(false);
      }
    };

    // Stripe から戻った直後はページ全体が再読み込みされるため、
    // auth.currentUser がまだ null の場合がある。認証状態の復元を待ってから取得する。
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      fetchReservation(user);
    });

    return () => unsubscribe();
  }, [auth, sessionId, reservationIdFromQuery, GET_RESERVATION_FOR_SUCCESS_URL]);

  const paymentCompleted =
    reservation?.paymentStatus === 'paid' &&
    reservation?.reservationStatus === 'confirmed';

  return (
    <main className="about-section fade-in-up">
      <h2 className="centered-heading-with-border">
        <span>お支払い完了</span>
      </h2>

      {loading ? (
        <div style={{ maxWidth: '720px', margin: '2rem auto', textAlign: 'center' }}>
          <p>予約情報を確認しています…</p>
        </div>
      ) : error ? (
        <div
          style={{
            maxWidth: '720px',
            margin: '2rem auto',
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: '10px',
            padding: '24px',
          }}
        >
          <p style={{ color: '#c62828', marginBottom: '1rem' }}>❌ {error}</p>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <Link to="/" className="form-button">
              トップへ戻る
            </Link>
            <Link to="/mypage" className="form-button">
              マイページへ
            </Link>
          </div>
        </div>
      ) : (
        <div
          style={{
            maxWidth: '720px',
            margin: '2rem auto',
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: '10px',
            padding: '24px',
          }}
        >
          <p style={{ fontSize: '1.05rem', marginBottom: '1.5rem' }}>
            {paymentCompleted
              ? '✅ お支払いが完了し、予約が確定しました。'
              : 'お支払い情報は取得できました。予約状態を確認してください。'}
          </p>

          <div className="form-group">
            <p>
              <strong>予約ID：</strong>
              {reservationId || '未取得'}
            </p>
            <p>
              <strong>講師名：</strong>
              {reservation?.teacherName || ''}
            </p>
            <p>
              <strong>レッスンコース：</strong>
              {reservation?.lessonCourse || ''}
            </p>
            <p>
              <strong>日時：</strong>
              {reservation?.lessonDate || ''} {reservation?.lessonTime || ''}
            </p>
            <p>
              <strong>
                {reservation?.couponDiscount ? 'レッスン料：' : '料金：'}
              </strong>
              {typeof reservation?.lessonAmount === 'number'
                ? `${reservation.lessonAmount.toLocaleString()}円`
                : ''}
            </p>
            {!!reservation?.couponDiscount && (
              <>
                <p>
                  <strong>クーポン：</strong>
                  {reservation.couponName || 'クーポン'}（-
                  {reservation.couponDiscount.toLocaleString()}円）
                </p>
                <p>
                  <strong>お支払い金額：</strong>
                  {typeof reservation.totalAmount === 'number'
                    ? `${reservation.totalAmount.toLocaleString()}円`
                    : ''}
                </p>
              </>
            )}
            <p>
              <strong>お名前：</strong>
              {reservation?.name || ''}
            </p>
            <p>
              <strong>フリガナ：</strong>
              {reservation?.furigana || ''}
            </p>
            <p>
              <strong>メールアドレス：</strong>
              {reservation?.email || reservation?.userEmail || ''}
            </p>
            <p>
              <strong>電話番号：</strong>
              {reservation?.phone || ''}
            </p>
            <p>
              <strong>レッスン場所：</strong>
              {reservation?.location || ''}
            </p>
            <p>
              <strong>ご要望：</strong>
              {reservation?.notes || 'なし'}
            </p>
            <p>
              <strong>決済状態：</strong>
              {reservation?.paymentStatus || ''}
            </p>
            <p>
              <strong>予約状態：</strong>
              {reservation?.reservationStatus || ''}
            </p>
            <p>
              <strong>決済方法：</strong>
              {reservation?.paymentProvider || ''}
            </p>
          </div>

          <div
            style={{
              display: 'flex',
              gap: '12px',
              flexWrap: 'wrap',
              marginTop: '2rem',
            }}
          >
            <Link to="/" className="form-button">
              トップへ戻る
            </Link>
            <Link to="/mypage" className="form-button">
              マイページへ
            </Link>
          </div>
        </div>
      )}
    </main>
  );
};

export default PaymentSuccessPage;