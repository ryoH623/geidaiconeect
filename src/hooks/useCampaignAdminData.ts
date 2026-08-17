// 管理画面用: クーポン・友達紹介・運営操作の監査ログをまとめて取得する。
//
// これらのコレクションは Firestore ルールで admin だけが read できる。
// 書き込みは Cloud Functions 経由のみのため、このフックは読み取り専用。
import { useCallback, useEffect, useState } from 'react';
import { collection, getDocs, Timestamp } from 'firebase/firestore';
import { db } from '../firebase';
import type { CouponStatus, CouponType } from '../lib/coupons';

/** 付与のきっかけ。運営が「なぜ出たクーポンか」を追えるようにするための情報 */
export type CouponSource = {
  campaign?: string;
  reviewId?: string;
  reservationId?: string;
  refereeUid?: string;
  referrerUid?: string;
  /** 手動付与のときの理由 */
  reason?: string;
  issuedByAdminUid?: string;
};

export type AdminCoupon = {
  id: string;
  userId: string;
  type: CouponType;
  name: string;
  discountAmount: number;
  minAmount: number;
  status: CouponStatus;
  issuedAt: Timestamp | null;
  expiresAt: Timestamp | null;
  usedAt: Timestamp | null;
  usedReservationId: string | null;
  reservedReservationId: string | null;
  source: CouponSource | null;
  cancelReason: string | null;
  statusBeforeCancel: string | null;
};

export type AdminReferral = {
  id: string;
  refereeUid: string;
  referrerUid: string;
  code: string;
  status: string;
  completedLessonCount: number;
  refereeCouponId: string | null;
  referrerCouponId: string | null;
  blocked: boolean;
  blockedReason: string | null;
  createdAt: Timestamp | null;
};

export type AdminAuditLog = {
  id: string;
  action: string;
  adminUid: string;
  reason: string;
  targetUserId: string | null;
  couponId: string | null;
  refereeUid: string | null;
  createdAt: Timestamp | null;
};

function ts(v: unknown): Timestamp | null {
  return v instanceof Timestamp ? v : null;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}
function nullableStr(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

export interface CampaignAdminData {
  coupons: AdminCoupon[];
  referrals: AdminReferral[];
  auditLogs: AdminAuditLog[];
  loading: boolean;
  error: string;
  /** 運営操作のあとに呼んで一覧を最新化する */
  reload: () => void;
}

export function useCampaignAdminData(): CampaignAdminData {
  const [coupons, setCoupons] = useState<AdminCoupon[]>([]);
  const [referrals, setReferrals] = useState<AdminReferral[]>([]);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        setLoading(true);
        setError('');
        const [couponSnap, referralSnap, logSnap] = await Promise.all([
          getDocs(collection(db, 'coupons')),
          getDocs(collection(db, 'referrals')),
          getDocs(collection(db, 'campaignAuditLogs')),
        ]);
        if (!alive) return;

        setCoupons(
          couponSnap.docs
            .map((d) => {
              const x = d.data();
              return {
                id: d.id,
                userId: str(x.userId),
                type: (str(x.type) || 'manual') as CouponType,
                name: str(x.name),
                discountAmount: num(x.discountAmount),
                minAmount: num(x.minAmount),
                status: (str(x.status) || 'available') as CouponStatus,
                issuedAt: ts(x.issuedAt),
                expiresAt: ts(x.expiresAt),
                usedAt: ts(x.usedAt),
                usedReservationId: nullableStr(x.usedReservationId),
                reservedReservationId: nullableStr(x.reservedReservationId),
                source: (x.source as CouponSource | undefined) ?? null,
                cancelReason: nullableStr(x.cancelReason),
                statusBeforeCancel: nullableStr(x.statusBeforeCancel),
              };
            })
            // 発行日の新しい順。発行日が無いものは末尾。
            .sort((a, b) => (b.issuedAt?.toMillis() ?? 0) - (a.issuedAt?.toMillis() ?? 0))
        );

        setReferrals(
          referralSnap.docs
            .map((d) => {
              const x = d.data();
              return {
                id: d.id,
                refereeUid: str(x.refereeUid) || d.id,
                referrerUid: str(x.referrerUid),
                code: str(x.code),
                status: str(x.status),
                completedLessonCount: num(x.completedLessonCount),
                refereeCouponId: nullableStr(x.refereeCouponId),
                referrerCouponId: nullableStr(x.referrerCouponId),
                blocked: x.blocked === true,
                blockedReason: nullableStr(x.blockedReason),
                createdAt: ts(x.createdAt),
              };
            })
            .sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0))
        );

        setAuditLogs(
          logSnap.docs
            .map((d) => {
              const x = d.data();
              return {
                id: d.id,
                action: str(x.action),
                adminUid: str(x.adminUid),
                reason: str(x.reason),
                targetUserId: nullableStr(x.targetUserId),
                couponId: nullableStr(x.couponId),
                refereeUid: nullableStr(x.refereeUid),
                createdAt: ts(x.createdAt),
              };
            })
            .sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0))
        );
      } catch (err) {
        console.error('キャンペーン管理データの取得に失敗しました:', err);
        if (alive) setError('データの取得に失敗しました。');
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [reloadKey]);

  return { coupons, referrals, auditLogs, loading, error, reload };
}
