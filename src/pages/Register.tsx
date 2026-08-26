import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { auth, db, functions } from "../firebase";
import { ADULT_AGE, calcAge, isValidBirthday } from "../lib/age";

type Gender = "" | "male" | "female" | "other";

/** 保護者（法定代理人）の続柄の選択肢 */
const GUARDIAN_RELATIONSHIPS = ["父", "母", "祖父", "祖母", "その他の親権者・後見人"];

const Register: React.FC = () => {
  const navigate = useNavigate();

  // 講師の招待URL（/register?invite=...）から来た場合。
  // role: teacher の付与は Functions 側で行う。ここでは表示の出し分けと、
  // 登録直後に acceptTeacherInvite を呼ぶかどうかの判断にだけ使う。
  const [searchParams] = useSearchParams();
  const inviteToken = (searchParams.get("invite") || "").trim();
  const [inviteChecking, setInviteChecking] = useState(!!inviteToken);
  const [inviteValid, setInviteValid] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteMessage, setInviteMessage] = useState("");

  /** 講師として登録する画面か。生徒向けの項目を出し分けるのに使う */
  const isTeacherSignup = !!inviteToken && inviteValid;

  // 基本
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  // 拡張項目
  const [lastName, setLastName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastNameKana, setLastNameKana] = useState("");
  const [firstNameKana, setFirstNameKana] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [prefecture, setPrefecture] = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState<Gender>("");
  const [birthY, setBirthY] = useState("");
  const [birthM, setBirthM] = useState("");
  const [birthD, setBirthD] = useState("");

  // 保護者（法定代理人）情報。18歳未満のときだけ入力を必須にする。
  const [guardianName, setGuardianName] = useState("");
  const [guardianNameKana, setGuardianNameKana] = useState("");
  const [guardianRelationship, setGuardianRelationship] = useState("");
  const [guardianPhone, setGuardianPhone] = useState("");

  // 規約同意
  // 友達紹介コード（任意）。適用は Cloud Functions（applyReferralCode）が検証する。
  const [referralCode, setReferralCode] = useState("");
  const [referralNotice, setReferralNotice] = useState("");

  const [agree, setAgree] = useState(false);

  // 状態
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 招待URLの有効性を先に確かめる。無効なまま登録させると、
  // 生徒として登録された後に「講師になれない」と分かることになる。
  useEffect(() => {
    if (!inviteToken) return;

    let cancelled = false;
    (async () => {
      try {
        const check = httpsCallable<
          { token: string },
          {
            ok: boolean;
            valid: boolean;
            name: string;
            message: string;
            prefill: Record<string, string> | null;
          }
        >(functions, "checkTeacherInvite");
        const res = await check({ token: inviteToken });
        if (cancelled) return;
        setInviteValid(res.data.valid);
        setInviteName(res.data.name || "");
        setInviteMessage(res.data.message || "");

        // 応募フォームに書いた内容を引き継ぎ、同じことを二度入力させない。
        // 空欄のときだけ埋める（入力途中の内容を上書きしないため）。
        const pre = res.data.prefill;
        if (res.data.valid && pre) {
          const p = pre as Record<string, string>;
          // 応募は氏名を1つの文字列で受けているため、空白で姓と名に分ける
          const [pLast, ...pRest] = String(p.name || "").split(/[\s　]+/);
          const [kLast, ...kRest] = String(p.furigana || "").split(/[\s　]+/);

          setEmail((v) => v || String(p.email || ""));
          setLastName((v) => v || pLast || "");
          setFirstName((v) => v || pRest.join("") || "");
          setLastNameKana((v) => v || kLast || "");
          setFirstNameKana((v) => v || kRest.join("") || "");
          setPhone((v) => v || String(p.phone || ""));
          setPostalCode((v) => v || String(p.postalCode || ""));
          setGender((v) => v || ((p.gender || "") as Gender));
          setBirthY((v) => v || String(p.birthYear || ""));
          setBirthM((v) => v || String(p.birthMonth || ""));
          setBirthD((v) => v || String(p.birthDay || ""));
          setPrefecture((v) => v || String(p.prefecture || ""));
          setAddress1((v) => v || [p.city, p.town].filter(Boolean).join(""));
          setAddress2((v) => v || String(p.line || ""));
        }
      } catch (err) {
        console.error("[register] 招待の確認に失敗:", err);
        if (!cancelled) {
          setInviteValid(false);
          setInviteMessage("招待URLの確認に失敗しました。時間をおいてお試しください。");
        }
      } finally {
        if (!cancelled) setInviteChecking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  // 郵便番号検索のローディング
  const [isSearchingZip, setIsSearchingZip] = useState(false);

  const prefectures = [
    "北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県",
    "新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県","三重県",
    "滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県",
    "鳥取県","島根県","岡山県","広島県","山口県",
    "徳島県","香川県","愛媛県","高知県",
    "福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県"
  ];

  const years = useMemo(() => {
    const arr: string[] = [];
    const thisYear = new Date().getFullYear();
    for (let y = 1940; y <= thisYear; y++) arr.push(String(y));
    return arr;
  }, []);
  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
  const days = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, "0"));

  // 入力中の生年月日から算出。未成年なら保護者欄を表示・必須化する。
  const age = useMemo(
    () => calcAge({ year: birthY, month: birthM, day: birthD }),
    [birthY, birthM, birthD]
  );
  const minor = age !== null && age < ADULT_AGE;

  const handlePostalBlur = async () => {
    if (postalCode.length !== 7) return;
    try {
      setIsSearchingZip(true);
      const res = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${postalCode}`);
      const data: any = await res.json();
      if (data?.results?.length) {
        const r = data.results[0];
        setPrefecture(r.address1 || "");
        setAddress1(`${r.address2 || ""}${r.address3 || ""}`);
      } else {
        console.warn("郵便番号から住所が見つかりませんでした");
      }
    } catch (e) {
      console.error("郵便番号検索に失敗しました", e);
    } finally {
      setIsSearchingZip(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (
      !lastName || !firstName || !lastNameKana || !firstNameKana ||
      !prefecture || !address1 || !phone || !gender ||
      !birthY || !birthM || !birthD || !email
    ) {
      setError("必須項目（*）を入力してください。");
      return;
    }

    if (!isValidBirthday(birthY, birthM, birthD)) {
      setError("生年月日が正しくありません。実在する日付をお選びください。");
      return;
    }

    // 18歳未満は法定代理人（保護者）の情報を必須にする。
    // 自己申告のチェックだけでなく、誰の同意を得たのかを記録として残すため。
    if (minor && !isTeacherSignup) {
      if (!guardianName.trim() || !guardianNameKana.trim() || !guardianRelationship) {
        setError("18歳未満の方は、保護者のお名前・フリガナ・続柄をご入力ください。");
        return;
      }
      if (!/^[ぁ-んー\s　]+$/.test(guardianNameKana.trim())) {
        setError("保護者のフリガナはひらがなでご入力ください。");
        return;
      }
      if (!/^\d{10,11}$/.test(guardianPhone.replace(/[-\s　]/g, ""))) {
        setError("保護者の電話番号は10〜11桁の数字でご入力ください。");
        return;
      }
    }

    if (password !== confirm) {
      setError("パスワードが一致しません。");
      return;
    }

    if (password.length < 8) {
      setError("パスワードは8文字以上にしてください。");
      return;
    }

    if (!agree) {
      setError("利用規約への同意が必要です。");
      return;
    }

    try {
      setSubmitting(true);

      // 1) Auth で作成
      const cred = await createUserWithEmailAndPassword(auth, email, password);

      // 2) 表示名
      const displayName = `${lastName}${firstName}`.trim();
      if (displayName) {
        await updateProfile(cred.user, { displayName });
      }

      // 3) Firestore にプロフィール保存
      const userRef = doc(db, "users", cred.user.uid);
      await setDoc(
        userRef,
        {
          uid: cred.user.uid,
          role: "student",
          email,
          displayName: displayName || null,
          lastName,
          firstName,
          lastNameKana,
          firstNameKana,
          postalCode: postalCode || null,
          prefecture: prefecture || null,
          address1: address1 || null,
          address2: address2 || null,
          phone: phone || null,
          gender: gender || null,
          birthday: birthY && birthM && birthD
            ? { year: birthY, month: birthM, day: birthD }
            : null,
          // 未成年の場合のみ、誰の同意を得たのかを記録として残す。
          // 年齢は誕生日で変わるため保存せず、birthday から都度算出する。
          guardian: minor && !isTeacherSignup
            ? {
                name: guardianName.trim(),
                nameKana: guardianNameKana.trim(),
                relationship: guardianRelationship,
                phone: guardianPhone.replace(/[-\s　]/g, ""),
                consentedAt: serverTimestamp(),
              }
            : null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          emailVerified: false,
        },
        { merge: true }
      );

      // 4) 友達紹介コード（任意）。コードが無効でも登録自体は成立させ、
      //    案内だけ出す（ここで登録を失敗させると再登録できなくなるため）。
      if (referralCode.trim() && !isTeacherSignup) {
        try {
          const applyReferralCode = httpsCallable<
            { code: string },
            { ok: boolean; message: string }
          >(functions, "applyReferralCode");
          await applyReferralCode({ code: referralCode.trim() });
        } catch (referralErr: any) {
          console.error("[register] 紹介コードの適用に失敗:", referralErr);
          setReferralNotice(
            typeof referralErr?.message === "string" && referralErr.message
              ? `紹介コードは登録できませんでした（${referralErr.message}）。会員登録は完了しています。`
              : "紹介コードは登録できませんでした。会員登録は完了しています。"
          );
        }
      }

      // 5) 講師の招待から来た場合はここで受理する。
      //    role を teacher に変え、講師プロフィールの下書きを作って authUid を紐付ける。
      //    ここが失敗すると生徒のまま残ってしまうので、明確にエラーを出す
      //    （アカウント自体は作成済みなので、運営が招待を出し直せば復帰できる）。
      if (inviteToken && inviteValid) {
        try {
          const accept = httpsCallable<{ token: string }, { ok: boolean; teacherId: string }>(
            functions,
            "acceptTeacherInvite"
          );
          await accept({ token: inviteToken });
        } catch (inviteErr: any) {
          console.error("[register] 招待の受理に失敗:", inviteErr);
          setError(
            "会員登録は完了しましたが、講師としての設定に失敗しました。運営にお問い合わせください。"
          );
          setSubmitting(false);
          return;
        }
      }

      // 6) 検証メールは Functions の onCreate で自動送信されるため、
      //    フロントから sendVerifyEmail は呼ばない

      setError(null);

      // メール確認案内ページへ遷移（再送用にメールアドレスを渡す）
      navigate("/verify-email", { state: { email } });
    } catch (err: any) {
      console.error("[register] failed:", err?.code, err?.message, err);
      const code = err?.code || "";

      if (code === "auth/email-already-in-use") {
        setError("このメールアドレスは既に登録されています。");
      } else if (code === "auth/invalid-email") {
        setError("メールアドレスの形式が正しくありません。");
      } else if (code === "auth/weak-password") {
        setError("パスワードが弱すぎます。（8文字以上、英数字を含めてください）");
      } else if (code === "auth/too-many-requests") {
        setError("リクエストが多すぎます。しばらく待ってから再度お試しください。");
      } else {
        setError("登録に失敗しました。入力内容をご確認のうえ再度お試しください。");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="register-container register-page">
      <div className="register-box">
        <h2>{inviteToken && inviteValid ? "講師の新規会員登録" : "新規会員登録"}</h2>

        {/* 招待URLから来た場合の案内。無効なら生徒登録になることを明示する */}
        {inviteToken && (
          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 8,
              padding: "12px 16px",
              margin: "1rem 0",
              background: inviteValid ? "#f3f7f1" : "#fff6f6",
              lineHeight: 1.8,
            }}
          >
            {inviteChecking ? (
              <p style={{ margin: 0 }}>招待URLを確認しています…</p>
            ) : inviteValid ? (
              <p style={{ margin: 0 }}>
                {inviteName && <strong>{inviteName} 様</strong>}
                {inviteName && <br />}
                講師としてご登録いただけます。登録後、マイページからレッスンコースを
                作成してください。内容を運営で確認のうえ公開します。
              </p>
            ) : (
              <p style={{ margin: 0, color: "#c62828" }}>
                {inviteMessage || "この招待URLは利用できません。"}
                <br />
                このまま登録すると<strong>生徒アカウント</strong>になります。
              </p>
            )}
          </div>
        )}

        <p className="required-note"><span className="req">*</span>は入力必須項目です。</p>

        <form onSubmit={handleSubmit} className="register-form form-grid">
          <label>お名前<span className="req">*</span></label>
          <div className="split-2">
            <input placeholder="姓" value={lastName} onChange={e => setLastName(e.target.value)} required />
            <input placeholder="名" value={firstName} onChange={e => setFirstName(e.target.value)} required />
          </div>

          <label>フリガナ<span className="req">*</span></label>
          <div className="split-2">
            <input placeholder="セイ" value={lastNameKana} onChange={e => setLastNameKana(e.target.value)} required />
            <input placeholder="メイ" value={firstNameKana} onChange={e => setFirstNameKana(e.target.value)} required />
          </div>

          <label>郵便番号</label>
          <div className="postal-row">
            <div className="mark">〒</div>
            <input
              placeholder="例）1500031"
              value={postalCode}
              onChange={e => setPostalCode(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={handlePostalBlur}
              inputMode="numeric"
            />
          </div>
          {isSearchingZip && (
            <>
              <label></label>
              <div style={{ fontSize: "12px", color: "#777" }}>郵便番号から住所を取得しています…</div>
            </>
          )}

          <label>都道府県<span className="req">*</span></label>
          <select value={prefecture} onChange={e => setPrefecture(e.target.value)} required>
            <option value="">選択してください</option>
            {prefectures.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>

          <label>住所1（市部区／町・村）<span className="req">*</span></label>
          <input
            placeholder="例）〇〇市△△区□町"
            value={address1}
            onChange={e => setAddress1(e.target.value)}
            required
          />

          <label className="nowrap">住所2（丁目・番地・マンション名・号室）</label>
          <input
            placeholder="例）△△ 1-4 ○○マンション101号"
            value={address2}
            onChange={e => setAddress2(e.target.value)}
          />

          <label>電話番号<span className="req">*</span></label>
          <input
            placeholder="例）00000000000"
            value={phone}
            onChange={e => setPhone(e.target.value.replace(/[^0-9]/g, ""))}
            inputMode="numeric"
            required
          />

          <label>メールアドレス<span className="req">*</span></label>
          <input
            type="email"
            placeholder="例）○○○@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />

          <label>性別<span className="req">*</span></label>
          <select value={gender} onChange={e => setGender(e.target.value as Gender)} required>
            <option value="">選択してください</option>
            <option value="male">男性</option>
            <option value="female">女性</option>
            <option value="other">その他</option>
          </select>

          <label>生年月日<span className="req">*</span></label>
          <div className="split-3">
            <select value={birthY} onChange={e => setBirthY(e.target.value)} required>
              <option value="">----</option>
              {years.map((y) => <option key={y} value={y}>{y} 年</option>)}
            </select>
            <select value={birthM} onChange={e => setBirthM(e.target.value)} required>
              <option value="">--</option>
              {months.map((m) => <option key={m} value={m}>{m} 月</option>)}
            </select>
            <select value={birthD} onChange={e => setBirthD(e.target.value)} required>
              <option value="">--</option>
              {days.map((d) => <option key={d} value={d}>{d} 日</option>)}
            </select>
          </div>

          {/* 18歳未満のときだけ表示。法定代理人の同意を記録として残すため。
              講師は成人が前提なので講師登録では出さない */}
          {minor && !isTeacherSignup && (
            <>
              {/* .form-grid は「ラベル｜入力欄」の2カラムグリッドなので、
                  見出しだけ row-2 で全幅にし、各項目は直接の子要素として並べる */}
              <div
                className="row-2"
                style={{
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  padding: "0.9rem 1rem",
                  background: "#fafafa",
                }}
              >
                <p style={{ fontWeight: "bold", margin: "0 0 0.25rem" }}>
                  保護者（法定代理人）の情報
                </p>
                <p style={{ fontSize: "0.85rem", color: "#666", margin: 0 }}>
                  18歳未満の方のお申し込みには、保護者の方の同意が必要です。
                  同意された保護者の方の情報をご入力ください。
                </p>
              </div>

              <label>保護者のお名前<span className="req">*</span></label>
              <input
                type="text"
                placeholder="例：藝大 太郎"
                value={guardianName}
                onChange={(e) => setGuardianName(e.target.value)}
                maxLength={100}
                required
              />

              <label>保護者のフリガナ<span className="req">*</span></label>
              <input
                type="text"
                placeholder="例：げいだい たろう"
                value={guardianNameKana}
                onChange={(e) => setGuardianNameKana(e.target.value)}
                maxLength={100}
                required
              />

              <label>続柄<span className="req">*</span></label>
              <select
                value={guardianRelationship}
                onChange={(e) => setGuardianRelationship(e.target.value)}
                required
              >
                <option value="">選択してください</option>
                {GUARDIAN_RELATIONSHIPS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>

              <label>保護者の電話番号<span className="req">*</span></label>
              <input
                type="tel"
                placeholder="例：09012345678"
                value={guardianPhone}
                onChange={(e) => setGuardianPhone(e.target.value)}
                maxLength={20}
                required
              />
            </>
          )}

          <label>パスワード<span className="req">*</span></label>
          <input
            type="password"
            placeholder="半角英数字8文字以上"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />

          <label>確認用パスワード<span className="req">*</span></label>
          <input
            type="password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            required
          />

          {/* 友達紹介コード（任意）。生徒向けの制度なので講師登録では出さない。
              登録後は変更できず、初回レッスンのご予約後は登録できないため、
              その旨をここで明示しておく。 */}
          {!isTeacherSignup && (
            <>
          <label>友達紹介コード（任意）</label>
          <input
            type="text"
            placeholder="例：GC-8F3K2M"
            value={referralCode}
            onChange={e => setReferralCode(e.target.value)}
            maxLength={16}
            autoCapitalize="characters"
          />
          <p className="form-note" style={{ fontSize: "0.85rem", color: "#666" }}>
            お友達からコードを受け取った方はご入力ください。初回レッスンの完了後に
            500円クーポンをお届けします。登録後の変更はできません。
          </p>
          {referralNotice && (
            <p className="form-note" style={{ fontSize: "0.85rem", color: "#a06000" }}>
              {referralNotice}
            </p>
          )}
            </>
          )}

          <div className="row-2">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={agree}
                onChange={e => setAgree(e.target.checked)}
              />
              <span>
                <a href="/terms" target="_blank" rel="noopener noreferrer" className="login-link">
                  利用規約
                </a>
                に同意して申込みます。
                {/* 講師は成人が前提なので、未成年に関する文言は出さない */}
                {!isTeacherSignup &&
                  (minor
                    ? "上記の保護者（法定代理人）の同意を得ていることを確認します。"
                    : "未成年者については法定代理人の同意を得ていることを確認します。")}
              </span>
            </label>
          </div>

          <div className="row-2">
            <button
              type="submit"
              className="register-button"
              disabled={!agree || submitting}
              aria-disabled={!agree || submitting}
            >
              <span className="btn-text">{submitting ? "登録中…" : "会員登録"}</span>
            </button>

            {error && <p className="error-message" role="alert">{error}</p>}

            <div className="already-account" style={{ marginTop: 12 }}>
              すでにアカウントをお持ちの方は{" "}
              <a href="/login" className="login-link">こちら</a>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Register;