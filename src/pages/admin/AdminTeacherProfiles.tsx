// src/pages/admin/AdminTeacherProfiles.tsx
// 管理者用: 講師プロフィールの公開管理。
//
// 講師が自分でコースを作れるようにした結果、そのままサイトに出ると
// 桁違いの料金や書きかけの文章が公開されてしまう。ここで運営が中身を見てから
// 公開する（published を true にする）。公開後の取り下げもここで行う。
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { doc, setDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../../firebase";
import {
  TEACHER_PROFILES,
  fetchAllTeachers,
  formatPrice,
  getCourses,
  type TeacherProfile,
} from "../../lib/teacherProfiles";
import { invalidateTeachersCache } from "../../hooks/useTeachers";
import { teachers as seedTeachers } from "../../data/teachers";

const STATUS_LABELS: Record<string, string> = {
  draft: "下書き",
  pending: "公開申請中",
  published: "公開中",
};

const AdminTeacherProfiles: React.FC = () => {
  const [profiles, setProfiles] = useState<TeacherProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");

  const reload = async () => {
    try {
      setLoading(true);
      setError("");
      const list = await fetchAllTeachers();
      list.sort((a, b) => a.name.localeCompare(b.name, "ja"));
      setProfiles(list);
    } catch (err) {
      console.error("講師プロフィールの取得に失敗しました:", err);
      setError("講師プロフィールの取得に失敗しました。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  /**
   * 静的ファイル（src/data/teachers.ts）から Firestore へ取り込む。
   * 移行時の一度きりの操作。すでにあるドキュメントは上書きしない。
   */
  const importSeed = async () => {
    const existing = new Set(profiles.map((p) => p.id));
    const targets = seedTeachers.filter((t) => !existing.has(t.id));

    if (targets.length === 0) {
      setMessage("取り込む対象がありません（すべて登録済みです）。");
      return;
    }

    if (
      !window.confirm(
        `${targets.length}件の講師を取り込みます。取り込み後は未公開の状態なので、内容を確認してから公開してください。`
      )
    ) {
      return;
    }

    try {
      setImporting(true);
      setMessage("");

      for (const t of targets) {
        await setDoc(doc(db, TEACHER_PROFILES, t.id), {
          authUid: t.authUid || "",
          name: t.name,
          furigana: t.furigana,
          prefecture: t.prefecture,
          city: t.city,
          genres: t.genres,
          tags: t.tags || [],
          profile: t.profile,
          photo: t.photo,
          // 料金は文字列（"6,000円"）で持っていたので数値に直す
          courses: t.courses.map((c) => ({
            type: c.type,
            title: c.title,
            price: parseInt(c.price.replace(/[^0-9]/g, ""), 10) || 0,
            ...(c.note ? { note: c.note } : {}),
            ...(c.locationDisplay ? { locationDisplay: c.locationDisplay } : {}),
            ...(c.isTrial ? { isTrial: true } : {}),
          })),
          onlineAvailable: t.onlineAvailable === true,
          ...(t.onlineLessonPrice
            ? {
                onlineLessonPrice:
                  parseInt(t.onlineLessonPrice.replace(/[^0-9]/g, ""), 10) || 0,
              }
            : {}),
          // 取り込んだ直後は非公開。内容を確認してから運営が公開する
          published: false,
          status: "pending",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      setMessage(`${targets.length}件を取り込みました。内容を確認して公開してください。`);
      invalidateTeachersCache();
      await reload();
    } catch (err) {
      console.error("取り込みに失敗しました:", err);
      setError("取り込みに失敗しました。");
    } finally {
      setImporting(false);
    }
  };

  const togglePublished = async (p: TeacherProfile) => {
    const next = !p.published;

    if (next) {
      const courses = getCourses(p);
      if (courses.length === 0) {
        alert("コースが1件も登録されていないため公開できません。");
        return;
      }
      if (!p.authUid) {
        // 予約とスケジュールは authUid をキーに動くため、空のままでは予約が取れない
        if (
          !window.confirm(
            `${p.name} は Auth の UID が未設定です。このまま公開すると予約枠を出せません。それでも公開しますか？`
          )
        ) {
          return;
        }
      }
      if (!window.confirm(`${p.name} をサイトに公開します。よろしいですか？`)) {
        return;
      }
    } else if (!window.confirm(`${p.name} の公開を取り下げます。よろしいですか？`)) {
      return;
    }

    try {
      setBusyId(p.id);
      await updateDoc(doc(db, TEACHER_PROFILES, p.id), {
        published: next,
        status: next ? "published" : "draft",
        updatedAt: serverTimestamp(),
      });
      setProfiles((prev) =>
        prev.map((x) =>
          x.id === p.id
            ? { ...x, published: next, status: next ? "published" : "draft" }
            : x
        )
      );
      invalidateTeachersCache();
    } catch (err) {
      console.error("公開状態の更新に失敗しました:", err);
      alert("公開状態の更新に失敗しました。");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className="about-section fade-in-up">
      <h2 className="centered-heading-with-border">
        <span>講師の公開管理</span>
      </h2>

      <div style={{ maxWidth: "820px", margin: "2rem auto" }}>
        <p style={{ color: "#8a8270", lineHeight: 1.9 }}>
          講師が登録した内容は、ここで公開操作をするまでサイトに出ません。
          料金の桁や本文を確認してから公開してください。
        </p>

        <div style={{ margin: "1.5rem 0" }}>
          <button
            type="button"
            className="form-button"
            onClick={importSeed}
            disabled={importing || loading}
          >
            {importing ? "取り込み中..." : "静的データから取り込む（移行用）"}
          </button>
          {message && (
            <p style={{ color: "#2e7d32", marginTop: "0.5rem" }}>{message}</p>
          )}
        </div>

        {loading ? (
          <p style={{ textAlign: "center" }}>読み込み中...</p>
        ) : error ? (
          <p style={{ textAlign: "center", color: "#c62828" }}>{error}</p>
        ) : profiles.length === 0 ? (
          <p style={{ textAlign: "center" }}>
            講師がまだ登録されていません。上のボタンで取り込めます。
          </p>
        ) : (
          profiles.map((p) => (
            <div
              key={p.id}
              style={{
                background: "#fff",
                border: "1px solid #ddd",
                borderRadius: "10px",
                padding: "16px",
                marginBottom: "12px",
                opacity: p.published ? 1 : 0.85,
              }}
            >
              <p style={{ marginBottom: "0.5rem" }}>
                <strong style={{ fontSize: "1.05rem" }}>{p.name}</strong>
                <span
                  style={{
                    marginLeft: "8px",
                    fontSize: "12px",
                    padding: "2px 8px",
                    borderRadius: "10px",
                    background: p.published ? "#e8f5e9" : "#fff3cd",
                  }}
                >
                  {STATUS_LABELS[p.status] || p.status}
                </span>
              </p>
              <p style={{ fontSize: "0.9rem", color: "#666" }}>
                {p.genres.join("、")} / {p.prefecture} {p.city}
              </p>
              {!p.authUid && (
                <p style={{ fontSize: "0.85rem", color: "#c62828" }}>
                  ⚠️ Auth の UID が未設定です。このままでは予約枠を出せません。
                </p>
              )}

              <ul style={{ fontSize: "0.9rem", lineHeight: 1.8, marginTop: "0.5rem" }}>
                {getCourses(p).map((c, i) => (
                  <li key={i}>
                    [{c.type}] {c.title} — {formatPrice(c.price)}
                    {c.isTrial && "（体験）"}
                  </li>
                ))}
              </ul>

              <div style={{ display: "flex", gap: 8, marginTop: "0.75rem" }}>
                <button
                  type="button"
                  className="form-button"
                  onClick={() => togglePublished(p)}
                  disabled={busyId === p.id}
                >
                  {busyId === p.id
                    ? "更新中..."
                    : p.published
                      ? "公開を取り下げる"
                      : "公開する"}
                </button>
                {p.published && (
                  <Link
                    to={`/teachers/${p.id}`}
                    className="form-button"
                    style={{ textAlign: "center" }}
                  >
                    公開ページを見る
                  </Link>
                )}
              </div>
            </div>
          ))
        )}

        <div style={{ textAlign: "center", marginTop: "2rem" }}>
          <Link to="/admin" className="form-button">
            管理画面トップへ戻る
          </Link>
        </div>
      </div>
    </main>
  );
};

export default AdminTeacherProfiles;
