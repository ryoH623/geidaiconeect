// 管理者用: 発行済みクーポンの一覧と、手動付与・手動無効化。
//
// クーポンの書き込みは Firestore ルールで全面的に閉じているため、
// 付与・無効化はすべて Cloud Functions（adminIssueCoupon / adminCancelCoupon）を通す。
// どちらも理由の入力を必須にしており、campaignAuditLogs に記録が残る。
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../firebase';
import { useAdminData } from '../../hooks/useAdminData';
import { useCampaignAdminData } from '../../hooks/useCampaignAdminData';
import type { AdminCoupon } from '../../hooks/useCampaignAdminData';
import { yen } from '../../lib/adminStats';
import type { CouponStatus, CouponType } from '../../lib/coupons';
import {
  COUPON_STATUS_LABEL,
  COUPON_TYPE_LABEL,
  couponReasonText,
  couponStatusColor,
  formatTimestamp,
} from '../../lib/campaignLabels';

const STATUS_FILTERS: Array<CouponStatus | 'all'> = [
  'all',
  'available',
  'reserved',
  'used',
  'expired',
  'cancelled',
];

const TYPE_FILTERS: Array<CouponType | 'all'> = [
  'all',
  'review',
  'referral_referee',
  'referral_referrer',
  'manual',
];

const AdminCoupons: React.FC = () => {
  const { users, reservations, loading: usersLoading } = useAdminData();
  const { coupons, loading, error, reload } = useCampaignAdminData();

  const [statusFilter, setStatusFilter] = useState<CouponStatus | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<CouponType | 'all'>('all');
  const [keyword, setKeyword] = useState('');

  // 無効化・手動付与のフォーム状態
  const [cancelTarget, setCancelTarget] = useState<AdminCoupon | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [showIssueForm, setShowIssueForm] = useState(false);
  const [issueUserId, setIssueUserId] = useState('');
  const [issueDiscount, setIssueDiscount] = useState('500');
  const [issueMinAmount, setIssueMinAmount] = useState('4000');
  const [issueValidDays, setIssueValidDays] = useState('60');
  const [issueReason, setIssueReason] = useState('');
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');

  const userById = useMemo(() => {
    const m = new Map<string, { name: string; email: string }>();
    for (const u of users) {
      m.set(u.id, { name: u.displayName || '（名前未設定）', email: u.email });
    }
    return m;
  }, [users]);

  const displayNameOf = (uid: string) => userById.get(uid)?.name ?? uid;

  const reservationById = useMemo(() => {
    const m = new Map<string, { label: string }>();
    for (const r of reservations) {
      m.set(r.id, {
        label: `${r.lessonDate} ${r.teacherName}`.trim(),
      });
    }
    return m;
  }, [reservations]);

  const students = useMemo(
    () =>
      users
        .filter((u) => u.role === 'student')
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja')),
    [users]
  );

  const rows = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return coupons.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (typeFilter !== 'all' && c.type !== typeFilter) return false;
      if (!kw) return true;
      const u = userById.get(c.userId);
      return (
        c.userId.toLowerCase().includes(kw) ||
        (u?.name ?? '').toLowerCase().includes(kw) ||
        (u?.email ?? '').toLowerCase().includes(kw)
      );
    });
  }, [coupons, statusFilter, typeFilter, keyword, userById]);

  // 集計（発行済み・利用可能・使用済みの金額感を把握するため）
  const summary = useMemo(() => {
    const issued = coupons.length;
    const used = coupons.filter((c) => c.status === 'used');
    const available = coupons.filter((c) => c.status === 'available').length;
    const usedAmount = used.reduce((s, c) => s + c.discountAmount, 0);
    return { issued, used: used.length, available, usedAmount };
  }, [coupons]);

  const handleCancel = async () => {
    if (!cancelTarget) return;
    setActionError('');
    setActionNotice('');

    if (!cancelReason.trim()) {
      setActionError('無効化の理由を入力してください。');
      return;
    }

    try {
      setWorking(true);
      const callable = httpsCallable<
        { couponId: string; reason: string },
        { ok: boolean }
      >(functions, 'adminCancelCoupon');
      await callable({
        couponId: cancelTarget.id,
        reason: cancelReason.trim(),
      });
      setActionNotice('クーポンを無効化しました。');
      setCancelTarget(null);
      setCancelReason('');
      reload();
    } catch (err: unknown) {
      console.error('クーポンの無効化に失敗しました', err);
      setActionError(
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : '無効化に失敗しました。'
      );
    } finally {
      setWorking(false);
    }
  };

  const handleIssue = async () => {
    setActionError('');
    setActionNotice('');

    if (!issueUserId) {
      setActionError('付与するユーザーを選択してください。');
      return;
    }
    if (!issueReason.trim()) {
      setActionError('発行理由を入力してください。');
      return;
    }

    try {
      setWorking(true);
      const callable = httpsCallable<
        {
          userId: string;
          type: CouponType;
          reason: string;
          discountAmount: number;
          minAmount: number;
          validDays: number;
        },
        { ok: boolean; couponId: string }
      >(functions, 'adminIssueCoupon');

      await callable({
        userId: issueUserId,
        type: 'manual',
        reason: issueReason.trim(),
        discountAmount: Number(issueDiscount),
        minAmount: Number(issueMinAmount),
        validDays: Number(issueValidDays),
      });

      setActionNotice('クーポンを付与しました。');
      setShowIssueForm(false);
      setIssueUserId('');
      setIssueReason('');
      reload();
    } catch (err: unknown) {
      console.error('クーポンの手動付与に失敗しました', err);
      setActionError(
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : '付与に失敗しました。'
      );
    } finally {
      setWorking(false);
    }
  };

  return (
    <main className="admin-page">
      <h2 className="centered-heading-with-border">
        <span>クーポン管理</span>
      </h2>

      {loading || usersLoading ? (
        <p style={{ textAlign: 'center' }}>読み込み中...</p>
      ) : error ? (
        <p style={{ textAlign: 'center', color: '#c62828' }}>{error}</p>
      ) : (
        <>
          <p style={{ color: '#8a8270' }}>
            発行済み {summary.issued}枚 ／ 利用可能 {summary.available}枚 ／ 使用済み{' '}
            {summary.used}枚（値引き実績 {yen(summary.usedAmount)}）
          </p>

          {/* 操作パネル */}
          <div style={{ margin: '1rem 0', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="form-button"
              onClick={() => {
                setShowIssueForm((v) => !v);
                setCancelTarget(null);
                setActionError('');
              }}
            >
              {showIssueForm ? '手動付与をやめる' : 'クーポンを手動付与'}
            </button>
          </div>

          {actionNotice && <p style={{ color: '#2e7d32' }}>{actionNotice}</p>}
          {actionError && <p style={{ color: '#c62828' }}>{actionError}</p>}

          {showIssueForm && (
            <div
              style={{
                border: '1px solid #ddd',
                borderRadius: 8,
                padding: '1rem',
                marginBottom: '1.5rem',
                background: '#fafafa',
              }}
            >
              <h3 style={{ marginTop: 0 }}>クーポンの手動付与</h3>
              <p style={{ fontSize: '0.85rem', color: '#666' }}>
                キャンペーンの1回制限とは無関係に発行されます。例外対応・お詫びなど、
                後から説明できる理由を必ず残してください。
              </p>

              <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
                <label>
                  対象ユーザー
                  <select
                    className="form-control"
                    value={issueUserId}
                    onChange={(e) => setIssueUserId(e.target.value)}
                  >
                    <option value="">選択してください</option>
                    {students.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName || '（名前未設定）'}／{u.email}
                      </option>
                    ))}
                  </select>
                </label>

                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <label style={{ flex: '1 1 120px' }}>
                    値引き額（円）
                    <input
                      type="number"
                      className="form-control"
                      value={issueDiscount}
                      onChange={(e) => setIssueDiscount(e.target.value)}
                      min={1}
                    />
                  </label>
                  <label style={{ flex: '1 1 120px' }}>
                    最低利用金額（円）
                    <input
                      type="number"
                      className="form-control"
                      value={issueMinAmount}
                      onChange={(e) => setIssueMinAmount(e.target.value)}
                      min={0}
                    />
                  </label>
                  <label style={{ flex: '1 1 120px' }}>
                    有効日数
                    <input
                      type="number"
                      className="form-control"
                      value={issueValidDays}
                      onChange={(e) => setIssueValidDays(e.target.value)}
                      min={1}
                    />
                  </label>
                </div>

                <label>
                  発行理由（必須）
                  <textarea
                    className="form-control"
                    rows={2}
                    value={issueReason}
                    onChange={(e) => setIssueReason(e.target.value)}
                    placeholder="例: 講師都合のキャンセルに対するお詫び（予約ID xxxx）"
                  />
                </label>

                <div>
                  <button
                    type="button"
                    className="form-button"
                    onClick={handleIssue}
                    disabled={working}
                  >
                    {working ? '処理中…' : 'この内容で付与する'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {cancelTarget && (
            <div
              style={{
                border: '1px solid #f0c4c4',
                borderRadius: 8,
                padding: '1rem',
                marginBottom: '1.5rem',
                background: '#fdf5f5',
              }}
            >
              <h3 style={{ marginTop: 0 }}>クーポンの無効化</h3>
              <p style={{ margin: '0 0 0.5rem' }}>
                対象: {displayNameOf(cancelTarget.userId)} ／ {cancelTarget.name}（
                {yen(cancelTarget.discountAmount)}） ／ 現在の状態:{' '}
                {COUPON_STATUS_LABEL[cancelTarget.status]}
              </p>
              <p style={{ fontSize: '0.85rem', color: '#666' }}>
                無効化するとユーザーは使用できなくなります。使用済みのクーポンも、
                不正利用が判明した場合の記録として無効化できます（決済の返金は別途対応が必要です）。
              </p>
              <textarea
                className="form-control"
                rows={2}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="例: 同一人物による複数アカウントでの取得を確認したため"
                style={{ maxWidth: 520 }}
              />
              <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                <button
                  type="button"
                  className="form-button"
                  onClick={handleCancel}
                  disabled={working}
                >
                  {working ? '処理中…' : '無効化する'}
                </button>
                <button
                  type="button"
                  className="form-button"
                  onClick={() => {
                    setCancelTarget(null);
                    setCancelReason('');
                  }}
                  disabled={working}
                >
                  やめる
                </button>
              </div>
            </div>
          )}

          {/* 絞り込み */}
          <div
            style={{
              display: 'flex',
              gap: 12,
              flexWrap: 'wrap',
              alignItems: 'flex-end',
              marginBottom: '1rem',
            }}
          >
            <label>
              ステータス
              <select
                className="form-control"
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as CouponStatus | 'all')
                }
              >
                {STATUS_FILTERS.map((s) => (
                  <option key={s} value={s}>
                    {s === 'all' ? 'すべて' : COUPON_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>

            <label>
              種別
              <select
                className="form-control"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as CouponType | 'all')}
              >
                {TYPE_FILTERS.map((t) => (
                  <option key={t} value={t}>
                    {t === 'all' ? 'すべて' : COUPON_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ flex: '1 1 240px' }}>
              ユーザー検索（氏名・メール・UID）
              <input
                type="text"
                className="form-control"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
            </label>
          </div>

          <p style={{ color: '#8a8270' }}>該当 {rows.length}件</p>

          <div style={{ overflowX: 'auto' }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>ユーザー</th>
                  <th>種別</th>
                  <th className="num">金額</th>
                  <th>ステータス</th>
                  <th>発行日</th>
                  <th>有効期限</th>
                  <th>使用された予約</th>
                  <th>発行理由</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const user = userById.get(c.userId);
                  const usedRes = c.usedReservationId
                    ? reservationById.get(c.usedReservationId)
                    : null;
                  return (
                    <tr key={c.id}>
                      <td>
                        <Link to={`/admin/users/${c.userId}/campaigns`}>
                          {user?.name ?? c.userId}
                        </Link>
                        <div style={{ fontSize: '0.75rem', color: '#8a8270' }}>
                          {user?.email ?? ''}
                        </div>
                      </td>
                      <td>{COUPON_TYPE_LABEL[c.type] ?? c.type}</td>
                      <td className="num">
                        {yen(c.discountAmount)}
                        <div style={{ fontSize: '0.75rem', color: '#8a8270' }}>
                          {yen(c.minAmount)}以上
                        </div>
                      </td>
                      <td style={{ color: couponStatusColor(c.status) }}>
                        {COUPON_STATUS_LABEL[c.status] ?? c.status}
                        {c.cancelReason && (
                          <div style={{ fontSize: '0.75rem', color: '#8a8270' }}>
                            {c.cancelReason}
                          </div>
                        )}
                      </td>
                      <td>{formatTimestamp(c.issuedAt)}</td>
                      <td>{formatTimestamp(c.expiresAt)}</td>
                      <td>
                        {c.usedReservationId ? (
                          <>
                            {usedRes?.label ?? c.usedReservationId}
                            <div style={{ fontSize: '0.75rem', color: '#8a8270' }}>
                              {formatTimestamp(c.usedAt)}
                            </div>
                          </>
                        ) : c.reservedReservationId ? (
                          '（決済手続き中）'
                        ) : (
                          '―'
                        )}
                      </td>
                      <td style={{ fontSize: '0.85rem' }}>
                        {couponReasonText(c, displayNameOf)}
                      </td>
                      <td>
                        {c.status === 'cancelled' ? (
                          '―'
                        ) : (
                          <button
                            type="button"
                            className="form-button"
                            onClick={() => {
                              setCancelTarget(c);
                              setCancelReason('');
                              setShowIssueForm(false);
                              setActionError('');
                              setActionNotice('');
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                          >
                            無効化
                          </button>
                        )}
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

export default AdminCoupons;
