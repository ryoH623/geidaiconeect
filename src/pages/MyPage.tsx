// src/pages/MyPage.tsx
// マイページ（ハブ）: 各機能ページへのリンク集
import React from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import ReferralCodeCard from "../components/ReferralCodeCard";

const MyPage: React.FC = () => {
  const { user, role } = useAuth();
  // 友達紹介は生徒と管理者が対象（functions 側の canOwnReferralCode と揃えること）
  const canOwnCode = role === "student" || role === "admin";
  const isTeacher = role === "teacher";

  return (
    <main className="about-section fade-in-up">
      <h2 className="centered-heading-with-border">
        <span>マイページ</span>
      </h2>

      <div style={{ maxWidth: "640px", margin: "2rem auto" }}>
        {user?.displayName && (
          <p style={{ textAlign: "center", marginBottom: "2rem" }}>
            {user.displayName} さん、こんにちは。
          </p>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          {isTeacher && (
            <>
              <Link
                to="/teacher/profile"
                className="form-button"
                style={{ textAlign: "center" }}
              >
                プロフィール・コースの登録
              </Link>

              <Link
                to="/schedule-list"
                className="form-button"
                style={{ textAlign: "center" }}
              >
                スケジュール管理
              </Link>
            </>
          )}

          <Link
            to="/history"
            className="form-button"
            style={{ textAlign: "center" }}
          >
            予約履歴
          </Link>

          <Link
            to="/profile"
            className="form-button"
            style={{ textAlign: "center" }}
          >
            会員情報の確認・変更
          </Link>

          <Link
            to="/mypage/review"
            className="form-button"
            style={{ textAlign: "center" }}
          >
            レビューを投稿する
          </Link>

          {canOwnCode && (
            <Link
              to="/referral"
              className="form-button"
              style={{ textAlign: "center" }}
            >
              友達紹介・クーポン
            </Link>
          )}
        </div>

        {canOwnCode && <ReferralCodeCard heading="あなたの紹介コード" />}
      </div>
    </main>
  );
};

export default MyPage;
