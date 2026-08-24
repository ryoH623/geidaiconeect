// src/pages/TeacherRecruit.tsx
// 講師募集ページ。上部にサービス利用のメリット紹介、下部に応募フォーム。
// 送信は callable（submitTeacherApplication）経由で Firestore 保存＋運営宛メール送信。
import React, { useState } from "react";
import { Link } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";
import BudouxText from "../components/BudouxText";
import { subjects } from "../data/subjects";
import AddressCascadeSelect, {
  EMPTY_ADDRESS,
  type AddressValue,
} from "../components/AddressCascadeSelect";
import "../index.css";

interface TeacherApplicationPayload {
  name: string;
  furigana: string;
  email: string;
  phone: string;
  address: { prefecture: string; city: string; town: string; line: string };
  subject: string;
  graduationYear: number;
  bio: string;
}

const CURRENT_YEAR = new Date().getFullYear();
const GRADUATION_YEARS = Array.from(
  { length: CURRENT_YEAR - 1960 + 1 },
  (_, i) => CURRENT_YEAR - i
);

const MERITS: { title: string; body: string }[] = [
  {
    title: "「藝大OB」というブランドで選ばれる",
    body:
      "GeidaiConnect は東京藝術大学の卒業生・修了生限定のプラットフォームです。あなたの経歴がそのまま信頼となり、質の高いレッスンを求める生徒とマッチングしやすくなります。",
  },
  {
    title: "レッスン以外の「依頼」もお繋ぎします",
    body:
      "GeidaiConnect には、結婚式・イベントでの演奏、作品の展示・制作、講演などのご依頼も寄せられます。ご依頼は運営が窓口となって内容をうかがい、ご専門やご希望に合う登録講師へお打診します。レッスンと並行して、演奏・制作のお仕事の機会を広げられます。",
  },
  {
    title: "集客・予約・決済はおまかせ",
    body:
      "生徒の募集、レッスンスケジュールの管理、レッスン料のオンライン決済までを GeidaiConnect が代行します。講師はレッスンそのものに集中できます。",
  },
  {
    title: "自分のスタイルで教えられる",
    body:
      "自宅・スタジオ・出張からレッスン形態を選び、料金や対応エリアも自由に設定できます。演奏活動・制作活動のすき間時間だけの稼働も可能です。",
  },
  {
    title: "登録は無料・審査制で安心",
    body:
      "初期費用はかかりません。ご応募いただいた内容を運営が確認のうえ、担当者よりご連絡いたします。",
  },
];

const TeacherRecruit: React.FC = () => {
  const [name, setName] = useState("");
  const [furigana, setFurigana] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState<AddressValue>(EMPTY_ADDRESS);
  const [addressLine, setAddressLine] = useState("");
  const [subject, setSubject] = useState("");
  const [graduationYear, setGraduationYear] = useState("");
  const [bio, setBio] = useState("");

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const validate = (): Record<string, string> => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "氏名を入力してください。";
    if (!furigana.trim()) next.furigana = "ふりがなを入力してください。";
    else if (!/^[ぁ-んー\s　]+$/.test(furigana.trim()))
      next.furigana = "ふりがなはひらがなで入力してください。";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      next.email = "メールアドレスの形式が正しくありません。";
    if (!/^\d{10,11}$/.test(phone.replace(/[-\s　]/g, "")))
      next.phone = "電話番号は10〜11桁の数字で入力してください。";
    if (!address.prefecture || !address.city || !address.town)
      next.address = "都道府県・市区町村・町名を選択してください。";
    if (!addressLine.trim()) next.addressLine = "番地・建物名等を入力してください。";
    if (!subject) next.subject = "専攻を選択してください。";
    if (!graduationYear) next.graduationYear = "卒業・修了年を選択してください。";
    if (!bio.trim()) next.bio = "経歴・自己PRを入力してください。";
    else if (bio.length > 2000) next.bio = "経歴・自己PRは2000文字以内で入力してください。";
    return next;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError("");

    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    try {
      setSending(true);
      const callable = httpsCallable<
        TeacherApplicationPayload,
        { ok: boolean; message: string }
      >(functions, "submitTeacherApplication");

      await callable({
        name: name.trim(),
        furigana: furigana.trim(),
        email: email.trim(),
        phone: phone.replace(/[-\s　]/g, ""),
        address: {
          prefecture: address.prefecture,
          city: address.city,
          town: address.town,
          line: addressLine.trim(),
        },
        subject,
        graduationYear: Number(graduationYear),
        bio: bio.trim(),
      });

      setSent(true);
    } catch (err: any) {
      console.error("講師応募送信エラー:", err);
      setSubmitError(
        err?.message || "送信に失敗しました。時間をおいて再度お試しください。"
      );
    } finally {
      setSending(false);
    }
  };

  const requiredMark = <span className="required-label">必須</span>;

  return (
    <main className="main-content contact-main">
      {/* メリット紹介セクション */}
      <section className="about-section enhanced fade-in-up">
        <h2 className="section-title">講師として活動しませんか？</h2>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div style={{ textAlign: "left", maxWidth: "700px", width: "100%" }}>
            <p style={{ marginBottom: "1.5rem" }}>
              <BudouxText>
                GeidaiConnect
                は、東京藝術大学の卒業生・修了生と、本物のレッスンを受けたい生徒・演奏や作品を依頼したい方をつなぐサービスです。あなたの専門性を活かして、講師として活動してみませんか？
              </BudouxText>
            </p>
            {MERITS.map((merit, i) => (
              <div key={merit.title} style={{ marginBottom: "1.25rem" }}>
                <h3 style={{ marginBottom: "0.4rem" }}>
                  {i + 1}. <BudouxText>{merit.title}</BudouxText>
                </h3>
                <p style={{ margin: 0 }}>
                  <BudouxText>{merit.body}</BudouxText>
                </p>
              </div>
            ))}
            <div style={{ textAlign: "center", marginTop: "2rem" }}>
              <a href="#recruit-form" className="form-button" style={{ textDecoration: "none" }}>
                応募フォームへ
              </a>
              <p
                style={{
                  fontSize: "0.9rem",
                  color: "#666",
                  marginTop: "1rem",
                  marginBottom: 0,
                }}
              >
                <BudouxText>演奏・展示・講演などをご依頼したい方は、</BudouxText>
                {/* グローバルCSSで a は装飾なし・色継承のため、本文中リンクは下線を明示する */}
                <Link to="/request" style={{ textDecoration: "underline" }}>
                  お仕事・演奏のご依頼フォーム
                </Link>
                <BudouxText>をご利用ください。</BudouxText>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 応募フォーム */}
      <section id="recruit-form" className="about-section enhanced fade-in-up">
        <h2 className="section-title">講師応募フォーム</h2>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div style={{ textAlign: "left", maxWidth: "600px", width: "100%" }}>
            {sent ? (
              <div style={{ textAlign: "center", margin: "2rem 0" }}>
                <p>ご応募を受け付けました。</p>
                <p>
                  内容を確認のうえ、担当者よりご入力いただいたメールアドレス宛に
                  ご連絡いたします。
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} noValidate>
                <div className="form-group" style={{ marginBottom: "1rem" }}>
                  <label htmlFor="recruit-name">氏名{requiredMark}</label>
                  <input
                    id="recruit-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={100}
                    placeholder="例：藝大 花子"
                    style={{ width: "100%" }}
                  />
                  {errors.name && <p className="form-error">{errors.name}</p>}
                </div>

                <div className="form-group" style={{ marginBottom: "1rem" }}>
                  <label htmlFor="recruit-furigana">ふりがな{requiredMark}</label>
                  <input
                    id="recruit-furigana"
                    type="text"
                    value={furigana}
                    onChange={(e) => setFurigana(e.target.value)}
                    maxLength={100}
                    placeholder="例：げいだい はなこ"
                    style={{ width: "100%" }}
                  />
                  {errors.furigana && <p className="form-error">{errors.furigana}</p>}
                </div>

                <div className="form-group" style={{ marginBottom: "1rem" }}>
                  <label htmlFor="recruit-email">メールアドレス{requiredMark}</label>
                  <input
                    id="recruit-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    maxLength={200}
                    placeholder="例：hanako@example.com"
                    style={{ width: "100%" }}
                  />
                  {errors.email && <p className="form-error">{errors.email}</p>}
                </div>

                <div className="form-group" style={{ marginBottom: "1rem" }}>
                  <label htmlFor="recruit-phone">電話番号{requiredMark}</label>
                  <input
                    id="recruit-phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    maxLength={20}
                    placeholder="例：09012345678"
                    style={{ width: "100%" }}
                  />
                  {errors.phone && <p className="form-error">{errors.phone}</p>}
                </div>

                <div className="form-group" style={{ marginBottom: "1rem" }}>
                  <label htmlFor="recruit-addr-prefecture">住所{requiredMark}</label>
                  <AddressCascadeSelect
                    value={address}
                    onChange={setAddress}
                    idPrefix="recruit-addr"
                  />
                  {errors.address && <p className="form-error">{errors.address}</p>}
                  <input
                    id="recruit-address-line"
                    type="text"
                    value={addressLine}
                    onChange={(e) => setAddressLine(e.target.value)}
                    maxLength={200}
                    placeholder="番地・建物名等（例：1-2-3 ○○マンション101）"
                    style={{ width: "100%", marginTop: "0.5rem" }}
                  />
                  {errors.addressLine && <p className="form-error">{errors.addressLine}</p>}
                </div>

                <div className="form-group" style={{ marginBottom: "1rem" }}>
                  <label htmlFor="recruit-subject">専攻{requiredMark}</label>
                  <select
                    id="recruit-subject"
                    className="form-input"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    style={{ width: "100%" }}
                  >
                    <option value="">選択してください</option>
                    {subjects.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  {errors.subject && <p className="form-error">{errors.subject}</p>}
                </div>

                <div className="form-group" style={{ marginBottom: "1rem" }}>
                  <label htmlFor="recruit-graduation-year">
                    卒業・修了年{requiredMark}
                  </label>
                  <p style={{ fontSize: "0.85rem", color: "#666", margin: "0.2rem 0 0.4rem" }}>
                    大学院を修了された方は修了年をご入力ください。
                  </p>
                  <select
                    id="recruit-graduation-year"
                    className="form-input"
                    value={graduationYear}
                    onChange={(e) => setGraduationYear(e.target.value)}
                    style={{ width: "100%" }}
                  >
                    <option value="">選択してください</option>
                    {GRADUATION_YEARS.map((year) => (
                      <option key={year} value={year}>
                        {year}年
                      </option>
                    ))}
                  </select>
                  {errors.graduationYear && (
                    <p className="form-error">{errors.graduationYear}</p>
                  )}
                </div>

                <div className="form-group" style={{ marginBottom: "1.5rem" }}>
                  <label htmlFor="recruit-bio">経歴・自己PR{requiredMark}</label>
                  <textarea
                    id="recruit-bio"
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    maxLength={2000}
                    rows={8}
                    placeholder="演奏歴・制作歴、指導歴、受賞歴などをご記入ください（2000文字以内）"
                    style={{ width: "100%" }}
                  />
                  {errors.bio && <p className="form-error">{errors.bio}</p>}
                </div>

                {submitError && (
                  <p className="form-error" style={{ marginBottom: "1rem" }}>
                    {submitError}
                  </p>
                )}

                <button
                  type="submit"
                  className="form-button"
                  disabled={sending}
                  style={{ width: "100%" }}
                >
                  {sending ? "送信中..." : "応募する"}
                </button>
              </form>
            )}
          </div>
        </div>
      </section>
    </main>
  );
};

export default TeacherRecruit;
