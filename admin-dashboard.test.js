import assert from "node:assert/strict";
import { test } from "node:test";
import {
    activeAnnouncements, buildActionItems, buildFunnel, buildInvoiceCsv, evaluateFacilityUsage,
    evaluateJobHealth, facilityStatus, filterAndSortFacilities, summarizeRevenue, SCHEDULED_JOBS
} from "./admin-dashboard.js";

const now = new Date("2026-10-27T03:00:00Z"); // 日本時間 2026-10-27 12:00
const invoice = (data) => ({ test: false, status: "sent", total: 5500, subtotal: 5000, tax: 500, ...data });

test("action items list overdue and near-due invoices, failed sends, ending trials, cancellations and LINE gaps", () => {
    const facilities = [
        { id: "a", facilityName: "A施設", subscriptionStatus: "active", dedicatedLineConfigured: true },
        { id: "b", facilityName: "B施設", subscriptionStatus: "trial", trialEndsAt: "2026-10-29T15:00:00Z", phone: "090", contactPerson: "山田" },
        { id: "c", facilityName: "C施設", subscriptionStatus: "trial", trialEndsAt: "2026-10-29T15:00:00Z", subscriptionApplicationStatus: "pending_payment" },
        { id: "d", facilityName: "D施設", subscriptionStatus: "active", usagePaused: true, usageResumeRequestedAt: "2026-10-26T00:00:00Z" },
        { id: "e", facilityName: "E施設", subscriptionStatus: "active", lineAgencyStatus: "pending" },
        { id: "f", facilityName: "F施設", subscriptionStatus: "active" },
        { id: "gone", facilityName: "退会", subscriptionStatus: "active" }
    ];
    const invoicesByFacility = new Map([
        ["a", [
            invoice({ invoiceNumber: "INV-1", dueDate: "2026-10-20" }),
            invoice({ invoiceNumber: "INV-2", dueDate: "2026-10-29" }),
            invoice({ invoiceNumber: "INV-3", dueDate: "2026-11-30" }),
            invoice({ invoiceNumber: "INV-4", dueDate: "2026-10-20", paymentStatus: "paid" }),
            invoice({ invoiceNumber: "TEST", dueDate: "2026-10-01", test: true }),
            invoice({ invoiceNumber: "INV-5", status: "failed", failureMessage: "smtp" })
        ]]
    ]);
    const cancellationRecords = [
        { id: "gone", facilityName: "退会", status: "failed" },
        { id: "old", facilityName: "昔の退会", status: "completed", requestedAt: "2026-09-01T00:00:00Z" }
    ];
    const items = buildActionItems({ facilities, invoicesByFacility, cancellationRecords, now });
    const messages = items.map(item => `${item.facilityName}:${item.message}`);
    assert.ok(messages.includes("A施設:入金期限切れ（7日経過・期限 2026/10/20）"));
    assert.ok(messages.includes("A施設:入金期限まであと2日（2026/10/29）"));
    assert.ok(messages.some(message => message.startsWith("A施設:請求書メールの送信に失敗しました（INV-5）")));
    assert.ok(messages.includes("B施設:トライアル終了まであと3日・本登録は未申込（電話でフォロー）"));
    assert.equal(messages.some(message => message.startsWith("C施設:トライアル")), false);
    assert.ok(messages.includes("D施設:利用再開の申込があります（承認待ち）"));
    assert.ok(messages.includes("E施設:LINE連携代行の申込があります（未完了）"));
    assert.ok(messages.includes("F施設:本登録済みですが、施設専用のLINEが未設定です"));
    assert.ok(messages.includes("退会:退会の削除が完了していません（確認が必要）"));
    assert.equal(messages.some(message => message.includes("INV-3") || message.includes("TEST") || message.includes("昔の退会")), false);
    assert.equal(messages.filter(message => message.startsWith("退会:")).length, 1, "withdrawn facility is not listed twice");
    assert.equal(items[0].level, "danger");
    const b = items.find(item => item.facilityId === "b");
    assert.equal(b.phone, "090");
});

test("revenue summary counts this month, overdue, the 12-month trend and expected monthly sales", () => {
    const facilities = [
        { id: "a", subscriptionStatus: "active", billingServiceTypes: ["デイサービス"] },
        { id: "b", subscriptionStatus: "active", billingServiceTypes: ["デイサービス", "ショートステイ"] },
        { id: "p", subscriptionStatus: "active", usagePaused: true },
        { id: "t", subscriptionStatus: "trial" }
    ];
    const invoicesByFacility = new Map([
        ["a", [
            invoice({ issueDate: "2026-10-05", dueDate: "2026-10-15", paymentStatus: "paid" }),
            invoice({ issueDate: "2026-10-10", dueDate: "2026-10-20" }),
            invoice({ issueDate: "2026-09-10", dueDate: "2026-09-20", paymentStatus: "paid" }),
            invoice({ issueDate: "2026-10-11", status: "failed" }),
            invoice({ issueDate: "2026-10-12", test: true })
        ]],
        ["b", [invoice({ issueDate: "2026-10-20", dueDate: "2026-10-30", total: 6600 })]]
    ]);
    const summary = summarizeRevenue({ facilities, invoicesByFacility, now });
    assert.equal(summary.thisMonth, "2026-10");
    assert.deepEqual(summary.current, { billed: 17600, paid: 5500, unpaid: 12100, overdue: 5500, count: 3 });
    assert.equal(summary.monthly.length, 12);
    assert.deepEqual(summary.monthly.at(-1), { month: "2026-10", billed: 17600, paid: 5500, count: 3 });
    assert.deepEqual(summary.monthly.at(-2), { month: "2026-09", billed: 5500, paid: 5500, count: 1 });
    assert.equal(summary.monthly[0].month, "2025-11");
    assert.equal(summary.outstanding, 12100);
    assert.equal(summary.overdueAll, 5500);
    assert.equal(summary.billableCount, 2);
    assert.equal(summary.expectedMonthly, 5500 + 6600);
});

test("invoice CSV has a BOM, excludes test invoices, escapes quotes and spreadsheet formulas", () => {
    const csv = buildInvoiceCsv({
        facilities: [{ id: "a", facilityName: '=HYPERLINK("x")' }],
        invoicesByFacility: new Map([["a", [
            invoice({ id: "AUTO-20261101", invoiceNumber: "INV-1", issueDate: "2026-10-22", dueDate: "2026-11-01", paymentStatus: "paid", paidDate: "2026-10-25" }),
            invoice({ invoiceNumber: "TEST", test: true })
        ]]])
    });
    assert.ok(csv.startsWith("﻿\"施設ID\""));
    assert.equal(csv.includes("TEST"), false);
    assert.ok(csv.includes('"\'=HYPERLINK(""x"")"'));
    assert.ok(csv.includes('"月額"'));
    assert.ok(csv.includes('"入金済み","2026-10-25","送信済み"'));
    assert.equal(csv.split("\r\n").length, 2);
});

test("usage flags trial facilities with no records and registered facilities idle for two weeks", () => {
    const trial = { id: "t", subscriptionStatus: "trial", trialEndsAt: "2026-11-01T00:00:00Z" };
    assert.deepEqual(evaluateFacilityUsage(trial, { lastRecordDate: "", monthRecords: 0, users: 0, lineFamilies: 0 }, now).flags, ["トライアル中なのに記録が0件"]);
    assert.deepEqual(evaluateFacilityUsage(trial, { lastRecordDate: "2026-10-26", monthRecords: 3 }, now).flags, []);
    const active = { id: "a", subscriptionStatus: "active" };
    assert.deepEqual(evaluateFacilityUsage(active, { lastRecordDate: "2026-10-13", monthRecords: 1 }, now).flags, ["本登録なのに14日間入力がありません"]);
    assert.deepEqual(evaluateFacilityUsage(active, { lastRecordDate: "2026-10-20", monthRecords: 5 }, now).flags, []);
    assert.equal(evaluateFacilityUsage(active, { lastRecordDate: "2026-10-20" }, now).daysSinceLast, 7);
});

test("funnel counts trials and registrations in the last 28 days including withdrawn facilities", () => {
    const funnel = buildFunnel({
        facilities: [
            { id: "a", trialStartedAt: "2026-10-10T00:00:00Z", planActivatedAt: "2026-10-20T00:00:00Z" },
            { id: "b", createdAt: "2026-10-25T00:00:00Z" },
            { id: "old", trialStartedAt: "2026-08-01T00:00:00Z" }
        ],
        cancellationRecords: [{ id: "x", trialStartedAt: "2026-10-12T00:00:00Z" }],
        lpVisitors: 200,
        now
    });
    assert.deepEqual(funnel, { days: 28, lpVisitors: 200, trials: 3, registrations: 1, trialRate: 1.5, registrationRate: 33.3 });
    assert.equal(buildFunnel({ facilities: [], lpVisitors: null, now }).trialRate, null);
});

test("job health warns about missing, failed and late scheduled jobs", () => {
    const health = evaluateJobHealth({
        exportDailyRecordsBackup: { lastStatus: "success", lastSuccessAt: "2026-10-26T18:00:30Z", lastFinishedAt: "2026-10-26T18:00:31Z" },
        sendMonthlyInvoices: { lastStatus: "error", lastError: "Gmail auth", lastSuccessAt: "2026-10-26T00:00:00Z" },
        lockExpiredTrials: { lastStatus: "success", lastSuccessAt: "2026-10-26T20:00:00Z" }
    }, now);
    const byId = Object.fromEntries(health.map(job => [job.id, job]));
    assert.equal(health.length, SCHEDULED_JOBS.length);
    assert.equal(byId.exportDailyRecordsBackup.state, "ok");
    assert.equal(byId.sendMonthlyInvoices.state, "error");
    assert.equal(byId.lockExpiredTrials.state, "warning");
    assert.equal(byId.deleteExpiredVideos.state, "unknown");
});

test("facility search filters by name, contact or status and sorts by registration date or name", () => {
    const facilities = [
        { id: "a", facilityName: "さくら", subscriptionStatus: "active", createdAt: "2026-10-01T00:00:00Z" },
        { id: "b", facilityName: "あおば", subscriptionStatus: "trial", trialEndsAt: "2026-11-01T00:00:00Z", createdAt: "2026-10-20T00:00:00Z", phone: "090-1111" },
        { id: "c", facilityName: "かえで", subscriptionStatus: "trial", trialEndsAt: "2026-10-01T00:00:00Z", createdAt: "2026-09-20T00:00:00Z" },
        { id: "d", facilityName: "いちょう", subscriptionStatus: "active", usagePaused: true, createdAt: "2026-08-20T00:00:00Z" }
    ];
    assert.deepEqual(filterAndSortFacilities(facilities, {}, now).map(f => f.id), ["b", "a", "c", "d"]);
    assert.deepEqual(filterAndSortFacilities(facilities, { sort: "registered_asc" }, now).map(f => f.id), ["d", "c", "a", "b"]);
    assert.deepEqual(filterAndSortFacilities(facilities, { sort: "name" }, now).map(f => f.id), ["b", "d", "c", "a"]);
    assert.deepEqual(filterAndSortFacilities(facilities, { query: "1111" }, now).map(f => f.id), ["b"]);
    assert.deepEqual(filterAndSortFacilities(facilities, { status: "trial_expired" }, now).map(f => f.id), ["c"]);
    assert.deepEqual(filterAndSortFacilities(facilities, { status: "paused" }, now).map(f => f.id), ["d"]);
    assert.equal(facilityStatus({ subscriptionStatus: "trial", subscriptionApplicationStatus: "pending_payment" }, now), "pending_payment");
});

test("announcements show only active ones within their dates", () => {
    const list = activeAnnouncements([
        { id: "1", active: true, startDate: "2026-10-20", endDate: "2026-10-31" },
        { id: "2", active: true, startDate: "2026-11-01" },
        { id: "3", active: false },
        { id: "4", active: true, endDate: "2026-10-26" },
        { id: "5", active: true }
    ], now);
    assert.deepEqual(list.map(item => item.id), ["1", "5"]);
});

test("the health list covers every scheduled server function", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./functions/index.js", import.meta.url), "utf8");
    const scheduled = [...source.matchAll(/exports\.(\w+) = onSchedule\(/g)].map(match => match[1]).sort();
    assert.deepEqual(SCHEDULED_JOBS.map(job => job.id).sort(), scheduled);
});

test("admin screen uses the dashboard and records important operations", async () => {
    const { readFileSync } = await import("node:fs");
    const admin = readFileSync(new URL("./admin.html", import.meta.url), "utf8");
    for (const id of ["actionItemList", "revenueSummary", "revenueChart", "facilityUsageTable", "systemHealthTable", "auditLogList", "announcementList", "lpFunnel", "facilitySearchInput", "facilityStatusFilter", "facilitySortOrder"]) {
        assert.ok(admin.includes(`id="${id}"`), id);
    }
    for (const action of ["利用停止（ロック）", "利用停止を解除", "入金済みにした", "請求書を発行", "本利用へ切り替え", "利用再開を承認", "登録施設を削除", "全施設へのお知らせを公開"]) {
        assert.ok(admin.includes(`"${action}`) || admin.includes(`? "${action}"`) || admin.includes(action), action);
    }
    const rules = readFileSync(new URL("./firestore.rules", import.meta.url), "utf8");
    assert.match(rules, /match \/adminAuditLogs\/\{logId\} \{\s*allow read, create: if isAdmin\(\);\s*allow update, delete: if false;/);
    assert.match(rules, /match \/systemStatus\/\{jobId\} \{\s*allow read: if isAdmin\(\);\s*allow write: if false;/);
    assert.match(rules, /match \/systemAnnouncements\/\{announcementId\} \{\s*allow read: if signedIn\(\) && request\.auth\.token\.role in \['facility', 'admin'\];\s*allow write: if isAdmin\(\);/);
});

test("today's applications keep blinking until every facility is marked as checked", async () => {
    const { todayApplications, isAcknowledged } = await import("./admin-dashboard.js");
    const now = new Date("2026-10-28T05:00:00Z");
    const facilities = [
        { id: "a", facilityName: "あまみやホーム", subscriptionStatus: "trial", trialStartedAt: "2026-10-28T01:00:00Z" },
        { id: "b", facilityName: "みどり苑", subscriptionStatus: "trial", trialStartedAt: "2026-10-28T02:00:00Z", adminCheckedTrialAt: "2026-10-28T03:00:00Z" },
        { id: "c", facilityName: "昨日の施設", subscriptionStatus: "trial", trialStartedAt: "2026-10-26T02:00:00Z" },
        { id: "d", facilityName: "本登録ホーム", subscriptionStatus: "active", planActivatedAt: "2026-10-28T04:00:00Z", adminCheckedActiveAt: "2026-10-28T04:30:00Z" }
    ];
    const today = todayApplications(facilities, now);
    assert.deepEqual(today.trial.map(item => [item.name, item.checked]), [["あまみやホーム", false], ["みどり苑", true]]);
    assert.equal(today.trialBlink, true);
    assert.deepEqual(today.active.map(item => [item.name, item.checked]), [["本登録ホーム", true]]);
    assert.equal(today.activeBlink, false);

    facilities[0].adminCheckedTrialAt = "2026-10-28T04:59:00Z";
    assert.equal(todayApplications(facilities, now).trialBlink, false);

    // 確認したあとに申し込み直した場合は、また未確認になる
    assert.equal(isAcknowledged("2026-10-28T06:00:00Z", "2026-10-28T04:59:00Z"), false);
    assert.equal(isAcknowledged("2026-10-28T06:00:00Z", null), false);
});

test("new applications and LP inquiries stay listed and blinking until each one is checked", async () => {
    const { buildInboxItems } = await import("./admin-dashboard.js");
    const now = new Date("2026-10-30T03:00:00Z");
    const facilities = [
        { id: "a", facilityName: "あまみやホーム", subscriptionStatus: "trial", trialStartedAt: "2026-10-29T01:00:00Z" },
        { id: "b", facilityName: "みどり苑", subscriptionStatus: "trial", trialStartedAt: "2026-10-30T01:00:00Z", adminCheckedTrialAt: "2026-10-30T02:00:00Z",
            subscriptionRequestedAt: "2026-10-30T02:30:00Z" },
        { id: "c", facilityName: "昔の施設", subscriptionStatus: "active", trialStartedAt: "2026-10-01T00:00:00Z" },
        { id: "d", facilityName: "昨日確認済み", subscriptionStatus: "trial", trialStartedAt: "2026-10-29T00:00:00Z", adminCheckedTrialAt: "2026-10-29T05:00:00Z" }
    ];
    const inquiries = [
        { id: "q1", facilityName: "ひまわり園", contactName: "山田", kind: "お問い合わせ", receivedAt: "2026-10-30T02:50:00Z" },
        { id: "q2", facilityName: "確認済み園", kind: "無料トライアル", receivedAt: "2026-10-29T02:00:00Z", checkedAt: "2026-10-29T03:00:00Z" }
    ];
    const inbox = buildInboxItems({ facilities, inquiries, now });
    assert.deepEqual(inbox.items.map(item => [item.type, item.name, item.checked]), [
        ["inquiry", "ひまわり園", false],
        ["application", "みどり苑", false],
        ["trial", "みどり苑", true],
        ["trial", "あまみやホーム", false]
    ]);
    assert.equal(inbox.items[0].detail, "お問い合わせ・山田 様");
    assert.equal(inbox.blink, true);
    assert.equal(inbox.uncheckedCount, 3);

    facilities[0].adminCheckedTrialAt = "2026-10-30T03:00:00Z";
    facilities[1].adminCheckedApplicationAt = "2026-10-30T03:00:00Z";
    inquiries[0].checkedAt = "2026-10-30T03:00:00Z";
    const done = buildInboxItems({ facilities, inquiries, now });
    assert.equal(done.blink, false);
    // 確認済みは今日届いた分だけ残す（昨日届いて今日確認したあまみやホームは消える）
    assert.deepEqual(done.items.map(item => item.name), ["ひまわり園", "みどり苑", "みどり苑"]);
});
