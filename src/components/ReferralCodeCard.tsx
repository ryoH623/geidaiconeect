// 自分の紹介コードの表示とコピー。マイページと友達紹介ページの両方で使う。
//
// コードの採番はサーバー（getMyReferralCode）が行う。未発行なら初回呼び出しで発行される。
import { useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import { useAuth } from '../contexts/AuthContext';

type Props = {
  /** 見出しを出すか（マイページでは簡易表示にするため省く） */
  heading?: string;
};

export default function ReferralCodeCard({ heading }: Props) {
  const { user, role, loading: authLoading } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  // 紹介コードを持てるのは生徒と管理者。講師では呼んでも 403 になるので呼ばない
  // （functions 側の canOwnReferralCode と揃えること）
  const canOwnCode = role === 'student' || role === 'admin';

  useEffect(() => {
    if (authLoading || !user || !canOwnCode) return;

    let cancelled = false;
    (async () => {
      try {
        const callable = httpsCallable<unknown, { ok: boolean; code: string }>(
          functions,
          'getMyReferralCode'
        );
        const res = await callable({});
        if (!cancelled) setCode(res.data.code);
      } catch (err) {
        console.error('紹介コードの取得に失敗しました', err);
        if (!cancelled) {
          setError('紹介コードを取得できませんでした。時間をおいてお試しください。');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, authLoading, canOwnCode]);

  const handleCopy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボード API が使えない環境では手動でコピーしてもらう
      setError('コピーできませんでした。コードを選択してコピーしてください。');
    }
  };

  if (!user) return null;

  // ロール判定が済むまでは何も出さない（一瞬「対象外」が見えるのを防ぐ）
  if (authLoading) return null;

  if (!canOwnCode) {
    return (
      <section style={{ marginTop: '2rem' }}>
        {heading && <h3>{heading}</h3>}
        <p style={{ color: '#666', marginTop: '0.75rem' }}>
          友達紹介は生徒アカウントでご利用いただけます。
        </p>
      </section>
    );
  }

  return (
    <section style={{ marginTop: '2rem' }}>
      {heading && <h3>{heading}</h3>}
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
          marginTop: '0.75rem',
        }}
      >
        <code
          style={{
            fontSize: '1.4rem',
            letterSpacing: '0.08em',
            padding: '10px 16px',
            border: '1px solid #ddd',
            borderRadius: 8,
            background: '#fafafa',
          }}
        >
          {code || '発行中…'}
        </code>
        <button
          type="button"
          className="form-button"
          onClick={handleCopy}
          disabled={!code}
        >
          {copied ? 'コピーしました' : 'コードをコピー'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
