// src/pages/admin/AdminTeacherProfiles.tsx
// 管理者用: 講師プロフィールの公開管理。
//
// 講師が自分でコースを作れるようにした結果、そのままサイトに出ると
// 桁違いの料金や書きかけの文章が公開されてしまう。ここで運営が中身を見てから
// 公開する（published を true にする）。公開後の取り下げもここで行う。
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../../firebase";
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

  // 招待の発行。面談を終えた講師にこのURLを送る
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteSlug, setInviteSlug] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteExpiry, setInviteExpiry] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [inviting, setInviting] = useState(false);
  const [copied, setCopied] = useState(false);

  // 講師応募の一覧。ここから招待を作ると、応募内容がそのまま引き継がれる
  type Application = {
    id: string;
    name: string;
    email: string;
    subject: string;
    status: string;
    seconds: number;
  };
  const [applications, setApplications] = useState<Application[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  /**
   * 応募を削除する。検証用の応募や重複を片付けるための操作。
   * 応募者の連絡先ごと消えて元に戻せないため、名前を出して確認する。
   */
  const deleteApplication = async (a: Application) => {
    if (
      !window.confirm(
        `「${a.name || "（名前なし）"}」の応募を削除します。
連絡先を含めて完全に消え、元に戻せません。よろしいですか？`
      )
    ) {
      return;
    }

    try {
      setDeletingId(a.id);
      await deleteDoc(doc(db, "teacherApplications", a.id));
      setApplications((prev) => prev.filter((x) => x.id !== a.id));
    } catch (err) {
      console.error("応募の削除に失敗しました:", err);
      alert("応募の削除に失敗しました。");
    } finally {
      setDeletingId(null);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const snap = await getDocs(collection(db, "teacherApplications"));
        const list = snap.docs.map((d) => {
          const x = d.data();
          return {
            id: d.id,
            name: typeof x.name === "string" ? x.name : "",
            email: typeof x.email === "string" ? x.email : "",
            subject: typeof x.subject === "string" ? x.subject : "",
            status: typeof x.status === "string" ? x.status : "new",
            seconds: x.createdAt?.seconds ?? 0,
          };
        });
        list.sort((a, b) => b.seconds - a.seconds);
        setApplications(list);
      } catch (err) {
        console.error("講師応募の取得に失敗しました:", err);
      }
    })();
  }, []);

  const createInvite = async (applicationId?: string) => {
    setInviteError("");
    setInviteUrl("");
    setCopied(false);

    try {
      setInviting(true);
      const callable = httpsCallable<
        {
          name: string;
          email: string;
          teacherId: string;
          applicationId?: string;
        },
        { ok: boolean; token: string; url: string; expiresAt: string }
      >(functions, "adminCreateTeacherInvite");
      const res = await callable({
        name: inviteName.trim(),
        email: inviteEmail.trim(),
        teacherId: inviteSlug.trim(),
        ...(applicationId ? { applicationId } : {}),
      });
      // 相手に送るのは絶対URL。相対パスのままでは使えない
      setInviteUrl(`${window.location.origin}${res.data.url}`);
      setInviteExpiry(new Date(res.data.expiresAt).toLocaleDateString());
      setInviteName("");
      setInviteEmail("");
      setInviteSlug("");
    } catch (err: any) {
      console.error("招待の発行に失敗しました:", err);
      setInviteError(err?.message || "招待の発行に失敗しました。");
    } finally {
      setInviting(false);
    }
  };

  const copyInviteUrl = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setInviteError("コピーできませんでした。URLを選択してコピーしてください。");
    }
  };

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

        {/* 招待URLの発行 */}
        <section
          style={{
            border: "1px solid #ddd",
            borderRadius: 10,
            padding: "16px",
            margin: "1.5rem 0",
            background: "#fff",
          }}
        >
          <h3 style={{ marginTop: 0 }}>講師を招待する</h3>
          <p style={{ fontSize: "0.9rem", color: "#666", lineHeight: 1.8 }}>
            面談を終えた講師にこのURLを送ってください。
            このURLから会員登録した方だけが講師になります。
            有効期限は14日、1回使うと無効になります。
          </p>

          {/* 応募から作れば、氏名・連絡先・住所・ジャンル・自己紹介が
              そのまま引き継がれる。講師が同じことを二度入力せずに済む */}
          {applications.length > 0 && (
            <div style={{ marginBottom: "1.25rem" }}>
              <h4 style={{ marginBottom: 6 }}>応募から招待する（推奨）</h4>
              <p style={{ fontSize: "0.85rem", color: "#666", lineHeight: 1.8 }}>
                応募フォームの内容（お名前・連絡先・ご住所・ジャンル・自己紹介）が
                会員登録画面と講師プロフィールに引き継がれます。
              </p>
              {applications.map((a) => (
                <div
                  key={a.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                    border: "1px solid #eee",
                    borderRadius: 8,
                    padding: "8px 12px",
                    marginBottom: 6,
                  }}
                >
                  <span style={{ fontSize: "0.9rem" }}>
                    {a.name}
                    {a.subject && `（${a.subject}）`}
                    <br />
                    <span style={{ color: "#888", fontSize: "0.8rem" }}>
                      {a.email}
                      {a.seconds > 0 &&
                        ` / ${new Date(a.seconds * 1000).toLocaleDateString()}`}
                    </span>
                  </span>
                  <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="form-button"
                      onClick={() => createInvite(a.id)}
                      disabled={inviting || deletingId === a.id}
                    >
                      この応募から招待
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteApplication(a)}
                      disabled={deletingId === a.id}
                      style={{
                        border: "1px solid #e0c3c3",
                        background: "#fff",
                        color: "#c62828",
                        borderRadius: 6,
                        padding: "0 16px",
                        cursor: "pointer",
                      }}
                    >
                      {deletingId === a.id ? "削除中..." : "削除"}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          <h4 style={{ marginBottom: 6 }}>手動で招待する</h4>

          <div style={{ display: "grid", gap: 10, maxWidth: 420 }}>
            <input
              type="text"
              placeholder="講師名（例：藝大 太郎）"
              value={inviteName}
              onChange={(e) => setInviteName(e.target.value)}
              style={{ padding: "8px 12px", borderRadius: 6 }}
            />
            <input
              type="email"
              placeholder="メールアドレス（任意・記録用）"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              style={{ padding: "8px 12px", borderRadius: 6 }}
            />
            <input
              type="text"
              placeholder="講師ページのURL（任意・英数字。空欄なら自動）"
              value={inviteSlug}
              onChange={(e) => setInviteSlug(e.target.value)}
              style={{ padding: "8px 12px", borderRadius: 6 }}
            />
            <button
              type="button"
              className="form-button"
              onClick={() => createInvite()}
              disabled={inviting || !inviteName.trim()}
            >
              {inviting ? "発行中..." : "招待URLを発行する"}
            </button>
          </div>

          {inviteError && (
            <p style={{ color: "#c62828", marginTop: "0.75rem" }}>{inviteError}</p>
          )}

          {inviteUrl && (
            <div style={{ marginTop: "1rem" }}>
              <p style={{ fontSize: "0.85rem", color: "#666", marginBottom: 4 }}>
                有効期限: {inviteExpiry}（このURLは一度しか使えません）
              </p>
              <code
                style={{
                  display: "block",
                  wordBreak: "break-all",
                  background: "#faf8f4",
                  border: "1px solid #e5e0d5",
                  borderRadius: 6,
                  padding: "10px 12px",
                }}
              >
                {inviteUrl}
              </code>
              <button
                type="button"
                className="form-button"
                onClick={copyInviteUrl}
                style={{ marginTop: "0.5rem" }}
              >
                {copied ? "コピーしました" : "URLをコピー"}
              </button>
            </div>
          )}
        </section>

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
