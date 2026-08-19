// src/pages/teachers/TeacherProfileForm.tsx
// 講師本人がプロフィールとレッスンコースを登録・編集する画面。
//
// 入力の手間を減らすため、決まった選択肢があるもの（レッスン形態・ジャンル・
// タグ・コース名）はすべて選択式にしている。自由入力にしているのは、
// 人によって必ず違う項目（料金・自己紹介・備考）だけ。
//
// 保存は callable（saveMyTeacherProfile）経由。published はここから変えられず、
// 公開するかどうかは運営が決める。
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { useAuth } from "../../contexts/AuthContext";
import {
  MIN_LESSON_PRICE,
  fetchMyTeacherProfile,
  formatPrice,
  type LessonCourse,
  type LessonType,
  type TeacherProfile,
} from "../../lib/teacherProfiles";
import { prefectures } from "../../data/prefectures";
import { citiesByPrefecture } from "../../data/citiesByPrefecture";
import { subjects } from "../../data/subjects";

const LESSON_TYPES: LessonType[] = ["自宅", "スタジオ", "出張", "オンライン"];

/** 講師カードに出せるタグ。アイコンを用意しているものだけを候補にする */
const TAG_OPTIONS = [
  "初心者歓迎",
  "出張可",
  "体験レッスンあり",
  "オンライン対応",
  "子ども対応",
  "受験対応",
  "室内楽対応",
];

/**
 * コース名の候補。
 * 毎回自由に書いてもらうとページごとに表記が揺れるため、よく使う形を用意する。
 * 当てはまらない場合のために自由入力も残す。
 */
const COURSE_TITLE_OPTIONS = [
  "30分レッスン",
  "45分レッスン",
  "60分レッスン",
  "90分レッスン",
  "体験レッスン（30分）",
  "体験レッスン（60分）",
];

const STATUS_LABELS: Record<string, string> = {
  draft: "下書き",
  pending: "公開申請中",
  published: "公開中",
};

type CourseDraft = {
  type: LessonType;
  title: string;
  /** 入力途中は空文字を許すため文字列で持つ */
  price: string;
  note: string;
  locationDisplay: string;
  isTrial: boolean;
};

function toDraft(c: LessonCourse): CourseDraft {
  return {
    type: c.type,
    title: c.title,
    price: c.price ? String(c.price) : "",
    note: c.note || "",
    locationDisplay: c.locationDisplay || "",
    isTrial: c.isTrial === true,
  };
}

const emptyCourse: CourseDraft = {
  type: "自宅",
  title: "60分レッスン",
  price: "",
  note: "",
  locationDisplay: "",
  isTrial: false,
};

const TeacherProfileForm: React.FC = () => {
  const { user } = useAuth();

  const [profile, setProfile] = useState<TeacherProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [name, setName] = useState("");
  const [furigana, setFurigana] = useState("");
  const [prefecture, setPrefecture] = useState("");
  const [city, setCity] = useState("");
  const [genres, setGenres] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [bio, setBio] = useState("");
  const [courses, setCourses] = useState<CourseDraft[]>([]);
  const [onlineAvailable, setOnlineAvailable] = useState(false);
  const [onlinePrice, setOnlinePrice] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const p = await fetchMyTeacherProfile(user.uid);
        if (cancelled) return;

        if (!p) {
          setLoadError(
            "講師プロフィールが見つかりませんでした。運営にお問い合わせください。"
          );
          return;
        }

        setProfile(p);
        setName(p.name);
        setFurigana(p.furigana);
        setPrefecture(p.prefecture);
        setCity(p.city);
        setGenres(p.genres);
        setTags(p.tags || []);
        setBio(p.profile);
        setCourses(p.courses.map(toDraft));
        setOnlineAvailable(p.onlineAvailable === true);
        setOnlinePrice(p.onlineLessonPrice ? String(p.onlineLessonPrice) : "");
      } catch (err) {
        console.error("プロフィールの取得に失敗しました", err);
        if (!cancelled) setLoadError("プロフィールの取得に失敗しました。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  // 市区町村の候補は都道府県に連動させる
  const cityOptions = useMemo(() => {
    const pref = prefectures.find((p) => p.name === prefecture);
    return pref ? citiesByPrefecture[pref.code] || [] : [];
  }, [prefecture]);

  const toggleIn = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

  const updateCourse = (index: number, patch: Partial<CourseDraft>) => {
    setCourses((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...patch } : c))
    );
  };

  const addCourse = () => setCourses((prev) => [...prev, { ...emptyCourse }]);

  const removeCourse = (index: number) => {
    if (!window.confirm("このコースを削除します。よろしいですか？")) return;
    setCourses((prev) => prev.filter((_, i) => i !== index));
  };

  /** 送信前の確認。サーバー側でも同じ検証をしているが、先に気づけるようにする */
  const validate = (submit: boolean): string => {
    if (!name.trim()) return "お名前を入力してください。";

    for (let i = 0; i < courses.length; i += 1) {
      const c = courses[i];
      const label = `${i + 1}件目のコース`;
      if (!c.title.trim()) return `${label}: コース名を入力してください。`;
      const price = Number(c.price);
      if (!c.price.trim() || !Number.isFinite(price)) {
        return `${label}: 料金を入力してください。`;
      }
      if (price < MIN_LESSON_PRICE) {
        return `${label}: 料金は${formatPrice(MIN_LESSON_PRICE)}以上で設定してください。`;
      }
    }

    if (submit && courses.length === 0) {
      return "公開申請にはコースが1件以上必要です。";
    }
    return "";
  };

  const save = async (submit: boolean) => {
    setError("");
    setNotice("");

    const message = validate(submit);
    if (message) {
      setError(message);
      return;
    }

    if (
      submit &&
      !window.confirm(
        "この内容で公開を申請します。運営が確認したうえで公開します。よろしいですか？"
      )
    ) {
      return;
    }

    try {
      setSaving(true);
      const callable = httpsCallable<
        Record<string, unknown>,
        { ok: boolean; teacherId: string; status: string }
      >(functions, "saveMyTeacherProfile");

      const res = await callable({
        name: name.trim(),
        furigana: furigana.trim(),
        prefecture,
        city,
        genres,
        tags,
        profile: bio.trim(),
        courses: courses.map((c) => ({
          type: c.type,
          title: c.title.trim(),
          price: Number(c.price),
          note: c.note.trim(),
          // オンラインは会場がないので送らない
          locationDisplay: c.type === "オンライン" ? "" : c.locationDisplay.trim(),
          isTrial: c.isTrial,
        })),
        onlineAvailable,
        ...(onlineAvailable && onlinePrice.trim()
          ? { onlineLessonPrice: Number(onlinePrice) }
          : {}),
        submit,
      });

      setProfile((prev) =>
        prev ? { ...prev, status: res.data.status as TeacherProfile["status"] } : prev
      );
      setNotice(
        submit
          ? "公開を申請しました。運営が確認のうえ公開します。"
          : "保存しました。"
      );
    } catch (err: any) {
      console.error("保存に失敗しました", err);
      setError(err?.message || "保存に失敗しました。");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <main className="about-section fade-in-up">
        <p style={{ textAlign: "center", marginTop: "2rem" }}>読み込み中です…</p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="about-section fade-in-up">
        <p style={{ textAlign: "center", marginTop: "2rem", color: "#c62828" }}>
          {loadError}
        </p>
      </main>
    );
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 12px",
    borderRadius: 6,
    border: "1px solid #ddd",
  };

  return (
    <main className="about-section fade-in-up">
      <h2 className="centered-heading-with-border">
        <span>プロフィール・コースの登録</span>
      </h2>

      <div style={{ maxWidth: "720px", margin: "2rem auto" }}>
        <p style={{ color: "#8a8270", lineHeight: 1.9 }}>
          現在の状態：
          <strong>{STATUS_LABELS[profile?.status || "draft"]}</strong>
          {profile?.published && "（サイトに掲載中）"}
          <br />
          入力後に「公開を申請する」を押すと、運営が確認したうえでサイトに掲載します。
          保存しただけでは掲載されません。
        </p>

        {/* 基本情報 */}
        <section style={{ marginTop: "2rem" }}>
          <h3>基本情報</h3>
          <div style={{ display: "grid", gap: 12 }}>
            <label>
              お名前
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={inputStyle}
              />
            </label>

            <label>
              ふりがな
              <input
                type="text"
                value={furigana}
                onChange={(e) => setFurigana(e.target.value)}
                style={inputStyle}
              />
            </label>

            <label>
              都道府県
              <select
                value={prefecture}
                onChange={(e) => {
                  setPrefecture(e.target.value);
                  setCity("");
                }}
                style={inputStyle}
              >
                <option value="">選択してください</option>
                {prefectures.map((p) => (
                  <option key={p.code} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              市区町村
              <select
                value={city}
                onChange={(e) => setCity(e.target.value)}
                style={inputStyle}
                disabled={cityOptions.length === 0}
              >
                <option value="">選択してください</option>
                {cityOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        {/* ジャンル */}
        <section style={{ marginTop: "2rem" }}>
          <h3>指導ジャンル</h3>
          <p style={{ fontSize: "0.85rem", color: "#666" }}>
            当てはまるものをすべて選んでください（検索の絞り込みに使われます）。
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {subjects.map((s) => (
              <label
                key={s}
                style={{
                  border: "1px solid #ddd",
                  borderRadius: 20,
                  padding: "4px 12px",
                  cursor: "pointer",
                  background: genres.includes(s) ? "#efe9db" : "#fff",
                }}
              >
                <input
                  type="checkbox"
                  checked={genres.includes(s)}
                  onChange={() => setGenres((prev) => toggleIn(prev, s))}
                  style={{ marginRight: 6 }}
                />
                {s}
              </label>
            ))}
          </div>
        </section>

        {/* タグ */}
        <section style={{ marginTop: "2rem" }}>
          <h3>特徴タグ</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {TAG_OPTIONS.map((t) => (
              <label
                key={t}
                style={{
                  border: "1px solid #ddd",
                  borderRadius: 20,
                  padding: "4px 12px",
                  cursor: "pointer",
                  background: tags.includes(t) ? "#efe9db" : "#fff",
                }}
              >
                <input
                  type="checkbox"
                  checked={tags.includes(t)}
                  onChange={() => setTags((prev) => toggleIn(prev, t))}
                  style={{ marginRight: 6 }}
                />
                {t}
              </label>
            ))}
          </div>
        </section>

        {/* 自己紹介 */}
        <section style={{ marginTop: "2rem" }}>
          <h3>自己紹介</h3>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={6}
            maxLength={2000}
            placeholder="ご経歴や指導方針をご記入ください。"
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </section>

        {/* コース */}
        <section style={{ marginTop: "2rem" }}>
          <h3>レッスンコース</h3>
          <p style={{ fontSize: "0.85rem", color: "#666", lineHeight: 1.8 }}>
            料金は{formatPrice(MIN_LESSON_PRICE)}以上で設定してください。
            <br />
            体験レッスンに指定したコースは、生徒1人につき1回のみ予約できます。
          </p>

          {courses.length === 0 && (
            <p style={{ color: "#8a8270" }}>
              コースがまだありません。「コースを追加」から登録してください。
            </p>
          )}

          {courses.map((c, i) => (
            <div
              key={i}
              style={{
                border: "1px solid #ddd",
                borderRadius: 10,
                padding: "16px",
                marginBottom: "12px",
                background: "#fff",
                display: "grid",
                gap: 10,
              }}
            >
              <div
                style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
              >
                <strong>コース {i + 1}</strong>
                <button
                  type="button"
                  onClick={() => removeCourse(i)}
                  style={{
                    border: "none",
                    background: "none",
                    color: "#c62828",
                    cursor: "pointer",
                  }}
                >
                  削除
                </button>
              </div>

              <label>
                レッスン形態
                <select
                  value={c.type}
                  onChange={(e) =>
                    updateCourse(i, { type: e.target.value as LessonType })
                  }
                  style={inputStyle}
                >
                  {LESSON_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                コース名
                <select
                  value={
                    COURSE_TITLE_OPTIONS.includes(c.title) ? c.title : "__custom__"
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    updateCourse(i, { title: v === "__custom__" ? "" : v });
                  }}
                  style={inputStyle}
                >
                  {COURSE_TITLE_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                  <option value="__custom__">その他（自由入力）</option>
                </select>
                {!COURSE_TITLE_OPTIONS.includes(c.title) && (
                  <input
                    type="text"
                    value={c.title}
                    onChange={(e) => updateCourse(i, { title: e.target.value })}
                    placeholder="コース名を入力"
                    style={{ ...inputStyle, marginTop: 6 }}
                  />
                )}
              </label>

              <label>
                料金（円）
                <input
                  type="number"
                  inputMode="numeric"
                  min={MIN_LESSON_PRICE}
                  step={500}
                  value={c.price}
                  onChange={(e) => updateCourse(i, { price: e.target.value })}
                  placeholder={String(MIN_LESSON_PRICE)}
                  style={inputStyle}
                />
                {c.price &&
                  Number(c.price) > 0 &&
                  Number(c.price) < MIN_LESSON_PRICE && (
                    <span style={{ color: "#c62828", fontSize: "0.85rem" }}>
                      {formatPrice(MIN_LESSON_PRICE)}以上で設定してください。
                    </span>
                  )}
              </label>

              {c.type !== "オンライン" && (
                <label>
                  実施場所の表示（任意）
                  <input
                    type="text"
                    value={c.locationDisplay}
                    onChange={(e) =>
                      updateCourse(i, { locationDisplay: e.target.value })
                    }
                    placeholder="例: 東京都世田谷区桜新町"
                    style={inputStyle}
                  />
                </label>
              )}

              <label>
                備考（任意）
                <input
                  type="text"
                  value={c.note}
                  onChange={(e) => updateCourse(i, { note: e.target.value })}
                  placeholder="例: スタジオ代込み"
                  style={inputStyle}
                />
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="checkbox"
                  checked={c.isTrial}
                  onChange={(e) => updateCourse(i, { isTrial: e.target.checked })}
                />
                体験レッスンにする（生徒1人につき1回まで）
              </label>
            </div>
          ))}

          <button type="button" className="form-button" onClick={addCourse}>
            コースを追加
          </button>
        </section>

        {/* オンライン対応 */}
        <section style={{ marginTop: "2rem" }}>
          <h3>オンラインレッスン</h3>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={onlineAvailable}
              onChange={(e) => setOnlineAvailable(e.target.checked)}
            />
            オンラインレッスンに対応する
          </label>
          {onlineAvailable && (
            <p style={{ fontSize: "0.85rem", color: "#666", lineHeight: 1.8 }}>
              上のコースにオンラインを登録していない場合、
              オンラインレッスン（60分）を自動で追加します。料金を指定しない場合は既定額になります。
            </p>
          )}
          {onlineAvailable && (
            <label>
              オンラインの料金（円・任意）
              <input
                type="number"
                inputMode="numeric"
                min={MIN_LESSON_PRICE}
                step={500}
                value={onlinePrice}
                onChange={(e) => setOnlinePrice(e.target.value)}
                style={inputStyle}
              />
            </label>
          )}
        </section>

        {error && (
          <p style={{ color: "#c62828", marginTop: "1.5rem" }}>{error}</p>
        )}
        {notice && (
          <p style={{ color: "#2e7d32", marginTop: "1.5rem" }}>{notice}</p>
        )}

        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            marginTop: "1.5rem",
          }}
        >
          <button
            type="button"
            className="form-button"
            onClick={() => save(false)}
            disabled={saving}
          >
            {saving ? "保存中..." : "保存する（下書き）"}
          </button>
          <button
            type="button"
            className="form-button"
            onClick={() => save(true)}
            disabled={saving}
          >
            {saving ? "送信中..." : "公開を申請する"}
          </button>
        </div>

        <div style={{ textAlign: "center", marginTop: "2rem" }}>
          <Link to="/schedule-list" className="form-button">
            スケジュール管理へ
          </Link>
        </div>
      </div>
    </main>
  );
};

export default TeacherProfileForm;
