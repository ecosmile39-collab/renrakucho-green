// 無料トライアル中の施設が「使える期限」を判定する。
// 本登録を申し込んで初回請求書が送られた施設は、トライアル終了後もお支払期限の日の終わり（日本時間）まで使える。
// trialEndsAt（退会・削除の期限の起点）は変更せず、paymentGraceUntil で別に管理する。

function toTime(value) {
    if (!value) return NaN;
    if (typeof value.toDate === "function") return value.toDate().getTime();
    return Date.parse(value);
}

function getTrialAccessEndsAt(facility) {
    const trialEnd = toTime(facility.trialEndsAt);
    const graceEnd = toTime(facility.paymentGraceUntil);
    if (!Number.isFinite(trialEnd)) return Number.isFinite(graceEnd) ? graceEnd : NaN;
    return Number.isFinite(graceEnd) ? Math.max(trialEnd, graceEnd) : trialEnd;
}

function isTrialAccessOpen(facility, now = Date.now()) {
    const accessEnd = getTrialAccessEndsAt(facility);
    return Number.isFinite(accessEnd) && now < accessEnd;
}

function getPaymentDueEnd(dueDate) {
    if (typeof dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return null;
    const end = new Date(`${dueDate}T23:59:59.999+09:00`);
    return Number.isFinite(end.getTime()) ? end : null;
}

// 初回請求書を送った時点で、施設に保存する項目を返す。
// トライアル終了で自動ロックされていた施設は、お支払期限まで使えるようにロックを外す。
function getPaymentGraceFields(facility, dueDate, now = Date.now()) {
    if (!facility || facility.subscriptionStatus !== "trial") return {};
    const dueEnd = getPaymentDueEnd(dueDate);
    if (!dueEnd) return {};
    const fields = {};
    const currentGrace = toTime(facility.paymentGraceUntil);
    if (!Number.isFinite(currentGrace) || dueEnd.getTime() > currentGrace) {
        fields.paymentGraceUntil = dueEnd.toISOString();
    }
    const lockedByTrialExpiry = facility.status === "locked" && Boolean(facility.trialExpiredAt) && !facility.lockReason;
    if (lockedByTrialExpiry && dueEnd.getTime() > now && facility.usagePaused !== true) {
        fields.status = "active";
    }
    return fields;
}

module.exports = { getTrialAccessEndsAt, isTrialAccessOpen, getPaymentGraceFields };
