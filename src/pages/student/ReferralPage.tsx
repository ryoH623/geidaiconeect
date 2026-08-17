// src/pages/student/ReferralPage.tsx
// 友達紹介ページ。自分の紹介コードの確認・コピーと、紹介実績・獲得クーポンを表示する。
//
// 紹介コードの採番と特典の付与はすべて Cloud Functions 側で行う
// （campaigns.ts）。この画面は表示とコピーだけを担う。
import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { useMyCoupons } from '../../hooks/useMyCoupons';
import { formatCouponExpiry } from '../../lib/coupons';
import ReferralCodeCard from '../../components/ReferralCodeCard';

type Referral = {
  id: string;
  refereeUid: string;
  referrerUid: string;
  status: string;
  completedLessonCount?: number;
  referrerCouponId?: string | null;
  blocked?: boolean;
};

/** 紹介者への特典が出る、被紹介者の完了レッスン数（functions 側と揃えること） */
const REFERRER_REWARD_LESSON_COUNT = 3;

export default function ReferralPage() {
  const { user, role, loading: authLoading } = useAuth();
  const { coupons } = useMyCoupons();

  // 友達紹介は生徒アカウント限定（functions 側も student 以外は弾く）
  const isStudent = role === 'student';

  const [referrals, setReferrals] = useState<Referral[]>([]);

  // 自分が紹介した相手の進捗
  useEffect(() => {
    if (!user || !isStudent) {
      setReferrals([]);
      return;
    }
    const q = query(
      collection(db, 'referrals'),
      where('referrerUid', '==', user.uid)
    );
    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setReferrals(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Referral, 'id'>) }))
        );
      },
      (err) => console.error('紹介状況の取得に失敗しました', err)
    );
    return () => unsubscribe();
  }, [user, isStudent]);

  const stats = useMemo(() => {
    const invited = referrals.length;
    const firstDone = referrals.filter(
      (r) => (r.completedLessonCount ?? 0) >= 1
    ).length;
    const thirdDone = referrals.filter(
      (r) => (r.completedLessonCount ?? 0) >= REFERRER_REWARD_LESSON_COUNT
    ).length;
    return { invited, firstDone, thirdDone };
  }, [referrals]);

  // 特典待ち: まだ紹介特典クーポンが出ていない紹介
  const pending = useMemo(
    () => referrals.filter((r) => !r.referrerCouponId),
    [referrals]
  );

  if (authLoading) {
    return (
      <main className="about-section fade-in-up">
        <p style={{ textAlign: 'center', marginTop: '2rem' }}>読み込み中です…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="about-section fade-in-up">
        <p style={{ textAlign: 'center', marginTop: '2rem' }}>
          友達紹介のご利用にはログインが必要です。
        </p>
      </main>
    );
  }

  if (!isStudent) {
    return (
      <main className="about-section fade-in-up">
        <h2 className="centered-heading-with-border">
          <span>友達紹介</span>
        </h2>
        <p style={{ textAlign: 'center', marginTop: '2rem' }}>
          友達紹介・クーポンは生徒アカウントでご利用いただけます。
        </p>
      </main>
    );
  }

  return (
    <main className="about-section fade-in-up">
      <h2 className="centered-heading-with-border">
        <span>友達紹介</span>
      </h2>

      <div style={{ maxWidth: '640px', margin: '2rem auto' }}>
        {/* 紹介コード（マイページと同じ表示・コピー機能） */}
        <div style={{ marginBottom: '2.5rem' }}>
          <ReferralCodeCard heading="あなたの紹介コード" />
        </div>

        {/* 紹介方法 */}
        <section style={{ marginBottom: '2.5rem' }}>
          <h3>紹介の流れ</h3>
          <ol style={{ lineHeight: 1.9, paddingLeft: '1.2rem' }}>
            <li>上の紹介コードを、これから登録するお友達にお伝えください。</li>
            <li>
              お友達が<strong>会員登録時、または初回レッスンのご予約前まで</strong>に
              紹介コードを登録します。
            </li>
            <li>
              お友達の初回レッスンが完了すると、<strong>お友達に500円クーポン</strong>が届きます。
            </li>
            <li>
              お友達が3回目のレッスンを完了すると、<strong>あなたに1,000円クーポン</strong>が届きます。
            </li>
          </ol>
          <p style={{ fontSize: '0.85rem', color: '#666', lineHeight: 1.8 }}>
            ※ ご紹介特典のお受け取りには、あなた自身にレッスンの受講実績（1回以上）が必要です。<br />
            ※ 紹介コードは登録後に変更できません。すでにレッスンをご予約済みの方は対象外です。<br />
            ※ キャンセル・返金となったレッスンは回数に含まれません。<br />
            ※ 同一のご本人と判断できる場合は、特典の対象外となることがあります。
          </p>
        </section>

        {/* 紹介実績 */}
        <section style={{ marginBottom: '2.5rem' }}>
          <h3>紹介の状況</h3>
          <div
            style={{
              display: 'flex',
              gap: 16,
              flexWrap: 'wrap',
              marginTop: '0.75rem',
            }}
          >
            {[
              { label: '紹介した人数', value: stats.invited },
              { label: '初回レッスン完了', value: stats.firstDone },
              { label: '3回目レッスン完了', value: stats.thirdDone },
            ].map((s) => (
              <div
                key={s.label}
                style={{
                  flex: '1 1 150px',
                  border: '1px solid #ddd',
                  borderRadius: 8,
                  padding: '12px 16px',
                  textAlign: 'center',
                }}
              >
                <div style={{ fontSize: '1.6rem', fontWeight: 'bold' }}>
                  {s.value}
                </div>
                <div style={{ fontSize: '0.85rem', color: '#666' }}>{s.label}</div>
              </div>
            ))}
          </div>

          {pending.length > 0 && (
            <div style={{ marginTop: '1.25rem' }}>
              <h4 style={{ marginBottom: '0.5rem' }}>特典付与待ちの紹介</h4>
              <ul style={{ lineHeight: 1.8 }}>
                {pending.map((r, i) => {
                  const done = r.completedLessonCount ?? 0;
                  const remaining = Math.max(
                    REFERRER_REWARD_LESSON_COUNT - done,
                    0
                  );
                  return (
                    <li key={r.id}>
                      お友達 {i + 1} 人目: レッスン {done} 回完了
                      {r.blocked
                        ? '（確認中です。運営よりご連絡します）'
                        : remaining > 0
                          ? `／あと ${remaining} 回で1,000円クーポン`
                          : '／まもなくクーポンをお届けします'}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>

        {/* 獲得済みクーポン */}
        <section>
          <h3>獲得済みのクーポン</h3>
          {coupons.length === 0 ? (
            <p style={{ color: '#666' }}>まだクーポンはありません。</p>
          ) : (
            <ul style={{ lineHeight: 1.9 }}>
              {coupons.map((c) => (
                <li key={c.id}>
                  {c.name}（{c.discountAmount.toLocaleString()}円引き） /{' '}
                  {formatCouponExpiry(c)} /{' '}
                  {c.status === 'available'
                    ? '利用可能'
                    : c.status === 'reserved'
                      ? '手続き中'
                      : c.status === 'used'
                        ? '使用済み'
                        : c.status === 'expired'
                          ? '期限切れ'
                          : '無効'}
                </li>
              ))}
            </ul>
          )}
          <p style={{ fontSize: '0.85rem', color: '#666' }}>
            クーポンは予約フォームのクーポン欄から選択してご利用いただけます。
            現金への交換はできません。
          </p>
        </section>
      </div>
    </main>
  );
}
