// 管理者用: ユーザー1人ぶんのキャンペーン履歴。
// 「このユーザーが何をもらって、何に使い、誰を紹介したか」を1画面で追えるようにする。
// 不正利用の調査で、クーポン一覧と紹介一覧を行き来せずに済ませるのが狙い。
import React, { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAdminData } from '../../hooks/useAdminData';
import { useCampaignAdminData } from '../../hooks/useCampaignAdminData';
import { yen } from '../../lib/adminStats';
import {
  AUDIT_ACTION_LABEL,
  COUPON_STATUS_LABEL,
  COUPON_TYPE_LABEL,
  REFERRAL_STATUS_LABEL,
  couponReasonText,
  couponStatusColor,
  formatTimestamp,
} from '../../lib/campaignLabels';

const AdminUserCampaigns: React.FC = () => {
  const { uid = '' } = useParams();
  const { users, reservations, loading: usersLoading } = useAdminData();
  const { coupons, referrals, auditLogs, loading, error } = useCampaignAdminData();

  const userById = useMemo(() => {
    const m = new Map<string, { name: string; email: string; phone: string }>();
    for (const u of users) {
      m.set(u.id, {
        name: u.displayName || '（名前未設定）',
        email: u.email,
        phone: u.phone,
      });
    }
    return m;
  }, [users]);

  const nameOf = (id: string) => userById.get(id)?.name ?? id;
  const user = userById.get(uid);

  const myCoupons = useMemo(
    () => coupons.filter((c) => c.userId === uid),
    [coupons, uid]
  );

  // 紹介した側・された側の両方を見る（自己紹介の疑いはここで気づける）
  const asReferrer = useMemo(
    () => referrals.filter((r) => r.referrerUid === uid),
    [referrals, uid]
  );
  const asReferee = useMemo(
    () => referrals.filter((r) => r.refereeUid === uid),
    [referrals, uid]
  );

  const myLogs = useMemo(
    () =>
      auditLogs.filter(
        (l) =>
          l.targetUserId === uid ||
          l.refereeUid === uid ||
          (l.couponId && myCoupons.some((c) => c.id === l.couponId))
      ),
    [auditLogs, uid, myCoupons]
  );

  const myReservations = useMemo(
    () =>
      reservations
        .filter((r) => r.userId === uid)
        .sort((a, b) => (a.lessonDate < b.lessonDate ? 1 : -1)),
    [reservations, uid]
  );

  const reservationLabel = (reservationId: string | null): string => {
    if (!reservationId) return '―';
    const r = reservations.find((x) => x.id === reservationId);
    return r ? `${r.lessonDate} ${r.teacherName}` : reservationId;
  };

  return (
    <main className="admin-page">
      <h2 className="centered-heading-with-border">
        <span>ユーザー別 キャンペーン履歴</span>
      </h2>

      {loading || usersLoading ? (
        <p style={{ textAlign: 'center' }}>読み込み中...</p>
      ) : error ? (
        <p style={{ textAlign: 'center', color: '#c62828' }}>{error}</p>
      ) : (
        <>
          <section style={{ marginBottom: '2rem' }}>
            <h3>{user?.name ?? uid}</h3>
            <p style={{ color: '#8a8270' }}>
              {user?.email ?? '―'} ／ {user?.phone || '電話番号未登録'} ／ UID: {uid}
            </p>
            <p style={{ color: '#8a8270' }}>
              予約 {myReservations.length}件 ／ 付与クーポン {myCoupons.length}枚 ／
              紹介した人数 {asReferrer.length}人
            </p>
          </section>

          <section style={{ marginBottom: '2.5rem' }}>
            <h3>クーポン</h3>
            {myCoupons.length === 0 ? (
              <p style={{ color: '#8a8270' }}>付与されたクーポンはありません。</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>種別</th>
                      <th className="num">金額</th>
                      <th>ステータス</th>
                      <th>発行日</th>
                      <th>有効期限</th>
                      <th>使用された予約</th>
                      <th>発行理由</th>
                    </tr>
                  </thead>
                  <tbody>
                    {myCoupons.map((c) => (
                      <tr key={c.id}>
                        <td>{COUPON_TYPE_LABEL[c.type] ?? c.type}</td>
                        <td className="num">{yen(c.discountAmount)}</td>
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
                        <td>{reservationLabel(c.usedReservationId)}</td>
                        <td style={{ fontSize: '0.85rem' }}>
                          {couponReasonText(c, nameOf)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section style={{ marginBottom: '2.5rem' }}>
            <h3>紹介した相手</h3>
            {asReferrer.length === 0 ? (
              <p style={{ color: '#8a8270' }}>紹介の記録はありません。</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>被紹介者</th>
                      <th>コード</th>
                      <th>登録日</th>
                      <th>ステータス</th>
                      <th className="num">完了レッスン</th>
                      <th>紹介者特典</th>
                    </tr>
                  </thead>
                  <tbody>
                    {asReferrer.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link to={`/admin/users/${r.refereeUid}/campaigns`}>
                            {nameOf(r.refereeUid)}
                          </Link>
                        </td>
                        <td>{r.code || '―'}</td>
                        <td>{formatTimestamp(r.createdAt)}</td>
                        <td style={r.blocked ? { color: '#c62828' } : undefined}>
                          {r.blocked
                            ? `無効化${r.blockedReason ? `（${r.blockedReason}）` : ''}`
                            : REFERRAL_STATUS_LABEL[r.status] ?? r.status}
                        </td>
                        <td className="num">{r.completedLessonCount}</td>
                        <td>{r.referrerCouponId ? '付与済み' : '未付与'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section style={{ marginBottom: '2.5rem' }}>
            <h3>紹介された記録</h3>
            {asReferee.length === 0 ? (
              <p style={{ color: '#8a8270' }}>
                紹介コードを使って登録した記録はありません。
              </p>
            ) : (
              <ul style={{ lineHeight: 1.9 }}>
                {asReferee.map((r) => (
                  <li key={r.id}>
                    紹介者:{' '}
                    <Link to={`/admin/users/${r.referrerUid}/campaigns`}>
                      {nameOf(r.referrerUid)}
                    </Link>{' '}
                    ／ コード {r.code} ／ 完了レッスン {r.completedLessonCount}回 ／{' '}
                    {r.blocked
                      ? `無効化${r.blockedReason ? `（${r.blockedReason}）` : ''}`
                      : REFERRAL_STATUS_LABEL[r.status] ?? r.status}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={{ marginBottom: '2.5rem' }}>
            <h3>運営操作の履歴</h3>
            {myLogs.length === 0 ? (
              <p style={{ color: '#8a8270' }}>運営による手動操作はありません。</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>日時</th>
                      <th>操作</th>
                      <th>理由</th>
                      <th>実行者</th>
                    </tr>
                  </thead>
                  <tbody>
                    {myLogs.map((l) => (
                      <tr key={l.id}>
                        <td>{formatTimestamp(l.createdAt)}</td>
                        <td>{AUDIT_ACTION_LABEL[l.action] ?? l.action}</td>
                        <td style={{ fontSize: '0.85rem' }}>{l.reason || '―'}</td>
                        <td style={{ fontSize: '0.85rem' }}>{nameOf(l.adminUid)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <div
        style={{
          textAlign: 'center',
          marginTop: '2rem',
          display: 'flex',
          gap: 12,
          justifyContent: 'center',
          flexWrap: 'wrap',
        }}
      >
        <Link to="/admin/coupons" className="form-button">
          クーポン管理へ
        </Link>
        <Link to="/admin/referrals" className="form-button">
          友達紹介 管理へ
        </Link>
        <Link to="/admin" className="form-button">
          管理画面トップへ戻る
        </Link>
      </div>
    </main>
  );
};

export default AdminUserCampaigns;
