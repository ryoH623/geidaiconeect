// メール送信の共通基盤。
//
// index.ts から切り出したのは、teacherInvites.ts など index.ts に import される側から
// 使いたいため。index.ts を import し返すと循環参照になる（campaigns.ts と同じ理由）。
import nodemailer from "nodemailer";
import { logger } from "firebase-functions";
import { defineString } from "firebase-functions/params";

// ========================================
// SMTP の接続情報
// ========================================
export const SMTP_HOST = defineString("SMTP_HOST");
export const SMTP_PORT = defineString("SMTP_PORT");
export const SMTP_USER = defineString("SMTP_USER");
export const SMTP_PASS = defineString("SMTP_PASS");

export function makeTransport() {
  const port = Number(SMTP_PORT.value());

  logger.info("makeTransport config", {
    host: SMTP_HOST.value(),
    port,
    secure: port === 465,
    user: SMTP_USER.value(),
    passExists: !!SMTP_PASS.value(),
    passLength: SMTP_PASS.value()?.length ?? 0,
  });

  return nodemailer.createTransport({
    host: SMTP_HOST.value(),
    port,
    secure: port === 465,
    auth: {
      user: SMTP_USER.value(),
      pass: SMTP_PASS.value(),
    },
  });
}

/** HTML に埋め込むユーザー入力値のエスケープ */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * メール送信（失敗しても throw しない）。
 * Webhook・スケジュール実行など、送信失敗で本処理を止めたくない箇所から使う。
 */
export async function sendMailSafe(mail: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}): Promise<boolean> {
  try {
    const transporter = makeTransport();
    await transporter.sendMail({
      from: `Geidai Connect <${SMTP_USER.value()}>`,
      to: mail.to,
      replyTo: mail.replyTo ?? "support@geidaiconnect.com",
      subject: mail.subject,
      html: mail.html,
    });
    logger.info("sendMailSafe success", { to: mail.to, subject: mail.subject });
    return true;
  } catch (error) {
    logger.error("sendMailSafe failed", {
      to: mail.to,
      subject: mail.subject,
      error,
    });
    return false;
  }
}

/**
 * 案内メールの共通レイアウト。
 * intro / outro は HTML として挿入するため、ユーザー入力を含める場合は
 * 呼び出し側で escapeHtml すること。rows の値は内部でエスケープする。
 */
export function buildInfoMailHtml(params: {
  greetingName: string;
  intro: string[];
  rows: Array<[string, string]>;
  outro?: string[];
}): string {
  const introHtml = params.intro.map((p) => `<p>${p}</p>`).join("\n");
  const rowsHtml = params.rows
    .filter(([, value]) => value !== "")
    .map(
      ([key, value]) =>
        `<tr>` +
        `<td style="padding: 4px 16px 4px 0; color: #666; white-space: nowrap; vertical-align: top;">${escapeHtml(
          key
        )}</td>` +
        `<td style="padding: 4px 0;">${escapeHtml(value)}</td>` +
        `</tr>`
    )
    .join("\n");
  const outroHtml = (params.outro ?? []).map((p) => `<p>${p}</p>`).join("\n");

  return `
    <div style="font-family: Arial, 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif; line-height: 1.8; color: #333;">
      <p>${escapeHtml(params.greetingName)} 様</p>

      ${introHtml}

      <table style="margin: 16px 0; border-collapse: collapse;">
        ${rowsHtml}
      </table>

      ${outroHtml}

      <hr style="margin: 32px 0; border: none; border-top: 1px solid #e5e5e5;" />

      <p style="font-size: 12px; color: #666;">
        Geidai Connect<br />
        お問い合わせ: support@geidaiconnect.com
      </p>
    </div>
  `;
}
