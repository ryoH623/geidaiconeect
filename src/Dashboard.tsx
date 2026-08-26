// src/Dashboard.tsx
import { useEffect, useState } from "react";
import { auth } from "./firebase";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { useNavigate } from "react-router-dom";

export default function Dashboard() {
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setUserEmail(user.email);
      } else {
        setUserEmail(null);
        navigate("/login");
      }
    });

    return () => unsubscribe();
  }, [navigate]);

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/login");
  };

  return (
    <div style={{ textAlign: "center", marginTop: "100px" }}>
      <h2>ダッシュボード</h2>
      {userEmail ? (
        <p>ようこそ、{userEmail} さん！</p>
      ) : (
        <p>ユーザー情報を取得中...</p>
      )}
      <button type="button" onClick={handleLogout} style={{ marginTop: "20px", padding: "10px 20px" }}>
        ログアウト
      </button>
    </div>
  );
}
