import React, { useState } from "react";
import { createReservationAndGoToCheckout } from "../lib/checkout";

const TestCheckoutPage: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleCheckout = async () => {
    try {
      setLoading(true);
      setError("");

      await createReservationAndGoToCheckout({
        teacherId: "teacher-inda-yosuke",
        teacherName: "印田 陽介",
        lessonCourse: "チェロ 60分レッスン",
        lessonAmount: 6000,
        date: "2026-04-10",
        time: "14:00",
        name: "テスト太郎",
        furigana: "てすとたろう",
        email: "test@example.com",
        phone: "09012345678",
        location: "スタジオ",
        notes: "テスト予約",
      });
    } catch (err: any) {
      console.error("[checkout error]", err);
      setError(
        `決済画面の作成に失敗しました。 code: ${err?.code ?? "unknown"} / message: ${err?.message ?? "unknown"}`
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 720, margin: "40px auto", padding: "24px" }}>
      <h1>Stripe Checkout テスト</h1>

      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: 20,
          marginTop: 20,
          lineHeight: 1.8,
        }}
      >
        <p><strong>講師:</strong> 印田 陽介</p>
        <p><strong>コース:</strong> チェロ 60分レッスン</p>
        <p><strong>日時:</strong> 2026-04-10 14:00</p>
        <p><strong>料金:</strong> 6,000円</p>

        <button type="button"
          onClick={handleCheckout}
          disabled={loading}
          style={{
            marginTop: 16,
            padding: "12px 20px",
            borderRadius: 8,
            border: "1px solid #ccc",
            background: "#fff",
            cursor: "pointer",
          }}
        >
          {loading ? "決済画面を準備中..." : "Stripe Checkout を開く"}
        </button>

        {error && (
          <p style={{ color: "red", marginTop: 12 }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
};

export default TestCheckoutPage;