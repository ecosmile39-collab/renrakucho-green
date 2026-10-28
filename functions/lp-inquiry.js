// LP（WordPress）のお問い合わせフォームが送信されたときに、管理画面へ「新着」として知らせる。
// メールアドレス・電話番号・本文はメールで届くので、ここでは施設名・担当者名・種類だけを受け取る。
const LP_INQUIRY_KINDS = ["無料トライアル", "お問い合わせ"];
const LP_INQUIRY_ORIGIN = "https://renrakucyou.ecosmile.xyz";
const LP_INQUIRY_HOURLY_LIMIT = 5;

function cleanText(value, maxLength) {
    if (typeof value !== "string") return "";
    // 制御文字を取り除き、前後の空白を落とす
    return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

function parseLpInquiry(body) {
    let data = body;
    if (typeof data === "string") {
        try { data = JSON.parse(data); } catch (error) { return null; }
    }
    if (!data || typeof data !== "object") return null;
    // ロボット対策のおとり欄に何か入っていたら受け付けない
    if (typeof data.website === "string" && data.website.trim()) return null;
    const facilityName = cleanText(data.facility, 100);
    const contactName = cleanText(data.name, 100);
    const kind = LP_INQUIRY_KINDS.includes(data.kind) ? data.kind : "お問い合わせ";
    if (!facilityName) return null;
    return { facilityName, contactName, kind };
}

module.exports = { LP_INQUIRY_KINDS, LP_INQUIRY_ORIGIN, LP_INQUIRY_HOURLY_LIMIT, parseLpInquiry };
