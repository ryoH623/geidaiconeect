// 講師プロフィールとコースのデータ層（Firestore の teacherProfiles コレクション）。
//
// もともと講師データは src/data/teachers.ts に静的に持っていたが、
// 講師が自分でコースを作れるようにするため Firestore へ移した。
// 静的ファイルは移行用のシードとしてのみ残している。
//
// 表示に使ってよいのは published が true のものだけ。講師が編集しただけでは
// 公開されず、運営が公開操作をして初めてサイトに出る（事故の防止）。
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../firebase';

export const TEACHER_PROFILES = 'teacherProfiles';

/** レッスンの実施方法。オンラインは会場を持たない */
export type LessonType = '自宅' | 'スタジオ' | '出張' | 'オンライン';

/**
 * レッスン料の下限。
 *
 * 手数料が逓減制（18%→15%→10%）のため、極端に安い設定をされると
 * 手数料が運営コストを下回る。金額は自由入力にするが、ここだけは守らせる。
 */
export const MIN_LESSON_PRICE = 3000;

/** 自動追加されるオンラインコースの既定料金 */
export const DEFAULT_ONLINE_LESSON_PRICE = 5000;

export interface LessonCourse {
  type: LessonType;
  title: string;
  /** 円。表示は formatPrice を通す */
  price: number;
  note?: string;
  locationDisplay?: string;
  /** 体験レッスンか。true のコースは生徒1人につき1回まで */
  isTrial?: boolean;
}

/** 公開状態。draft と pending はサイトに出ない */
export type TeacherStatus = 'draft' | 'pending' | 'published';

export interface TeacherProfile {
  /** ドキュメントID。講師詳細ページ（/teachers/:id）の URL に使うスラッグ */
  id: string;
  /** Firebase Auth の UID。予約・スケジュールはこれをキーに動く */
  authUid: string;
  name: string;
  furigana: string;
  prefecture: string;
  city: string;
  genres: string[];
  tags?: string[];
  profile: string;
  photo: string;
  courses: LessonCourse[];
  /** オンライン対応可なら、オンラインコースを自動で足す（getCourses 参照） */
  onlineAvailable?: boolean;
  onlineLessonPrice?: number;
  /** サイトに出てよいか。運営の公開操作でのみ true になる */
  published: boolean;
  status: TeacherStatus;
}

/** 表示用の金額文字列（例: 6,000円） */
export function formatPrice(price: number): string {
  return `${price.toLocaleString()}円`;
}

/** 自動追加されるオンラインコースの内容。会場がないため locationDisplay を持たない */
function buildOnlineCourse(teacher: TeacherProfile): LessonCourse {
  return {
    type: 'オンライン',
    title: 'オンラインレッスン（60分）',
    price: teacher.onlineLessonPrice || DEFAULT_ONLINE_LESSON_PRICE,
    note: 'ビデオ通話で実施します。参加URLは予約確定後にご案内します。',
  };
}

/**
 * 表示・予約に使うコース一覧。
 *
 * courses をそのまま読まずに必ずこの関数を通すこと。
 * onlineAvailable が true の講師にはオンラインコースをここで足している。
 * ただし courses にオンラインを明示している場合はそちらを優先する
 * （料金を個別に決めている講師の設定を上書きしないため）。
 */
export function getCourses(teacher: TeacherProfile): LessonCourse[] {
  if (!teacher.onlineAvailable) return teacher.courses;
  if (teacher.courses.some((c) => c.type === 'オンライン')) return teacher.courses;
  return [...teacher.courses, buildOnlineCourse(teacher)];
}

/** コース最安値の表示（例: 4,000円〜）。コースが無ければ null */
export function minCoursePriceLabel(teacher: TeacherProfile): string | null {
  const prices = getCourses(teacher)
    .map((c) => c.price)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (prices.length === 0) return null;
  return `${Math.min(...prices).toLocaleString()}円〜`;
}

/** Firestore のドキュメントを TeacherProfile に整える。欠けている項目は既定値で埋める */
export function toTeacherProfile(id: string, d: Record<string, unknown>): TeacherProfile {
  const courses = Array.isArray(d.courses) ? d.courses : [];
  return {
    id,
    authUid: typeof d.authUid === 'string' ? d.authUid : '',
    name: typeof d.name === 'string' ? d.name : '',
    furigana: typeof d.furigana === 'string' ? d.furigana : '',
    prefecture: typeof d.prefecture === 'string' ? d.prefecture : '',
    city: typeof d.city === 'string' ? d.city : '',
    genres: Array.isArray(d.genres) ? (d.genres as string[]) : [],
    tags: Array.isArray(d.tags) ? (d.tags as string[]) : [],
    profile: typeof d.profile === 'string' ? d.profile : '',
    photo: typeof d.photo === 'string' ? d.photo : '',
    courses: courses.map((c) => {
      const course = c as Record<string, unknown>;
      return {
        type: (course.type as LessonType) || '自宅',
        title: typeof course.title === 'string' ? course.title : '',
        // 旧データが文字列（"6,000円"）で入っている場合に備えて数値へ寄せる
        price:
          typeof course.price === 'number'
            ? course.price
            : parseInt(String(course.price ?? '').replace(/[^0-9]/g, ''), 10) || 0,
        note: typeof course.note === 'string' ? course.note : undefined,
        locationDisplay:
          typeof course.locationDisplay === 'string'
            ? course.locationDisplay
            : undefined,
        isTrial: course.isTrial === true,
      };
    }),
    onlineAvailable: d.onlineAvailable === true,
    onlineLessonPrice:
      typeof d.onlineLessonPrice === 'number' ? d.onlineLessonPrice : undefined,
    published: d.published === true,
    status: (d.status as TeacherStatus) || 'draft',
  };
}

/**
 * 公開中の講師をすべて取得する。
 *
 * 絞り込みは published の等価条件のみ。範囲条件を混ぜると複合インデックスが
 * 必要になるため、並べ替えは取得後にメモリ上で行う。
 */
export async function fetchPublishedTeachers(): Promise<TeacherProfile[]> {
  const q = query(collection(db, TEACHER_PROFILES), where('published', '==', true));
  const snap = await getDocs(q);
  return snap.docs.map((d) => toTeacherProfile(d.id, d.data()));
}

/** 運営用。未公開も含めて全件取得する */
export async function fetchAllTeachers(): Promise<TeacherProfile[]> {
  const snap = await getDocs(collection(db, TEACHER_PROFILES));
  return snap.docs.map((d) => toTeacherProfile(d.id, d.data()));
}

/** 1件取得。見つからなければ null */
export async function fetchTeacher(id: string): Promise<TeacherProfile | null> {
  const snap = await getDoc(doc(db, TEACHER_PROFILES, id));
  if (!snap.exists()) return null;
  return toTeacherProfile(snap.id, snap.data());
}
