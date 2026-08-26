import React, { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  User,
  sendPasswordResetEmail,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "./firebase";
import "./index.css";

const Login: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);

  const [error, setError] = useState("");
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);

  const [forgotOpen, setForgotOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetMessage, setResetMessage] = useState("");
  const [resetError, setResetError] = useState("");

  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const hasRestore = "scrollRestoration" in window.history;
    const historyWithRestore = window.history as History & {
      scrollRestoration?: "auto" | "manual";
    };
    const prev = hasRestore ? historyWithRestore.scrollRestoration : undefined;

    if (hasRestore) {
      historyWithRestore.scrollRestoration = "manual";
    }

    window.scrollTo({ top: 0, left: 0, behavior: "auto" });

    return () => {
      if (hasRestore) {
        historyWithRestore.scrollRestoration = prev ?? "auto";
      }
    };
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setCheckingAuth(false);
    });

    return () => unsubscribe();
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    try {
      setLoginLoading(true);

      const cred = await signInWithEmailAndPassword(auth, email, password);

      const from = (location.state as { from?: string } | null)?.from;
      if (from) {
        navigate(from);
        return;
      }

      // 講師はトップページ（生徒向け）ではなく、自分の作業場所へ送る。
      // AuthContext のロールはまだ読めていないので、ここで直接引く。
      let redirectTo = "/";
      try {
        const snap = await getDoc(doc(db, "users", cred.user.uid));
        const role = snap.exists() ? String(snap.data()?.role || "") : "";
        if (role === "teacher") redirectTo = "/teacher/profile";
        else if (role === "admin") redirectTo = "/admin";
      } catch (roleErr) {
        // ロールが引けなくてもログイン自体は成立している。トップへ送る。
        console.error("ロールの取得に失敗しました:", roleErr);
      }

      navigate(redirectTo);
    } catch (err) {
      console.error(err);
      setError("メールアドレスまたはパスワードが間違っています。");
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      setError("");
      setLogoutLoading(true);

      await signOut(auth);

      setEmail("");
      setPassword("");
      setCurrentUser(null);

      alert("ログアウトしました。続けて別のアカウントでログインできます。");
    } catch (err) {
      console.error(err);
      setError("ログアウトに失敗しました。");
    } finally {
      setLogoutLoading(false);
    }
  };

  const handleSendResetEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetError("");
    setResetMessage("");

    const targetEmail = resetEmail.trim();

    if (!targetEmail) {
      setResetError("メールアドレスを入力してください。");
      return;
    }

    try {
      setResetLoading(true);

      auth.languageCode = "ja";

      await sendPasswordResetEmail(auth, targetEmail);

      setResetMessage(
        "パスワード再設定メールを送信しました。受信箱をご確認ください。"
      );
    } catch (err: unknown) {
      console.error(err);

      const firebaseError = err as { code?: string };

      switch (firebaseError.code) {
        case "auth/invalid-email":
          setResetError("メールアドレスの形式が正しくありません。");
          break;
        case "auth/too-many-requests":
          setResetError("リクエストが多すぎます。少し時間をおいて再度お試しください。");
          break;
        case "auth/network-request-failed":
          setResetError("通信エラーが発生しました。接続状況をご確認ください。");
          break;
        default:
          setResetError("再設定メールの送信に失敗しました。");
          break;
      }
    } finally {
      setResetLoading(false);
    }
  };

  const handleToggleForgot = () => {
    setForgotOpen((prev) => !prev);
    setResetError("");
    setResetMessage("");
    setResetEmail(email.trim());
  };

  if (checkingAuth) {
    return (
      <div className="login-page">
        <div className="login-container">
          <div className="login-box">
            <h2>ログイン</h2>
            <p>認証状態を確認中です…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-box">
          <h2>ログイン</h2>

          {currentUser ? (
            <div>
              <p style={{ marginBottom: "1rem" }}>現在ログイン中です。</p>

              <p style={{ marginBottom: "1rem" }}>
                <strong>メールアドレス：</strong>
                {currentUser.email || "不明"}
              </p>

              <p style={{ marginBottom: "1.5rem", color: "#666" }}>
                別のアカウントでログインするには、先にログアウトしてください。
              </p>

              <button
                type="button"
                className="login-button logout-button"
                onClick={handleLogout}
                disabled={logoutLoading}
              >
                {logoutLoading ? "ログアウト中..." : "ログアウトする"}
              </button>

              {error && <p className="error-message">{error}</p>}
            </div>
          ) : (
            <form onSubmit={handleLogin} className="login-form">
              <label>メールアドレス</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />

              <label>パスワード</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />

              <div className="checkbox-container">
                <label
                  htmlFor="rememberMe"
                  className="checkbox-label"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    whiteSpace: "nowrap",
                  }}
                >
                  <input
                    id="rememberMe"
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    style={{ width: 16, height: 16 }}
                  />
                  <span>ログイン状態を保持する</span>
                </label>
              </div>

              <button
                type="submit"
                className="login-button"
                disabled={loginLoading}
              >
                {loginLoading ? "ログイン中..." : "ログイン"}
              </button>

              {error && <p className="error-message">{error}</p>}

              <div className="forgot-password">
                <button
                  type="button"
                  className="forgot-password-link-button"
                  onClick={handleToggleForgot}
                >
                  パスワードをお忘れの方
                </button>
              </div>

              {forgotOpen && (
                <div className="forgot-password-panel">
                  <p className="forgot-password-text">
                    登録済みのメールアドレスを入力してください。パスワード再設定メールを送信します。
                  </p>

                  <div className="forgot-password-form">
                    <input
                      type="email"
                      value={resetEmail}
                      onChange={(e) => setResetEmail(e.target.value)}
                      placeholder="メールアドレス"
                      required
                    />

                    <button
                      type="button"
                      className="login-button forgot-password-send-button"
                      disabled={resetLoading}
                      onClick={handleSendResetEmail}
                    >
                      {resetLoading ? "送信中..." : "再設定メールを送信"}
                    </button>
                  </div>

                  {resetMessage && (
                    <p className="success-message">{resetMessage}</p>
                  )}

                  {resetError && (
                    <p className="error-message">{resetError}</p>
                  )}
                </div>
              )}
            </form>
          )}
        </div>

        <div className="register-box">
          <h2>まだ会員登録されてない方</h2>
          <p>
            ご利用には会員登録が必要です。
            <br />
            下記リンクより会員登録へお進みください。
          </p>
          <button
            type="button"
            className="register-button"
            onClick={() => navigate("/register")}
          >
            新規会員登録
          </button>
        </div>
      </div>
    </div>
  );
};

export default Login;