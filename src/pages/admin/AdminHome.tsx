// src/pages/admin/AdminHome.tsx
// 管理画面のハブ: 各管理ページへのリンク集
// admin ロールの付与は Firebase コンソールで users/{uid}.role = "admin" を手動設定する
import React from "react";
import { Link } from "react-router-dom";

const AdminHome: React.FC = () => {
  return (
    <main className="about-section fade-in-up">
      <h2 className="centered-heading-with-border">
        <span>管理画面</span>
      </h2>

      <div style={{ maxWidth: "640px", margin: "2rem auto" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          <Link
            to="/admin/dashboard"
            className="form-button"
            style={{ textAlign: "center" }}
          >
            ダッシュボード（売上・推移）
          </Link>

          <Link
            to="/admin/commission-sim"
            className="form-button"
            style={{ textAlign: "center" }}
          >
            手数料 逓減制シミュレーション
          </Link>

          <Link
            to="/admin/students"
            className="form-button"
            style={{ textAlign: "center" }}
          >
            登録済み生徒一覧
          </Link>

          <Link
            to="/admin/teachers"
            className="form-button"
            style={{ textAlign: "center" }}
          >
            登録済み講師一覧（講師別売上）
          </Link>

          <Link
            to="/admin/reservations"
            className="form-button"
            style={{ textAlign: "center" }}
          >
            予約一覧
          </Link>

          <Link
            to="/admin/users"
            className="form-button"
            style={{ textAlign: "center" }}
          >
            ユーザー一覧
          </Link>

          <Link
            to="/admin/reviews"
            className="form-button"
            style={{ textAlign: "center" }}
          >
            レビュー管理
          </Link>

          <Link
            to="/admin/coupons"
            className="form-button"
            style={{ textAlign: "center" }}
          >
            クーポン管理（発行・無効化）
          </Link>

          <Link
            to="/admin/referrals"
            className="form-button"
            style={{ textAlign: "center" }}
          >
            友達紹介 管理
          </Link>

          <Link
            to="/admin/contacts"
            className="form-button"
            style={{ textAlign: "center" }}
          >
            お問い合わせ一覧
          </Link>

          <Link
            to="/admin/requests"
            className="form-button"
            style={{ textAlign: "center" }}
          >
            依頼一覧
          </Link>
        </div>
      </div>
    </main>
  );
};

export default AdminHome;
