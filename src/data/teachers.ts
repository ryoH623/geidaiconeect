// ⚠️ このファイルは Firestore（teacherProfiles）への移行用シードです。
//
// 表示・予約に使う講師データの正は Firestore にあります。画面から読むときは
// src/lib/teacherProfiles.ts と src/hooks/useTeachers.ts を使ってください。
// ここを編集してもサイトには反映されません（/admin/teacher-profiles で取り込んだ時のみ）。

export interface Teacher {
  /** 講師詳細ページ（/teachers/:id）で使う URL 用スラッグ。authUid は未連携の講師がいるため使わない */
  id: string;
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
  /**
   * オンラインレッスンに対応できるか。
   *
   * 講師応募フォーム（/recruit）の「希望レッスン形態」でオンラインを選んだ講師に true を立てる。
   * true にすると、courses にオンラインのコースが自動で追加される（getCourses を参照）。
   * 対応可否は講師ごとに違うため、既定は未対応（false 相当）。
   */
  onlineAvailable?: boolean;
  /** 自動追加されるオンラインコースの料金。未指定なら DEFAULT_ONLINE_LESSON_PRICE を使う */
  onlineLessonPrice?: string;
}

/**
 * レッスンの実施方法。
 * オンラインはビデオ通話で行うため会場がなく、URL はレッスン確定後に講師が登録する。
 */
export type LessonType = "自宅" | "スタジオ" | "出張" | "オンライン";

export interface LessonCourse {
  type: LessonType;
  title: string;
  price: string;
  note?: string;
  locationDisplay?: string;
  /** 体験レッスンか。true のコースは生徒1人につき1回まで（受講後は選択・表示されない）。 */
  isTrial?: boolean;
}

/**
 * オンラインコースを自動追加するときの既定料金。
 * 講師ごとに変える場合は Teacher.onlineLessonPrice を指定する。
 */
export const DEFAULT_ONLINE_LESSON_PRICE = "5,000円";

/** 自動追加されるオンラインコースの内容。会場がないため locationDisplay は持たない */
function buildOnlineCourse(teacher: Teacher): LessonCourse {
  return {
    type: "オンライン",
    title: "オンラインレッスン（60分）",
    price: teacher.onlineLessonPrice || DEFAULT_ONLINE_LESSON_PRICE,
    note: "ビデオ通話で実施します。参加URLは予約確定後にご案内します。",
  };
}

/**
 * 表示・予約に使うコース一覧。
 *
 * teacher.courses をそのまま読まずに必ずこの関数を通すこと。
 * onlineAvailable が true の講師には、オンラインコースをここで自動的に足している。
 * ただし courses にオンラインのコースを明示的に書いている場合は、そちらを優先する
 * （料金や条件を個別に決めている講師の設定を上書きしないため）。
 */
export function getCourses(teacher: Teacher): LessonCourse[] {
  if (!teacher.onlineAvailable) return teacher.courses;
  if (teacher.courses.some((c) => c.type === "オンライン")) return teacher.courses;
  return [...teacher.courses, buildOnlineCourse(teacher)];
}

export const teachers: Teacher[] = [
  {
    id: "yosuke-inda",
    authUid: "",
    name: "印田 陽介",
    furigana: "いんだ ようすけ",
    prefecture: "東京都",
    city: "世田谷区",
    genres: ["チェロ"],
    tags: ["初心者歓迎", "体験レッスンあり", "出張可"],
    profile:
      "東京藝術大学音楽学部卒業。桐朋オーケストラアカデミー研修課程修了。現在はフリーランス奏者として活動中。",
    photo: "/yosuke.jpg",
    courses: [
      {
        type: "自宅",
        title: "60分レッスン",
        price: "6,000円",
        locationDisplay: "東京都世田谷区桜新町",
      },
      {
        type: "自宅",
        title: "30分レッスン（小学生以下・初回体験）",
        price: "4,000円",
        locationDisplay: "東京都世田谷区桜新町",
        isTrial: true,
      },
      {
        type: "自宅",
        title: "室内楽レッスン（60分）",
        price: "10,000円",
        locationDisplay: "東京都世田谷区桜新町",
      },
      {
        type: "自宅",
        title: "室内楽レッスン 延長（60分）",
        price: "6,000円",
        locationDisplay: "東京都世田谷区桜新町",
      },
      {
        type: "スタジオ",
        title: "スタジオレッスン（60分）",
        price: "7,000円",
        note: "スタジオ代別・応相談",
      },
      {
        type: "出張",
        title: "出張レッスン（60分）",
        price: "8,000円",
        note: "東京都内中心・応相談",
      },
    ],
  },
  {
    id: "hitoshi-takaoka",
    authUid: "ytfhgycQIkTfqEvQCN5uDpjSHgw2",
    name: "高岡 準",
    furigana: "たかおか ひとし",
    prefecture: "埼玉県",
    city: "さいたま市浦和区",
    genres: ["ピアノ"],
    tags: ["初心者歓迎"],
    profile:
      "東京藝術大学卒業後、国内外で演奏活動を行う。教育にも力を入れ、地域の音楽教育に貢献。",
    photo: "/hitoshi.jpg",
    // 応募時にオンライン希望あり。料金を個別に決めているため courses に明示しており、
    // 自動追加ではなくそちらが使われる。
    onlineAvailable: true,
    courses: [
      {
        type: "自宅",
        title: "60分レッスン",
        price: "5,000円",
        locationDisplay: "埼玉県さいたま市浦和区領家",
      },
      {
        type: "スタジオ",
        title: "スタジオレッスン（60分）",
        price: "6,000円",
        note: "浦和駅近くの音楽スタジオにて（スタジオ代込）",
      },
      {
        type: "出張",
        title: "出張レッスン（60分）",
        price: "7,000円",
        note: "埼玉県南部を中心に対応",
      },
      {
        type: "オンライン",
        title: "オンラインレッスン（60分）",
        price: "4,500円",
        note: "ビデオ通話で実施します。参加URLは予約確定後にご案内します。",
      },
    ],
  },
];