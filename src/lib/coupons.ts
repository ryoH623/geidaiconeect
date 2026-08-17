// クーポンの型と、画面表示用の利用可否判定。
//
// ここでの判定はあくまで表示用。実際の値引きは Cloud Functions 側
// （campaigns.ts の judgeCoupon）が予約作成時に再計算するため、
// この判定をすり抜けてもサーバーで弾かれる。両方の条件を揃えておくこと。
import type { Timestamp } from 'firebase/firestore';

export type CouponStatus =
  | 'available'
  | 'reserved'
  | 'used'
  | 'expired'
  | 'cancelled';

export type CouponType = 'review' | 'referral_referee' | 'referral_referrer';

export type Coupon = {
  id: string;
  userId: string;
  type: CouponType;
  name: string;
  discountAmount: number;
  minAmount: number;
  terms?: string;
  status: CouponStatus;
  expiresAt?: Timestamp | null;
  issuedAt?: Timestamp | null;
};

export type CouponUsability =
  | { usable: true }
  | { usable: false; reason: string };

export function couponExpiryDate(coupon: Coupon): Date | null {
  const ts = coupon.expiresAt;
  if (!ts || typeof ts.toDate !== 'function') return null;
  return ts.toDate();
}

export function formatCouponExpiry(coupon: Coupon): string {
  const d = couponExpiryDate(coupon);
  if (!d) return '—';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日まで`;
}

/**
 * この予約金額でクーポンを使えるか。
 * subtotal は値引き前の合計（レッスン料＋スタジオ代など）。
 */
export function judgeCouponUsable(
  coupon: Coupon,
  subtotal: number,
  now: Date = new Date()
): CouponUsability {
  if (coupon.status === 'used') {
    return { usable: false, reason: '使用済みです' };
  }
  if (coupon.status === 'reserved') {
    return { usable: false, reason: '他のお手続きで使用中です' };
  }
  if (coupon.status === 'cancelled') {
    return { usable: false, reason: '無効化されています' };
  }
  if (coupon.status !== 'available') {
    return { usable: false, reason: '利用できません' };
  }

  const expiry = couponExpiryDate(coupon);
  if (expiry && expiry.getTime() <= now.getTime()) {
    return { usable: false, reason: '有効期限が切れています' };
  }

  if (subtotal < coupon.minAmount) {
    return {
      usable: false,
      reason: `${coupon.minAmount.toLocaleString()}円以上のご予約で利用できます`,
    };
  }

  // サーバー側と同じく、値引き後が Stripe の最小決済額を下回る場合は使えない
  if (subtotal - coupon.discountAmount < 50) {
    return { usable: false, reason: 'この予約金額では利用できません' };
  }

  return { usable: true };
}

/** 一覧の並び順: 使えるものを先に、次に期限が近いものを先に */
export function sortCouponsForPicker(
  coupons: Coupon[],
  subtotal: number
): Coupon[] {
  return [...coupons].sort((a, b) => {
    const ua = judgeCouponUsable(a, subtotal).usable ? 0 : 1;
    const ub = judgeCouponUsable(b, subtotal).usable ? 0 : 1;
    if (ua !== ub) return ua - ub;
    const ea = couponExpiryDate(a)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const eb = couponExpiryDate(b)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return ea - eb;
  });
}
