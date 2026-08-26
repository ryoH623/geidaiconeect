// src/pages/TeacherDetail.tsx
// 講師詳細ページ（/teachers/:id）。静的データ（src/data/teachers.ts）から表示する。
import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTeachers } from "../hooks/useTeachers";
import { getCourses } from "../lib/teacherProfiles";
import type { LessonCourse } from "../lib/teacherProfiles";
import ReviewList from "../components/ReviewList";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
// アイコンは実体を渡す。文字列名での指定は library.add による登録が前提で、
// このプロジェクトでは登録していないため描画されない。
import { faLocationDot } from "@fortawesome/free-solid-svg-icons";
import { tagIconMap } from "../utils/tagIconMap";
import { buildReserveUrl } from "../utils/reserveUrl";
import { useAuth } from "../contexts/AuthContext";
import { db } from "../firebase";
import { collection, getDocs, query, where } from "firebase/firestore";
import "../index.css";

const TeacherDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  // 講師データは Firestore（公開中のみ）から読む
  const { teachers, loading: teachersLoading } = useTeachers();
  const teacher = teachers.find((t) => t.id === id) || null;

  // 表示・予約に使うコース一覧。オンライン対応の講師には
  // getCourses がオンラインコースを自動で足す。teacher.courses を直接読まないこと。
  const courses = teacher ? getCourses(teacher) : [];

  // 予約フォームからブラウザバックで戻ってきたときにコース選択をやり直さずに済むよう、
  // 選択中のコースをタブ内で保持する（コース名で保存し、閉じれば消える）。
  const courseStorageKey = teacher ? `teacherDetail:course:${teacher.id}` : "";

  const [selectedCourse, setSelectedCourse] = useState<LessonCourse | null>(null);

  // 講師データは非同期で届くため、届いてから保存済みの選択を復元する。
  // useState の初期化時点ではコース一覧がまだ空になる。
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (restored || !courseStorageKey || courses.length === 0) return;
    setRestored(true);

    try {
      const savedTitle = sessionStorage.getItem(courseStorageKey);
      if (!savedTitle) return;
      const found = courses.find((c) => c.title === savedTitle);
      if (found) setSelectedCourse(found);
    } catch {
      // sessionStorage が使えない環境では復元しないだけでよい
    }
  }, [restored, courseStorageKey, courses]);

  useEffect(() => {
    if (!courseStorageKey || !restored) return;

    try {
      if (selectedCourse) sessionStorage.setItem(courseStorageKey, selectedCourse.title);
      else sessionStorage.removeItem(courseStorageKey);
    } catch (error) {
      console.warn("コース選択の保存に失敗しました:", error);
    }
  }, [courseStorageKey, selectedCourse, restored]);

  // 体験レッスンは生徒1人につき1回まで。この講師で既に体験を受講済みかどうかを判定する。
  // （確定済み＝confirmed の予約で、コース名が体験コースのものがあれば「受講済み」）
  const [trialUsed, setTrialUsed] = useState(false);

  useEffect(() => {
    if (!teacher || !teacher.authUid || !user) {
      setTrialUsed(false);
      return;
    }
    const trialTitles = courses
      .filter((c) => c.isTrial)
      .map((c) => c.title);
    if (trialTitles.length === 0) {
      setTrialUsed(false);
      return;
    }

    let alive = true;
    (async () => {
      try {
        const q = query(
          collection(db, "reservations"),
          where("userId", "==", user.uid)
        );
        const snap = await getDocs(q);
        const used = snap.docs.some((docSnap) => {
          const r = docSnap.data();
          return (
            r.teacherId === teacher.authUid &&
            r.reservationStatus === "confirmed" &&
            trialTitles.includes(r.lessonCourse)
          );
        });
        if (alive) setTrialUsed(used);
      } catch (error) {
        console.error("体験レッスンの受講判定に失敗しました:", error);
      }
    })();
    return () => {
      alive = false;
    };
  }, [teacher, user]);

  // 受講済みで、復元された選択が体験コースだった場合は選択を解除する。
  useEffect(() => {
    if (trialUsed && selectedCourse?.isTrial) setSelectedCourse(null);
  }, [trialUsed, selectedCourse]);

  if (teachersLoading) {
    return (
      <main className="about-section fade-in-up">
        <p style={{ textAlign: "center", margin: "2rem 0" }}>
          講師情報を読み込んでいます…
        </p>
      </main>
    );
  }

  if (!teacher) {
    return (
      <main className="about-section fade-in-up">
        <h2 className="centered-heading-with-border">
          <span>講師詳細</span>
        </h2>
        <p style={{ textAlign: "center", margin: "2rem 0" }}>
          講師が見つかりませんでした。
        </p>
        <div style={{ textAlign: "center" }}>
          <Link to="/" className="form-button">
            トップページへ戻る
          </Link>
        </div>
      </main>
    );
  }

  const canReserve = !!teacher.authUid;

  const handleReserveClick = () => {
    if (!selectedCourse) return;

    if (!canReserve) {
      alert("この講師のオンライン予約は現在準備中です。");
      return;
    }

    const reserveUrl = buildReserveUrl(teacher, selectedCourse);

    if (!user) {
      // 未ログイン時はログイン後に予約フォームへ戻す
      sessionStorage.setItem("redirectAfterLogin", reserveUrl);
      navigate("/login");
      return;
    }

    navigate(reserveUrl);
  };

  // 講師ごとの構造化データ（検索エンジン向け）
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Person",
    name: teacher.name,
    jobTitle: `${teacher.genres.join("・")}講師`,
    alumniOf: "東京藝術大学",
    address: {
      "@type": "PostalAddress",
      addressRegion: teacher.prefecture,
      addressLocality: teacher.city,
    },
    url: `https://geidaiconnect.com/teachers/${teacher.id}`,
  });

  return (
    <main
      className="fade-in-up"
      style={{ maxWidth: "900px", margin: "0 auto", paddingTop: "120px" /* 固定ヘッダー(120px)分 */ }}
    >
      {/* React 19 が <head> に巻き上げる */}
      <title>{`${teacher.name}（${teacher.genres.join("・")}）｜GeidaiConnect`}</title>
      <script type="application/ld+json">{jsonLd}</script>
      <div className="teacher-profile">
        <div className="teacher-header">
          <div className="teacher-info">
            <div className="teacher-name-row">
              <h2 className="teacher-name">{teacher.name}</h2>
              <span className="teacher-kana">{teacher.furigana}</span>

              <div className="teacher-tags">
                {teacher.tags?.map((tag: string, index: number) => (
                  <span key={index} className="tag">
                    {tagIconMap[tag] && (
                      <FontAwesomeIcon
                        icon={tagIconMap[tag]}
                        style={{ marginRight: "0.3rem" }}
                      />
                    )}
                    {tag}
                  </span>
                ))}
              </div>
            </div>

            <p className="teacher-genre">{teacher.genres.join("、")}</p>
            <p style={{ color: "#666" }}>
              {teacher.prefecture} {teacher.city}
            </p>
          </div>

          {teacher.photo && (
            <img
              src={teacher.photo}
              alt={`${teacher.name}の写真`}
              className="teacher-image"
            />
          )}
        </div>

        <p className="profile">
          {teacher.profile.split("\n").map((line: string, i: number) => (
            <span key={i}>
              {line}
              <br />
            </span>
          ))}
        </p>

        {courses.length > 0 && (
          <div className="course-table">
            <h4>レッスンコース</h4>
            {/* 表ではなくカードで並べる。スマホでは表の列幅が足りず、
                コース名が語の途中で折り返して読みづらかった。 */}
            <form className="course-list">
              {courses
                .filter((course) => !(course.isTrial && trialUsed))
                .map((course, i) => {
                  const selected = selectedCourse?.title === course.title;
                  return (
                    <label
                      key={i}
                      className={`course-card${selected ? " is-selected" : ""}`}
                    >
                      <input
                        type="radio"
                        name="course"
                        value={course.title}
                        checked={selected}
                        onChange={() => setSelectedCourse(course)}
                      />

                      <div className="course-card-head">
                        <span className="course-card-type">{course.type}</span>
                        {course.isTrial && (
                          <span className="course-card-type course-card-trial">
                            体験
                          </span>
                        )}
                      </div>

                      <p className="course-card-title">{course.title}</p>

                      <div className="course-card-price">
                        {course.price.toLocaleString()}
                        <span className="unit">円</span>
                      </div>

                      {course.locationDisplay && (
                        <p className="course-card-meta">
                          <FontAwesomeIcon icon={faLocationDot} />
                          <span>{course.locationDisplay}</span>
                        </p>
                      )}

                      {course.note && (
                        <p className="course-card-note">{course.note}</p>
                      )}
                    </label>
                  );
                })}
            </form>
            {/* 出張コースがある場合のみ、どこまで来てもらえるかを示す */}
            {teacher.travelRange && courses.some((c) => c.type === "出張") && (
              <p style={{ fontSize: "0.85rem", color: "#8a8270", marginTop: "0.5rem" }}>
                ※出張レッスンの対応範囲：{teacher.travelRange}
              </p>
            )}
            {trialUsed && courses.some((c) => c.isTrial) && (
              <p style={{ fontSize: "0.85rem", color: "#8a8270", marginTop: "0.5rem" }}>
                ※体験レッスンは1回のみです。受講済みのため一覧に表示していません。
              </p>
            )}
          </div>
        )}

        <div className="reserve-cta-block">
          <button
            onClick={handleReserveClick}
            className="reserve-button"
            disabled={!canReserve || !selectedCourse}
          >
            このコースで予約する
          </button>
          {!selectedCourse ? (
            <p className="reserve-cta-hint">
              上の表からご希望のコースを選択してください。
            </p>
          ) : !canReserve ? (
            <p className="reserve-cta-hint">
              この講師のオンライン予約は現在準備中です。お問い合わせフォームからご相談ください。
            </p>
          ) : null}
        </div>

        <div className="review-button-wrapper">
          <button
            className="review-link-button"
            onClick={() =>
              navigate(
                `/mypage/review?teacher=${encodeURIComponent(teacher.name)}`
              )
            }
          >
            この講師にレビューを書く
          </button>
        </div>

        {/* レビューは既存データとの互換のため講師名をキーにしている */}
        <ReviewList teacherId={teacher.name} teacherAuthUid={teacher.authUid} />
      </div>
    </main>
  );
};

export default TeacherDetail;
