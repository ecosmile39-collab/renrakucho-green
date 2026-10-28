// 管理者専用コントロールパネルの集計（画面の表示から切り離して、テストできるようにしている）
import { calculateServicePricing, getFacilityBillingServiceTypes } from "./service-types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_APPLICATION_STATUSES = ["invoice_sending", "pending_payment", "invoice_failed"];

export function toDate(value) {
    if (!value) return null;
    const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

export function tokyoDateKey(value) {
    const date = toDate(value);
    return date ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(date) : "";
}

function addDaysToKey(key, days) {
    const date = new Date(`${key}T00:00:00+09:00`);
    date.setDate(date.getDate() + days);
    return tokyoDateKey(date);
}

function daysBetweenKeys(fromKey, toKey) {
    return Math.round((Date.parse(`${toKey}T00:00:00+09:00`) - Date.parse(`${fromKey}T00:00:00+09:00`)) / DAY_MS);
}

export function facilityName(facility) {
    return facility?.facilityName || facility?.id || "";
}

export function isRegisteredFacility(facility) {
    return facility.subscriptionStatus === "active" || (facility.status === "active" && facility.subscriptionStatus !== "trial");
}

export function trialAccessEndTime(facility) {
    let end = Date.parse(facility.trialEndsAt || "");
    const grace = Date.parse(facility.paymentGraceUntil || "");
    if (Number.isFinite(grace)) end = Number.isFinite(end) ? Math.max(end, grace) : grace;
    return Number.isFinite(end) ? end : null;
}

// 施設一覧の絞り込みに使う状態
export function facilityStatus(facility, now = new Date()) {
    if (facility.usagePaused === true) return "paused";
    if (facility.status === "locked") return "locked";
    if (PENDING_APPLICATION_STATUSES.includes(facility.subscriptionApplicationStatus) && facility.subscriptionStatus === "trial") return "pending_payment";
    if (isRegisteredFacility(facility)) return "active";
    if (facility.subscriptionStatus === "trial") {
        const end = trialAccessEndTime(facility);
        return end !== null && now.getTime() < end ? "trial" : "trial_expired";
    }
    return "other";
}

export const FACILITY_STATUS_LABELS = {
    trial: "トライアル中",
    trial_expired: "トライアル終了",
    pending_payment: "本登録申込済み・入金待ち",
    active: "本登録",
    locked: "利用停止中",
    paused: "一時利用停止中",
    other: "その他"
};

export function invoiceDueDateKey(invoice) {
    if (typeof invoice.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(invoice.dueDate)) return invoice.dueDate;
    const sentKey = tokyoDateKey(invoice.sentAt || invoice.issueDate);
    return sentKey ? addDaysToKey(sentKey, 10) : "";
}

function invoiceIssueKey(invoice) {
    if (typeof invoice.issueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(invoice.issueDate)) return invoice.issueDate;
    return tokyoDateKey(invoice.sentAt || invoice.issueDate);
}

function realInvoices(invoices) {
    return (invoices || []).filter(invoice => invoice && invoice.test !== true);
}

// 1. 今日の要対応
export function buildActionItems({ facilities = [], invoicesByFacility = new Map(), cancellationRecords = [], now = new Date() }) {
    const today = tokyoDateKey(now);
    const items = [];
    const withdrawn = new Set(cancellationRecords.map(record => record.facilityId || record.id));
    const push = (category, level, facility, message, extra = {}) => items.push({
        category, level, facilityId: facility?.id || extra.facilityId || "", facilityName: facility ? facilityName(facility) : extra.facilityName || "", message, ...extra
    });

    for (const facility of facilities) {
        if (withdrawn.has(facility.id) || facility.retentionDeletionStartedAt) continue;
        const invoices = realInvoices(invoicesByFacility.get(facility.id));
        for (const invoice of invoices) {
            if (invoice.status === "sent" && invoice.paymentStatus !== "paid") {
                const due = invoiceDueDateKey(invoice);
                if (!due) continue;
                const days = daysBetweenKeys(today, due);
                if (days < 0) {
                    push("payment", "danger", facility, `入金期限切れ（${-days}日経過・期限 ${due.replace(/-/g, "/")}）`, { invoiceNumber: invoice.invoiceNumber || "", amount: Number(invoice.total) || 0, sortKey: due });
                } else if (days <= 3) {
                    push("payment", "warning", facility, days === 0 ? `入金期限は今日です（${due.replace(/-/g, "/")}）` : `入金期限まであと${days}日（${due.replace(/-/g, "/")}）`, { invoiceNumber: invoice.invoiceNumber || "", amount: Number(invoice.total) || 0, sortKey: due });
                }
            }
            if (invoice.status === "failed") {
                push("invoiceFailed", "danger", facility, `請求書メールの送信に失敗しました${invoice.invoiceNumber ? `（${invoice.invoiceNumber}）` : ""}`, { detail: String(invoice.failureMessage || "").slice(0, 120) });
            }
        }
        if (facility.subscriptionApplicationStatus === "invoice_failed" && !invoices.some(invoice => invoice.status === "failed")) {
            push("invoiceFailed", "danger", facility, "本登録の初回請求書を送信できていません");
        }

        const status = facilityStatus(facility, now);
        if (status === "trial") {
            const end = trialAccessEndTime(facility);
            const daysLeft = Math.ceil((end - now.getTime()) / DAY_MS);
            if (daysLeft <= 3) {
                push("trialEnding", "warning", facility, `トライアル終了まであと${daysLeft}日・本登録は未申込（電話でフォロー）`, { phone: facility.phone || "", contactPerson: facility.contactPerson || "" });
            }
        }
        if (facility.usageResumeRequestedAt) {
            push("pausedOrCancel", "warning", facility, "利用再開の申込があります（承認待ち）");
        } else if (facility.usagePaused === true) {
            push("pausedOrCancel", "info", facility, "一時利用停止中です");
        }
        if (isRegisteredFacility(facility) && status !== "paused") {
            if (facility.lineAgencyStatus === "pending") {
                push("line", "warning", facility, "LINE連携代行の申込があります（未完了）");
            } else if (facility.dedicatedLineConfigured !== true) {
                push("line", "info", facility, "本登録済みですが、施設専用のLINEが未設定です");
            }
        }
    }

    for (const record of cancellationRecords) {
        if (record.status === "completed") {
            const requested = toDate(record.requestedAt);
            // 退会完了は直近7日分だけお知らせする
            if (!requested || now.getTime() - requested.getTime() > 7 * DAY_MS) continue;
            push("pausedOrCancel", "info", null, "退会・データ削除が完了しました", { facilityId: record.facilityId || record.id, facilityName: record.facilityName || record.facilityId || record.id });
        } else {
            push("pausedOrCancel", "danger", null, record.status === "processing" ? "退会・削除処理中です" : "退会の削除が完了していません（確認が必要）", { facilityId: record.facilityId || record.id, facilityName: record.facilityName || record.facilityId || record.id });
        }
    }

    const levelOrder = { danger: 0, warning: 1, info: 2 };
    return items.sort((first, second) => levelOrder[first.level] - levelOrder[second.level] ||
        String(first.sortKey || "").localeCompare(String(second.sortKey || "")) ||
        first.facilityName.localeCompare(second.facilityName, "ja"));
}

export const ACTION_CATEGORY_LABELS = {
    payment: "入金",
    trialEnding: "トライアル終了間近",
    invoiceFailed: "請求書の送信失敗",
    pausedOrCancel: "退会・利用停止",
    line: "LINE"
};

// 2. 売上・入金のまとめ
export function summarizeRevenue({ facilities = [], invoicesByFacility = new Map(), now = new Date(), months = 12 }) {
    const today = tokyoDateKey(now);
    const thisMonth = today.slice(0, 7);
    const monthKeys = [];
    let year = Number(thisMonth.slice(0, 4));
    let month = Number(thisMonth.slice(5, 7));
    for (let index = 0; index < months; index++) {
        monthKeys.unshift(`${year}-${String(month).padStart(2, "0")}`);
        month -= 1;
        if (month === 0) { month = 12; year -= 1; }
    }
    const monthly = Object.fromEntries(monthKeys.map(key => [key, { month: key, billed: 0, paid: 0, count: 0 }]));
    const current = { billed: 0, paid: 0, unpaid: 0, overdue: 0, count: 0 };
    let outstanding = 0;
    let overdueAll = 0;

    for (const facility of facilities) {
        for (const invoice of realInvoices(invoicesByFacility.get(facility.id))) {
            if (invoice.status !== "sent") continue;
            const total = Number(invoice.total) || 0;
            const month = invoiceIssueKey(invoice).slice(0, 7);
            const paid = invoice.paymentStatus === "paid";
            const overdue = !paid && invoiceDueDateKey(invoice) !== "" && invoiceDueDateKey(invoice) < today;
            if (monthly[month]) {
                monthly[month].billed += total;
                monthly[month].count += 1;
                if (paid) monthly[month].paid += total;
            }
            if (month === thisMonth) {
                current.billed += total;
                current.count += 1;
                if (paid) current.paid += total;
                else current.unpaid += total;
                if (overdue) current.overdue += total;
            }
            if (!paid) outstanding += total;
            if (overdue) overdueAll += total;
        }
    }

    const billable = facilities.filter(facility => isRegisteredFacility(facility) && facility.usagePaused !== true &&
        facility.status !== "locked" && !facility.retentionDeletionStartedAt);
    const expectedMonthly = billable.reduce((sum, facility) =>
        sum + calculateServicePricing(5000, getFacilityBillingServiceTypes(facility)).total, 0);

    return { thisMonth, current, monthly: monthKeys.map(key => monthly[key]), outstanding, overdueAll, expectedMonthly, billableCount: billable.length };
}

function csvCell(value) {
    let text = value === undefined || value === null ? "" : String(value);
    if (/^[\s﻿]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

// 会計ソフト用の請求一覧CSV（テスト請求書は含めない）
export function buildInvoiceCsv({ facilities = [], invoicesByFacility = new Map() }) {
    const header = ["施設ID", "施設名", "請求書番号", "種類", "発行日", "請求対象期間（開始）", "請求対象期間（終了）",
        "小計（税抜）", "消費税", "合計（税込）", "入金期限", "入金状況", "入金日", "送信状況"];
    const typeLabel = { initial: "初回", monthly: "月額", manual: "管理者発行" };
    const rows = [];
    for (const facility of facilities) {
        for (const invoice of realInvoices(invoicesByFacility.get(facility.id))) {
            rows.push([facility.id, facilityName(facility), invoice.invoiceNumber || invoice.id || "",
                typeLabel[invoice.type] || (String(invoice.id || "").startsWith("AUTO-") ? "月額" : invoice.type || ""),
                invoiceIssueKey(invoice), invoice.billingPeriodStart || "", invoice.billingPeriodEnd || "",
                Number(invoice.subtotal) || 0, Number(invoice.tax) || 0, Number(invoice.total) || 0,
                invoiceDueDateKey(invoice), invoice.paymentStatus === "paid" ? "入金済み" : "未入金",
                invoice.paidDate || "", invoice.status === "sent" ? "送信済み" : invoice.status === "failed" ? "送信失敗" : invoice.status || ""]);
        }
    }
    rows.sort((first, second) => String(first[4]).localeCompare(String(second[4])) || String(first[1]).localeCompare(String(second[1]), "ja"));
    return "﻿" + [header, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
}

// 3. 施設ごとの使われ具合
export function evaluateFacilityUsage(facility, usage, now = new Date()) {
    const lastKey = usage.lastRecordDate || "";
    const daysSinceLast = lastKey ? daysBetweenKeys(lastKey, tokyoDateKey(now)) : null;
    const flags = [];
    const status = facilityStatus(facility, now);
    if ((status === "trial" || status === "pending_payment") && !lastKey) {
        flags.push("トライアル中なのに記録が0件");
    }
    if (status === "active" && (daysSinceLast === null || daysSinceLast >= 14)) {
        flags.push(daysSinceLast === null ? "本登録なのに記録がありません" : `本登録なのに${daysSinceLast}日間入力がありません`);
    }
    return { ...usage, daysSinceLast, flags };
}

// 5. 申し込みまでの流れ
export function buildFunnel({ facilities = [], cancellationRecords = [], lpVisitors = null, now = new Date(), days = 28 }) {
    const since = now.getTime() - days * DAY_MS;
    const inPeriod = value => {
        const date = toDate(value);
        return Boolean(date) && date.getTime() >= since && date.getTime() <= now.getTime();
    };
    const known = new Map();
    for (const facility of facilities) known.set(facility.id, facility);
    for (const record of cancellationRecords) {
        const id = record.facilityId || record.id;
        if (!known.has(id)) known.set(id, { id, trialStartedAt: record.trialStartedAt || null, planActivatedAt: record.planActivatedAt || null });
    }
    const all = [...known.values()];
    const trials = all.filter(facility => inPeriod(facility.trialStartedAt || facility.createdAt)).length;
    const registrations = all.filter(facility => inPeriod(facility.planActivatedAt)).length;
    const rate = (numerator, denominator) => denominator > 0 ? Math.round(numerator / denominator * 1000) / 10 : null;
    return {
        days,
        lpVisitors,
        trials,
        registrations,
        trialRate: lpVisitors === null ? null : rate(trials, lpVisitors),
        registrationRate: rate(registrations, trials)
    };
}

// 4. システムの健康状態：毎日の処理は26時間、1時間ごとの処理は3時間、成功がなければ注意
export const SCHEDULED_JOBS = [
    { id: "exportDailyRecordsBackup", label: "毎日のバックアップ（3時）", maxHours: 26 },
    { id: "sendMonthlyInvoices", label: "月額請求書の自動送信（9時）", maxHours: 26 },
    { id: "sendTrialExpiryReminders", label: "トライアル終了の案内メール（9時）", maxHours: 26 },
    { id: "deleteExpiredLineLinks", label: "期限切れLINEリンクの削除（4時半）", maxHours: 26 },
    { id: "cleanExpiredAdminLoginData", label: "ログイン確認コードの掃除（毎日）", maxHours: 26 },
    { id: "lockOverdueInvoiceFacilities", label: "入金期限切れの自動停止（1時間ごと）", maxHours: 3 },
    { id: "lockExpiredTrials", label: "トライアル終了の自動停止（1時間ごと）", maxHours: 3 },
    { id: "deleteExpiredVideos", label: "期限切れ動画の削除（1時間ごと）", maxHours: 3 },
    { id: "deleteExpiredFacilityAccounts", label: "保存期限切れ施設の退会処理（1時間ごと）", maxHours: 3 }
];

export function evaluateJobHealth(statusDocs = {}, now = new Date()) {
    return SCHEDULED_JOBS.map(job => {
        const doc = statusDocs[job.id] || null;
        const lastSuccess = toDate(doc?.lastSuccessAt);
        const lastRun = toDate(doc?.lastFinishedAt || doc?.lastStartedAt);
        const hoursSinceSuccess = lastSuccess ? (now.getTime() - lastSuccess.getTime()) / (60 * 60 * 1000) : null;
        let state = "ok";
        let message = "正常";
        if (!doc) {
            state = "unknown";
            message = "まだ記録がありません（公開後、最初の実行を待っています）";
        } else if (doc.lastStatus === "error") {
            state = "error";
            message = `失敗：${String(doc.lastError || "").slice(0, 120)}`;
        } else if (hoursSinceSuccess === null || hoursSinceSuccess > job.maxHours) {
            state = "warning";
            message = "予定の時刻に動いていない可能性があります";
        }
        return { ...job, state, message, lastSuccess, lastRun, details: doc?.details || null };
    });
}

// 7. 施設一覧の検索・絞り込み・並べ替え
export function filterAndSortFacilities(facilities = [], { query = "", status = "all", sort = "registered_desc" } = {}, now = new Date()) {
    const text = query.trim().toLowerCase();
    const registeredAt = facility => toDate(facility.trialStartedAt || facility.createdAt)?.getTime() || 0;
    const result = facilities.filter(facility => {
        if (status !== "all" && facilityStatus(facility, now) !== status) return false;
        if (!text) return true;
        return [facility.facilityName, facility.id, facility.email, facility.phone, facility.contactPerson]
            .some(value => String(value || "").toLowerCase().includes(text));
    });
    const byName = (first, second) => facilityName(first).localeCompare(facilityName(second), "ja");
    if (sort === "registered_asc") result.sort((first, second) => registeredAt(first) - registeredAt(second) || byName(first, second));
    else if (sort === "name") result.sort(byName);
    else result.sort((first, second) => registeredAt(second) - registeredAt(first) || byName(first, second));
    return result;
}

// 8. 施設に表示するお知らせ
export function activeAnnouncements(announcements = [], now = new Date()) {
    const today = tokyoDateKey(now);
    return announcements.filter(item => item && item.active === true &&
        (!item.startDate || item.startDate <= today) && (!item.endDate || item.endDate >= today))
        .sort((first, second) => String(second.startDate || "").localeCompare(String(first.startDate || "")));
}

// 本日のトライアル申込・本登録の「確認済み」。確認した時刻が申込（本登録）時刻より後なら確認済み。
// 同じ施設が後で申し込み直した場合は、また未確認に戻る。
export function isAcknowledged(eventAt, checkedAt) {
    const event = toDate(eventAt);
    const checked = toDate(checkedAt);
    if (!event || !checked) return false;
    return checked.getTime() >= event.getTime();
}

// 本日分の申込・本登録の一覧と、未確認があるか（点滅させるか）
export function todayApplications(facilities = [], now = new Date()) {
    const todayKey = tokyoDateKey(now);
    const trial = [];
    const active = [];
    for (const facility of facilities) {
        const trialAt = facility.trialStartedAt || (facility.subscriptionStatus === "trial" ? facility.createdAt : null);
        if (trialAt && tokyoDateKey(trialAt) === todayKey) {
            trial.push({ id: facility.id, name: facilityName(facility), checked: isAcknowledged(trialAt, facility.adminCheckedTrialAt) });
        }
        if (facility.planActivatedAt && tokyoDateKey(facility.planActivatedAt) === todayKey) {
            active.push({ id: facility.id, name: facilityName(facility), checked: isAcknowledged(facility.planActivatedAt, facility.adminCheckedActiveAt) });
        }
    }
    return {
        trial,
        active,
        trialBlink: trial.some(item => !item.checked),
        activeBlink: active.some(item => !item.checked)
    };
}
