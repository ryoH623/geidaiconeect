// 検索結果ページ（/search?keyword=&category=）。
// レイアウトは他ページに合わせ、白カード枠＋中央見出し＋トップページと同じ講師カードで表示する。
// 各カードはクリックで講師詳細（/teachers/:id）へ遷移する。
import React, { useEffect } from "react";
import { useLocation, Link } from "react-router-dom";
import { useTeachers } from "../hooks/useTeachers";
import { minCoursePriceLabel } from "../lib/teacherProfiles";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { tagIconMap } from "../utils/tagIconMap";
import { useAuth } from "../contexts/AuthContext";
import { logSearch } from "../lib/searchLog";
import "../index.css";

const SearchResults: React.FC = () => {
  // 講師データは Firestore（公開中のみ）から読む
  const { teachers, loading: teachersLoading } = useTeachers();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const rawKeyword = searchParams.get("keyword") || "";
  const keyword = rawKeyword.toLowerCase();
  const category = searchParams.get("category") || "";

  const filteredTeachers = teachers.filter((teacher) => {
    const name = teacher.name?.toLowerCase() || "";
    const profile = teacher.profile?.toLowerCase() || "";
    const matchKeyword = keyword
      ? name.includes(keyword) || profile.includes(keyword)
      : true;
    const matchCategory = category ? teacher.genres.includes(category) : true;
    return matchKeyword && matchCategory;
  });

  const conditions = [
    category && `ジャンル：${category}`,
    rawKeyword && `キーワード：${rawKeyword}`,
  ]
    .filter(Boolean)
    .join(" / ");

  // 検索条件と結果件数を記録する。0件の検索は「取りこぼした需要」そのもので、
  // どの分野の講師を増やすべきかの判断材料になる。
  // 運営自身の検索は数字を歪めるので除外する。
  const { role, loading: authLoading } = useAuth();
  const resultCount = filteredTeachers.length;

  useEffect(() => {
    if (authLoading) return;
    // 読み込み中は結果が0件に見える。ここで記録すると実在しない0件検索が混ざる
    if (teachersLoading) return;
    if (role === "admin") return;
    logSearch({ keyword: rawKeyword, category, resultCount });
  }, [rawKeyword, category, resultCount, role, authLoading, teachersLoading]);

  return (
    <main className="about-section fade-in-up">
      <h2 className="centered-heading-with-border">
        <span>該当する講師一覧</span>
      </h2>

      {conditions && (
        <p style={{ textAlign: "center", color: "#8a8270", marginTop: "-0.5rem" }}>
          {conditions}（{filteredTeachers.length}名）
        </p>
      )}

      {teachersLoading ? (
        <p style={{ textAlign: "center" }}>講師情報を読み込んでいます…</p>
      ) : filteredTeachers.length > 0 ? (
        <div className="teacher-card-grid">
          {filteredTeachers.map((teacher) => {
            const price = minCoursePriceLabel(teacher);
            return (
              <Link
                key={teacher.id}
                to={`/teachers/${teacher.id}`}
                className="tcard"
              >
                {teacher.photo && (
                  <img
                    src={teacher.photo}
                    alt={`${teacher.name}の写真`}
                    className="tcard-photo"
                    loading="lazy"
                  />
                )}
                <div className="tcard-body">
                  <p className="tcard-genre">{teacher.genres.join("、")}</p>
                  <h4 className="tcard-name">
                    {teacher.name}
                    <span className="tcard-kana">{teacher.furigana}</span>
                  </h4>
                  <p className="tcard-area">
                    {teacher.prefecture} {teacher.city}
                  </p>
                  {teacher.tags && teacher.tags.length > 0 && (
                    <div className="teacher-tags">
                      {teacher.tags.map((tag) => (
                        <span key={tag} className="tag">
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
                  )}
                  <div className="tcard-footer">
                    {price && (
                      <span className="tcard-price">レッスン {price}</span>
                    )}
                    <span className="tcard-cta">詳細・予約へ →</span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div style={{ textAlign: "center" }}>
          <p className="teacher-empty-note">
            条件に合う講師が見つかりませんでした。検索条件を変更してお試しください。
          </p>
          {/* 0件で終わらせず、要望として拾う。講師を増やす際の判断材料にもなる */}
          <p style={{ color: "#8a8270", marginTop: "1rem", lineHeight: 1.9 }}>
            お探しの分野の講師が見つからない場合は、ご希望をお聞かせください。
            <br />
            条件に合う講師が加わった際にご案内できる場合があります。
          </p>
          <Link
            to="/request"
            className="form-button"
            style={{ display: "inline-block", marginTop: "0.5rem" }}
          >
            希望を伝える（リクエスト）
          </Link>
        </div>
      )}
    </main>
  );
};

export default SearchResults;
