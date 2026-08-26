// src/pages/VerifyEmailNotice.tsx
// 会員登録直後に表示するメール確認案内ページ。
// 確認メールの初回送信は Functions の sendVerifyEmail（Auth onCreate）が自動で行うため、
// ここでは再送のみを resendVerifyEmail callable 経由で行う（フロントから直接送信しない）。
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import { auth, functions } from "../firebase";

type ResendVerifyEmailResult = {
  ok: boolean;
  alreadyVerified: boolean;
  message: string;
};

export default function VerifyEmailNotice() {
  const location = useLocation();

  const emailFromState =
    typeof (location.state as { email?: string } | null)?.email === "string"
      ? (location.state as { email: string }).email
      : "";
  const email = emailFromState || auth.currentUser?.email || "";

  // 講師登録から来た場合は、次にやること（プロフィールとコースの登録）を案内する。
  // ここを出し分けないと、生徒向けの案内だけを見て何をすべきか分からない。
  const isTeacher =
    (location.state as { isTeacher?: boolean } | null)?.isTeacher === true;

  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "already" | "error">("idle");
  const [message, setMessage] = useState("");

  const resend = async () => {
    if (!email) {
      setStatus("error");
      setMessage("メールアドレスを確認できませんでした。ログイン後に再度お試しください。");
      return;
    }

    setStatus("sending");
    setMessage("");

    try {
      const resendVerifyEmail = httpsCallable<{ email: string }, ResendVerifyEmailResult>(
        functions,
        "resendVerifyEmail"
      );

      const result = await resendVerifyEmail({ email });

      if (result.data?.alreadyVerified) {
        setStatus("already");
        setMessage("このメールアドレスは既に確認済みです。ログインしてください。");
      } else {
        setStatus("sent");
        setMessage("確認メールを再送しました。");
      }
    } catch (e) {
      console.error("確認メールの再送に失敗しました:", e);
      setStatus("error");
      setMessage("送信に失敗しました。時間をおいて再度お試しください。");
    }
  };

  return (
    <main className="about-section fade-in-up">
      <h2 className="centered-heading-with-border">
        <span>確認メールを送信しました</span>
      </h2>

      <div
        style={{
          maxWidth: "640px",
          margin: "2rem auto",
          background: "#fff",
          border: "1px solid #ddd",
          borderRadius: "10px",
          padding: "24px",
        }}
      >
        {email && (
          <p style={{ marginBottom: "1rem" }}>
            <strong>{email}</strong> 宛に確認メールを送信しました。
          </p>
        )}

        <p style={{ marginBottom: "1.5rem" }}>
          受信トレイ（迷惑メールフォルダも）をご確認のうえ、メール内のリンクをクリックして
          本登録を完了してください。完了後は
          <Link to="/login" className="login-link"> ログイン </Link>
          できます。
        </p>

        {isTeacher && (
          <div
            style={{
              background: "#f7f3ea",
              border: "1px solid #e9dfc9",
              borderRadius: 8,
              padding: "16px",
              marginBottom: "1.5rem",
              lineHeight: 1.9,
            }}
          >
            <strong>ご登録後の流れ</strong>
            <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem" }}>
              <li>ログイン後、プロフィールとレッスンコースをご登録ください。</li>
              <li>「公開を申請する」を押すと、運営が内容を確認します。</li>
              <li>確認後、講師ページを公開します。</li>
            </ol>
          </div>
        )}

        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <button
            type="button"
            className="form-button"
            onClick={resend}
            disabled={status === "sending"}
          >
            {status === "sending" ? "送信中..." : "確認メールを再送する"}
          </button>

          <Link to="/login" className="form-button">
            ログインページへ
          </Link>
        </div>

        {message && (
          <p
            style={{
              marginTop: "1rem",
              color: status === "error" ? "#c62828" : "#2e7d32",
            }}
            role={status === "error" ? "alert" : undefined}
          >
            {message}
          </p>
        )}
      </div>
    </main>
  );
}
