// 公開中の講師一覧を読むフック。
//
// トップ・検索・講師詳細・予約フォームがどれも同じ一覧を必要とするため、
// 取得結果をモジュールスコープに持ち、ページを移動するたびに読み直さないようにする。
// 静的ファイルを読んでいた頃と体感を近づけるための措置。
import { useEffect, useState } from 'react';
import {
  fetchPublishedTeachers,
  type TeacherProfile,
} from '../lib/teacherProfiles';

/** 取得済みの一覧。タブを開いている間だけ保持する */
let cache: TeacherProfile[] | null = null;
/** 同時に複数の画面から呼ばれても取得は1回で済ませる */
let inFlight: Promise<TeacherProfile[]> | null = null;

async function load(): Promise<TeacherProfile[]> {
  if (cache) return cache;
  if (!inFlight) {
    inFlight = fetchPublishedTeachers()
      .then((list) => {
        cache = list;
        return list;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** 講師データを更新した後に呼ぶと、次の取得で読み直される */
export function invalidateTeachersCache(): void {
  cache = null;
}

type State = {
  teachers: TeacherProfile[];
  loading: boolean;
  error: string;
};

export function useTeachers(): State {
  const [teachers, setTeachers] = useState<TeacherProfile[]>(cache || []);
  const [loading, setLoading] = useState(cache === null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    if (cache) {
      setTeachers(cache);
      setLoading(false);
      return;
    }

    setLoading(true);
    load()
      .then((list) => {
        if (cancelled) return;
        setTeachers(list);
        setError('');
      })
      .catch((err) => {
        console.error('講師一覧の取得に失敗しました', err);
        if (!cancelled) setError('講師情報の取得に失敗しました。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { teachers, loading, error };
}
