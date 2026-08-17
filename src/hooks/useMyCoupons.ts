// ログイン中のユーザーに付与されているクーポンを購読する。
//
// クーポンはコードを手入力させず、この一覧から選ばせる方式にしている。
// Firestore ルールで read できるのは本人（と admin）のみ。
import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import type { Coupon } from '../lib/coupons';

type State = {
  coupons: Coupon[];
  loading: boolean;
  error: string;
};

export function useMyCoupons(): State {
  const { user } = useAuth();
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) {
      setCoupons([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    // 期限切れ・使用済みも取得する。予約フォームでは「使えない理由」も
    // 表示する仕様のため、状態で絞り込まずに全件を見る。
    const q = query(collection(db, 'coupons'), where('userId', '==', user.uid));

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Coupon, 'id'>),
        }));
        setCoupons(list);
        setError('');
        setLoading(false);
      },
      (err) => {
        console.error('クーポンの取得に失敗しました', err);
        setError('クーポンの取得に失敗しました。');
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [user]);

  return { coupons, loading, error };
}
