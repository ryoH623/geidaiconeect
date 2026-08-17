// 管理画面でクーポン・紹介の内部値を日本語表示に変換する。
// 一覧・ユーザー別履歴の両方から使うため1か所にまとめている。
import type { Timestamp } from 'firebase/firestore';
import type { CouponStatus, CouponType } from './coupons';
import type { AdminCoupon } from '../hooks/useCampaignAdminData';

export const COUPON_STATUS_LABEL: Record<CouponStatus, string> = {
  available: '利用可能',
  reserved: '仮押さえ中',
  used: '使用済み',
  expired: '期限切れ',
  cancelled: '無効化',
};

export const COUPON_TYPE_LABEL: Record<CouponType, string> = {
  review: 'レビュー投稿',
  referral_referee: '友達紹介（被紹介者）',
  referral_referrer: '友達紹介（紹介者）',
  manual: '運営手動付与',
};

export const REFERRAL_STATUS_LABEL: Record<string, string> = {
  pending: '登録済み（特典待ち）',
  first_lesson_done: '初回完了（被紹介者に付与済み）',
  reward_granted: '3回完了（紹介者に付与済み）',
};

export function couponStatusColor(status: CouponStatus): string {
  switch (status) {
    case 'available':
      return '#2e7d32';
    case 'used':
      return '#555';
    case 'reserved':
      return '#ef6c00';
    case 'cancelled':
      return '#c62828';
    default:
      return '#8a8270';
  }
}

export function formatTimestamp(ts: Timestamp | null): string {
  if (!ts) return '―';
  const d = ts.toDate();
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 発行理由。キャンペーン由来のものは種別から、手動付与は入力された理由をそのまま出す。
 * 紹介特典は「誰の紹介によるものか」まで分かると調査しやすいので、
 * 呼び出し側から uid → 表示名の解決関数を渡してもらう。
 */
export function couponReasonText(
  coupon: AdminCoupon,
  displayNameOf: (uid: string) => string
): string {
  const src = coupon.source ?? {};

  if (coupon.type === 'manual') {
    return src.reason ? `運営手動付与: ${src.reason}` : '運営手動付与';
  }
  if (coupon.type === 'review') {
    return src.reservationId
      ? `レビュー投稿キャンペーン（予約 ${src.reservationId}）`
      : 'レビュー投稿キャンペーン';
  }
  if (coupon.type === 'referral_referee') {
    const referrer = src.referrerUid ? displayNameOf(src.referrerUid) : '';
    return referrer
      ? `友達紹介 被紹介者特典（紹介者: ${referrer}）`
      : '友達紹介 被紹介者特典';
  }
  if (coupon.type === 'referral_referrer') {
    const referee = src.refereeUid ? displayNameOf(src.refereeUid) : '';
    return referee
      ? `友達紹介 紹介者特典（被紹介者: ${referee}）`
      : '友達紹介 紹介者特典';
  }
  return src.campaign ?? '―';
}

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  coupon_issued: 'クーポン手動付与',
  coupon_cancelled: 'クーポン無効化',
  referral_blocked: '紹介を無効化',
  referral_unblocked: '紹介の無効化を解除',
};
