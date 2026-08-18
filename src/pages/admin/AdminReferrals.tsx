// 管理者用: 友達紹介の一覧と、紹介の無効化・解除。
//
// blocked を立てると以降のマイルストーン判定が止まる。付与済みのクーポンは
// 取り消されないため、必要なら「クーポン管理」で個別に無効化する。
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../firebase';
import { useAdminData } from '../../hooks/useAdminData';
import { useCampaignAdminData } from '../../hooks/useCampaignAdminData';
import type { AdminReferral } from '../../hooks/useCampaignAdminData';
import {
  REFERRAL_STATUS_LABEL,
  formatTimestamp,
} from '../../lib/campaignLabels';

/** 紹介者への特典が出る完了回数（functions 側の REFERRER_REWARD_LESSON_COUNT と揃える） */
const REFERRER_REWARD_LESSON_COUNT = 3;

const AdminReferrals: React.FC = () => {
  const { users, loading: usersLoading } = useAdminData();
  const { referrals, loading, error, reload } = useCampaignAdminData();

  const [target, setTarget] = useState<{
    referral: AdminReferral;
    blocked: boolean;
  } | null>(null);
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [onlyBlocked, setOnlyBlocked] = useState(false);

  const userById = useMemo(() => {
    const m = new Map<string, { name: string; email: string }>();
    for (const u of users) {
      m.set(u.id, { name: u.displayName || '（名前未設定）', email: u.email });
    }
    return m;
  }, [users]);

  const rows = useMemo(
    () => (onlyBlocked ? referrals.filter((r) => r.blocked) : referrals),
    [referrals, onlyBlocked]
  );

  const summary = useMemo(() => {
    const total = referrals.length;
    const firstDone = referrals.filter((r) => r.completedLessonCount >= 1).length;
    const rewardDone = referrals.filter((r) => !!r.referrerCouponId).length;
    const blocked = referrals.filter((r) => r.blocked).length;
    return { total, firstDone, rewardDone, blocked };
  }, [referrals]);

  const handleSubmit = async () => {
    if (!target) return;
    setActionError('');
    setActionNotice('');

    if (!reason.trim()) {
      setActionError('理由を入力してください。');
      return;
    }

    try {
      setWorking(true);
      const callable = httpsCallable<
        { refereeUid: string; blocked: boolean; reason: string },
        { ok: boolean }
      >(functions, 'adminSetReferralBlocked');

      await callable({
        refereeUid: target.referral.refereeUid,
        blocked: target.blocked,
        reason: reason.trim(),
      });

      setActionNotice(
        target.blocked
          ? '紹介を無効化しました。以降の特典付与は止まります。'
          : '無効化を解除しました。条件を満たしていれば特典が付与されます。'
      );
      setTarget(null);
      setReason('');
      reload();
    } catch (err: unknown) {
      console.error('紹介の状態変更に失敗しました', err);
      setActionError(
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : '処理に失敗しました。'
      );
    } finally {
      setWorking(false);
    }
  };

  const nameOf = (uid: string) => userById.get(uid)?.name ?? uid;

  return (
    <main className="admin-page">
      <h2 className="centered-heading-with-border">
        <span>友達紹介 管理</span>
      </h2>

      {loading || usersLoading ? (
        <p style={{ textAlign: 'center' }}>読み込み中...</p>
      ) : error ? (
        <p style={{ textAlign: 'center', color: '#c62828' }}>{error}</p>
      ) : (
        <>
          <p style={{ color: '#8a8270' }}>
            紹介 {summary.total}件 ／ 初回完了 {summary.firstDone}件 ／ 紹介者特典付与済み{' '}
            {summary.rewardDone}件 ／ 無効化 {summary.blocked}件
          </p>

          {actionNotice && <p style={{ color: '#2e7d32' }}>{actionNotice}</p>}
          {actionError && <p style={{ color: '#c62828' }}>{actionError}</p>}

          {target && (
            <div
              style={{
                border: '1px solid #f0c4c4',
                borderRadius: 8,
                padding: '1rem',
                marginBottom: '1.5rem',
                background: '#fdf5f5',
              }}
            >
              <h3 style={{ marginTop: 0 }}>
                {target.blocked ? '紹介の無効化' : '無効化の解除'}
              </h3>
              <p style={{ margin: '0 0 0.5rem' }}>
                対象: 紹介者 {nameOf(target.referral.referrerUid)} → 被紹介者{' '}
                {nameOf(target.referral.refereeUid)}（コード {target.referral.code}）
              </p>
              <p style={{ fontSize: '0.85rem', color: '#666' }}>
                {target.blocked
                  ? '以降の特典付与が止まります。すでに付与済みのクーポンは自動では取り消されないため、必要に応じてクーポン管理から無効化してください。'
                  : '解除するとその場で条件を再判定し、条件を満たしていれば特典が付与されます。'}
              </p>
              <textarea
                className="form-control"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={
                  target.blocked
                    ? '例: 同一人物による自己紹介の疑いを確認したため'
                    : '例: 本人確認の結果、別人であることを確認したため'
                }
                style={{ maxWidth: 520 }}
              />
              <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                <button
                  type="button"
                  className="form-button"
                  onClick={handleSubmit}
                  disabled={working}
                >
                  {working ? '処理中…' : target.blocked ? '無効化する' : '解除する'}
                </button>
                <button
                  type="button"
                  className="form-button"
                  onClick={() => {
                    setTarget(null);
                    setReason('');
                  }}
                  disabled={working}
                >
                  やめる
                </button>
              </div>
            </div>
          )}

          <label style={{ display: 'inline-block', marginBottom: '1rem' }}>
            <input
              type="checkbox"
              checked={onlyBlocked}
              onChange={(e) => setOnlyBlocked(e.target.checked)}
            />{' '}
            無効化されている紹介のみ表示
          </label>

          <div style={{ overflowX: 'auto' }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>紹介者</th>
                  <th>被紹介者</th>
                  <th>紹介コード</th>
                  <th>登録日</th>
                  <th>紹介ステータス</th>
                  <th className="num">完了レッスン</th>
                  <th>被紹介者特典</th>
                  <th>紹介者特典</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const remaining = Math.max(
                    REFERRER_REWARD_LESSON_COUNT - r.completedLessonCount,
                    0
                  );
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link to={`/admin/users/${r.referrerUid}/campaigns`}>
                          {nameOf(r.referrerUid)}
                        </Link>
                      </td>
                      <td>
                        <Link to={`/admin/users/${r.refereeUid}/campaigns`}>
                          {nameOf(r.refereeUid)}
                        </Link>
                      </td>
                      <td>{r.code || '―'}</td>
                      <td>{formatTimestamp(r.createdAt)}</td>
                      <td>
                        {r.blocked ? (
                          <span style={{ color: '#c62828' }}>
                            無効化
                            {r.blockedReason && (
                              <div style={{ fontSize: '0.75rem', color: '#8a8270' }}>
                                {r.blockedReason}
                              </div>
                            )}
                          </span>
                        ) : (
                          REFERRAL_STATUS_LABEL[r.status] ?? r.status ?? '―'
                        )}
                      </td>
                      <td className="num">
                        {r.completedLessonCount}
                        {remaining > 0 && (
                          <div style={{ fontSize: '0.75rem', color: '#8a8270' }}>
                            特典まであと{remaining}
                          </div>
                        )}
                      </td>
                      <td>{r.refereeCouponId ? '付与済み' : '未付与'}</td>
                      <td>{r.referrerCouponId ? '付与済み' : '未付与'}</td>
                      <td>
                        <button
                          type="button"
                          className="form-button"
                          onClick={() => {
                            setTarget({ referral: r, blocked: !r.blocked });
                            setReason('');
                            setActionError('');
                            setActionNotice('');
                            window.scrollTo({ top: 0, behavior: 'smooth' });
                          }}
                        >
                          {r.blocked ? '解除' : '無効化'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div style={{ textAlign: 'center', marginTop: '2rem' }}>
        <Link to="/admin" className="form-button">
          管理画面トップへ戻る
        </Link>
      </div>
    </main>
  );
};

export default AdminReferrals;
