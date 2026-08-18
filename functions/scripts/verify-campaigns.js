// キャンペーンの純粋ロジックを実際に実行して確認する使い捨てスクリプト。
// functions/lib（ビルド済み）を直接読む。
const admin = require("firebase-admin");
const C = require("../lib/campaigns.js");

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const Timestamp = admin.firestore.Timestamp;
const future = Timestamp.fromDate(new Date(Date.now() + 30 * 86400000));
const past = Timestamp.fromDate(new Date(Date.now() - 86400000));

const baseCoupon = {
  userId: "userA",
  status: "available",
  discountAmount: 500,
  minAmount: 4000,
  expiresAt: future,
};

console.log("\n[クーポン利用]");
check(
  "4,000円未満では使用できない",
  C.judgeCoupon(baseCoupon, { userId: "userA", subtotal: 3999 }).usable === false
);
check(
  "4,000円ちょうどでは使用できる",
  C.judgeCoupon(baseCoupon, { userId: "userA", subtotal: 4000 }).usable === true
);
check(
  "有効期限切れは使用できない",
  C.judgeCoupon({ ...baseCoupon, expiresAt: past }, { userId: "userA", subtotal: 10000 })
    .usable === false
);
check(
  "他人のクーポンは使用できない",
  C.judgeCoupon(baseCoupon, { userId: "userB", subtotal: 10000 }).usable === false
);
for (const st of ["reserved", "used", "expired", "cancelled"]) {
  check(
    `status=${st} は使用できない`,
    C.judgeCoupon({ ...baseCoupon, status: st }, { userId: "userA", subtotal: 10000 })
      .usable === false
  );
}
check(
  "値引き後が50円未満になる組み合わせは拒否",
  C.judgeCoupon(
    { ...baseCoupon, discountAmount: 500, minAmount: 0 },
    { userId: "userA", subtotal: 540 }
  ).usable === false
);
check(
  "利用可能なら値引き額を返す",
  C.judgeCoupon(baseCoupon, { userId: "userA", subtotal: 10000 }).discount === 500
);

// 明細への値引き配分（index.ts と同じ手順を再現して合計を検証する）
function allocate(items, discount) {
  let remaining = discount;
  for (const item of items) {
    if (remaining <= 0) break;
    const applied = Math.min(item, remaining);
    items[items.indexOf(item)] = item - applied;
    remaining -= applied;
  }
  return items.filter((v) => v > 0);
}
console.log("\n[割引後の決済金額]");
{
  const items = allocate([10000], 500);
  check("レッスンのみ: 10000 - 500 = 9500", items.reduce((a, b) => a + b, 0) === 9500);
}
{
  const items = allocate([3000, 1500], 1000);
  check(
    "レッスン+スタジオ: 4500 - 1000 = 3500",
    items.reduce((a, b) => a + b, 0) === 3500
  );
}
{
  const items = allocate([500, 3500], 500);
  check(
    "レッスン料が値引き額と同額: 0円明細を除外して 3500",
    items.length === 1 && items[0] === 3500
  );
}

console.log("\n[レッスン完了の判定]");
const yesterday = C.todayJstDate(-1);
const tomorrow = C.todayJstDate(1);
const today = C.todayJstDate();
check(
  "支払い済み・確定・過去日 → 完了",
  C.isLessonCompleted(
    { paymentStatus: "paid", reservationStatus: "confirmed", lessonDate: yesterday },
    today
  ) === true
);
check(
  "キャンセル済みは完了にならない",
  C.isLessonCompleted(
    { paymentStatus: "refunded", reservationStatus: "cancelled", lessonDate: yesterday },
    today
  ) === false
);
check(
  "返金済み（voided）は完了にならない",
  C.isLessonCompleted(
    { paymentStatus: "voided", reservationStatus: "cancelled", lessonDate: yesterday },
    today
  ) === false
);
check(
  "与信のみ（未請求）は完了にならない",
  C.isLessonCompleted(
    { paymentStatus: "authorized", reservationStatus: "confirmed", lessonDate: yesterday },
    today
  ) === false
);
check(
  "レッスン日が未来なら完了にならない",
  C.isLessonCompleted(
    { paymentStatus: "paid", reservationStatus: "confirmed", lessonDate: tomorrow },
    today
  ) === false
);
check(
  "当日はまだ完了にしない",
  C.isLessonCompleted(
    { paymentStatus: "paid", reservationStatus: "confirmed", lessonDate: today },
    today
  ) === false
);

console.log("\n[紹介コード]");
check("GC- 形式で発行される", /^GC-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(C.generateReferralCode()));
{
  const codes = new Set();
  for (let i = 0; i < 2000; i += 1) codes.add(C.generateReferralCode());
  check("連番ではない（2000回で重複がごく少数）", codes.size > 1990, `unique=${codes.size}`);
}
check("小文字・空白を正規化する", C.normalizeReferralCode(" gc-8f3k2m ") === "GC-8F3K2M");
check("GC- の省略を補う", C.normalizeReferralCode("8f3k2m") === "GC-8F3K2M");
check("全角ハイフンを吸収する", C.normalizeReferralCode("GCー8F3K2M") === "GC-8F3K2M");
check("紛らわしい文字(0,O,1,I,L)は不正扱い", C.normalizeReferralCode("GC-0O1IL2") === "");
check("桁数違いは不正扱い", C.normalizeReferralCode("GC-8F3K2") === "");

console.log("\n[キャンペーン期間]");
const period = { startsOn: "2026-09-01", endsOn: "2026-09-30" };
check("開始前は対象外", C.isWithinCampaign(period, "2026-08-31") === false);
check("開始日は対象", C.isWithinCampaign(period, "2026-09-01") === true);
check("終了日は対象", C.isWithinCampaign(period, "2026-09-30") === true);
check("終了後は対象外", C.isWithinCampaign(period, "2026-10-01") === false);
check(
  "未設定(null)なら常に対象",
  C.isWithinCampaign({ startsOn: null, endsOn: null }, "2030-01-01") === true
);

console.log("\n[クーポン仕様]");
check("レビュー特典は500円/4000円以上/60日",
  C.COUPON_SPECS.review.discountAmount === 500 &&
  C.COUPON_SPECS.review.minAmount === 4000 &&
  C.COUPON_SPECS.review.validDays === 60);
check("被紹介者特典は500円",
  C.COUPON_SPECS.referral_referee.discountAmount === 500 &&
  C.COUPON_SPECS.referral_referee.validDays === 60);
check("紹介者特典は1000円",
  C.COUPON_SPECS.referral_referrer.discountAmount === 1000 &&
  C.COUPON_SPECS.referral_referrer.validDays === 60);
check("紹介者特典は3回目で発生", C.REFERRER_REWARD_LESSON_COUNT === 3);
check("生徒都合のキャンセルではクーポンを消費", C.COUPON_ON_CANCEL.student === "consume");
check("講師・運営都合では返却",
  C.COUPON_ON_CANCEL.teacher === "restore" && C.COUPON_ON_CANCEL.operator === "restore");

console.log("\n[付与台帳のキー（重複発行の防止）]");
check("1ユーザー1回のキー", C.grantKeys.reviewUser("u1") === "review_user_u1");
check("予約単位のキー", C.grantKeys.reviewReservation("r1") === "review_res_r1");
check("被紹介者特典のキー", C.grantKeys.referralReferee("u2") === "referral_referee_u2");
check("紹介者特典のキー", C.grantKeys.referralReferrer("u2") === "referral_referrer_u2");

console.log(`\n結果: ${pass} 件 OK / ${fail} 件 FAIL\n`);
process.exit(fail === 0 ? 0 : 1);
