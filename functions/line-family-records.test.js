const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isFamilyRecordRequest, latestPublishedRecords } = require("./line-family-records");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const DELETE_FIELD = Symbol("deleteField");

function loadHandlers(entries, options = {}) {
    const documents = new Map(Object.entries(entries));
    const requests = [];
    const sentEmails = [];
    const customTokens = [];
    const loggedErrors = [];
    function document(referencePath) {
        return {
            id: referencePath.split("/").at(-1),
            path: referencePath,
            collection: name => collection(`${referencePath}/${name}`),
            async get() {
                return { exists: documents.has(referencePath), id: this.id, ref: this,
                    data: () => documents.get(referencePath) };
            },
            async update(fields) {
                const next = { ...documents.get(referencePath) };
                for (const [key, value] of Object.entries(fields)) {
                    if (value === DELETE_FIELD) delete next[key];
                    else next[key] = value;
                }
                documents.set(referencePath, next);
            },
            async set(fields, options) {
                const next = options?.merge ? { ...documents.get(referencePath) } : {};
                for (const [key, value] of Object.entries(fields)) {
                    if (value === DELETE_FIELD) delete next[key];
                    else next[key] = value;
                }
                documents.set(referencePath, next);
            },
            async delete() { documents.delete(referencePath); }
        };
    }
    function collection(collectionPath, conditions = []) {
        return {
            doc: name => document(`${collectionPath}/${name}`),
            limit: () => collection(collectionPath, conditions),
            async add(fields) {
                const reference = document(`${collectionPath}/generated-${documents.size}`);
                await reference.set(fields);
                return reference;
            },
            where: (field, operator, value) => collection(collectionPath, [...conditions, { field, operator, value }]),
            async get() {
                const docs = [];
                for (const [referencePath, data] of documents) {
                    if (referencePath.slice(0, referencePath.lastIndexOf("/")) !== collectionPath) continue;
                    if (!conditions.every(({ field, operator, value }) => operator === "array-contains"
                        ? data[field]?.includes(value) : data[field] === value)) continue;
                    docs.push(await document(referencePath).get());
                }
                return { docs, size: docs.length, empty: docs.length === 0, forEach: callback => docs.forEach(callback) };
            }
        };
    }
    const mockRequire = name => {
        if (name === "firebase-admin/app") return { initializeApp() {} };
        if (name === "firebase-admin/auth") return { getAuth: () => ({ createCustomToken: async (uid, claims) => {
            customTokens.push({ uid, claims });
            return "test-custom-token";
        } }) };
        if (name === "firebase-admin/firestore") return {
            getFirestore: () => ({ collection, batch: () => {
                const deletions = [];
                return {
                    delete: reference => deletions.push(reference.path),
                    commit: async () => deletions.forEach(referencePath => documents.delete(referencePath))
                };
            }, runTransaction: callback => callback({
                get: reference => reference.get(),
                set: (reference, fields, options) => reference.set(fields, options),
                delete: reference => documents.delete(reference.path)
            }) }), FieldValue: { serverTimestamp: () => "timestamp", delete: () => DELETE_FIELD }
        };
        if (name === "firebase-admin/storage") return {
            getStorage: () => ({ bucket: () => ({
                getFiles: async () => [options.storageFiles || []]
            }) })
        };
        if (name === "firebase-functions/v2/scheduler") return { onSchedule: (...args) => args.at(-1) };
        if (name === "firebase-functions/v2/https") return {
            onCall: (...args) => args.at(-1), onRequest: (...args) => args.at(-1),
            HttpsError: class extends Error { constructor(code, message) { super(message); this.code = code; } }
        };
        if (name === "firebase-functions/params") return { defineSecret: () => ({ value: () => "test-secret" }) };
        if (name === "firebase-functions/logger") return {
            warn() {}, error: (...args) => loggedErrors.push(args), info() {}
        };
        if (name === "nodemailer") return {
            createTransport: () => ({
                async sendMail(message) {
                    sentEmails.push(message);
                    if (options.sendMail) await options.sendMail(message);
                    return { messageId: `test-message-${sentEmails.length}` };
                }
            })
        };
        if (name === "google-auth-library") return {};
        return require(name.startsWith("./") ? path.join(__dirname, name) : name);
    };
    const sandbox = {
        exports: {}, require: mockRequire, __dirname, Buffer,
        fetch: async (url, options) => {
            requests.push({ url, body: JSON.parse(options.body) });
            return { ok: true };
        }
    };
    vm.runInNewContext(readFileSync(path.join(__dirname, "index.js"), "utf8"), sandbox);
    return { handlers: sandbox.exports, documents, requests, sentEmails, customTokens, loggedErrors };
}

async function sendFamilyEvent(context, userId, text = "連絡帳を見る") {
    const body = { events: [{ type: "message", source: { userId }, replyToken: "test-reply",
        message: { type: "text", text } }] };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = crypto.createHmac("sha256", "test-secret").update(rawBody).digest("base64");
    const response = { status(value) { this.statusCode = value; return this; }, send(value) { this.body = value; return this; } };
    await context.handlers.lineMessagingWebhook({ method: "POST", body, rawBody, get: () => signature }, response);
    assert.equal(response.statusCode, 200);
}

for (const failEmail of [false, true]) {
    test(`facility cancellation deletes data and records thank-you email ${failEmail ? "failure" : "success"}`, async () => {
        const context = loadHandlers({
            "facilities/cancel-test": {
                facilityName: "Cancel Facility", email: "facility@example.invalid", password: "secret", status: "active"
            },
            "facilities/cancel-test/users/user-a": {},
            "facilities/cancel-test/daily_records/record-a": {},
            "facilities/cancel-test/invoiceHistory/INITIAL": {},
            "facilityLineSettings/cancel-test": {},
            "linePairingCodes/pair": { facilityId: "cancel-test" },
            "lineRecordLinks/link": { facilityId: "cancel-test" },
            "facilities/other": { facilityName: "Other" }
        }, { sendMail() { if (failEmail) throw new Error("Mail unavailable"); } });
        const result = await context.handlers.deleteFacilityAccount({
            auth: { uid: "cancel-test", token: { role: "facility-delete" } },
            data: { password: "secret", confirmedFacilityName: "Cancel Facility" }
        });
        assert.equal(result.thankYouEmailStatus, failEmail ? "failed" : "sent");
        assert.equal(context.documents.has("facilities/cancel-test"), false);
        assert.equal(context.documents.has("facilities/cancel-test/users/user-a"), false);
        assert.equal(context.documents.has("facilities/cancel-test/daily_records/record-a"), false);
        assert.equal(context.documents.has("facilities/cancel-test/invoiceHistory/INITIAL"), false);
        assert.equal(context.documents.has("facilityCredentials/cancel-test"), false);
        assert.equal(context.documents.has("facilityLineSettings/cancel-test"), false);
        assert.equal(context.documents.has("linePairingCodes/pair"), false);
        assert.equal(context.documents.has("lineRecordLinks/link"), false);
        assert.equal(context.documents.has("facilities/other"), true);
        const cancellation = context.documents.get("facilityCancellations/cancel-test");
        assert.equal(cancellation.status, "completed");
        assert.equal(cancellation.thankYouEmailStatus, result.thankYouEmailStatus);
        assert.equal(cancellation.email, undefined);
        assert.equal(context.sentEmails.length, 1);
        assert.equal(context.sentEmails[0].to, "facility@example.invalid");
        assert.match(context.sentEmails[0].text, /Cancel Facility 御中/);
        assert.match(context.sentEmails[0].text, /心より御礼申し上げます/);
        assert.match(context.sentEmails[0].text, /バックアップ/);
    });
}

test("failed facility data deletion does not send a thank-you email", async () => {
    const context = loadHandlers({
        "facilities/cancel-test": { facilityName: "Cancel", password: "secret", email: "facility@example.invalid" }
    }, { storageFiles: [{ async delete() { throw new Error("Storage failure"); } }] });
    await assert.rejects(context.handlers.deleteFacilityAccount({
        auth: { uid: "cancel-test", token: { role: "facility-delete" } },
        data: { password: "secret", confirmedFacilityName: "Cancel" }
    }), { code: "unavailable" });
    assert.equal(context.documents.has("facilities/cancel-test"), true);
    assert.equal(context.documents.get("facilityCancellations/cancel-test").status, "failed");
    assert.equal(context.sentEmails.length, 0);
});

test("daily facility summaries show matching names with Tokyo dates and reset empty lists", () => {
    const html = readFileSync(path.join(__dirname, "..", "admin.html"), "utf8");
    const summary = html.match(/        function renderFacilities\(\) \{[\s\S]*?(?=\n            if \(facilities.length === 0\))/)[0] + "\n}";
    const elements = new Map();
    for (const id of ["facilityList", "summaryTrialCount", "summaryActiveCount",
        "summaryTodayTrialCount", "summaryTodayActiveCount", "summaryTodayTrialNames",
        "summaryTodayActiveNames", "summaryTotalCount"]) {
        assert.ok(html.includes(`id="${id}"`));
        elements.set(id, { textContent: "" });
    }
    const now = new Date("2026-10-16T06:00:00Z");
    const sandbox = {
        Date: class extends Date {
            constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
            static now() { return now.getTime(); }
        },
        document: { getElementById: id => elements.get(id) },
        facilities: [
            { id: "trial", facilityName: "<b>Trial</b>", subscriptionStatus: "trial", trialStartedAt: "2026-10-15T15:00:00Z" },
            { id: "legacy", subscriptionStatus: "trial", createdAt: "2026-10-16T14:59:59Z" },
            { id: "active", facilityName: "Active", subscriptionStatus: "active", trialStartedAt: "2026-10-01T00:00:00Z", planActivatedAt: { toDate: () => new Date("2026-10-16T00:00:00Z") } },
            { id: "yesterday", subscriptionStatus: "trial", trialStartedAt: "2026-10-15T14:59:59Z" },
            { id: "tomorrow", subscriptionStatus: "active", planActivatedAt: "2026-10-16T15:00:00Z" },
            { id: "invalid", subscriptionStatus: "trial", trialStartedAt: "invalid-date" }
        ]
    };
    vm.runInNewContext(summary, sandbox);
    sandbox.renderFacilities();
    assert.equal(elements.get("summaryTodayTrialCount").textContent, 2);
    assert.equal(elements.get("summaryTodayActiveCount").textContent, 1);
    assert.equal(elements.get("summaryTodayTrialNames").textContent, "<b>Trial</b>\nlegacy");
    assert.equal(elements.get("summaryTodayActiveNames").textContent, "Active");
    sandbox.facilities = [];
    sandbox.renderFacilities();
    assert.equal(elements.get("summaryTodayTrialCount").textContent, 0);
    assert.equal(elements.get("summaryTodayActiveCount").textContent, 0);
    assert.equal(elements.get("summaryTodayTrialNames").textContent, "該当なし");
    assert.equal(elements.get("summaryTodayActiveNames").textContent, "該当なし");
});

test("cancellation history cards escape names and do not restore facility controls", () => {
    const html = readFileSync(path.join(__dirname, "..", "admin.html"), "utf8");
    const render = html.match(/        function formatCancellationDate\(value\) \{[\s\S]*?(?=\n        window.resumeFacilityUsageFromAdmin)/)[0];
    const historyList = { innerHTML: "" };
    const sandbox = {
        escapeHtml: text => String(text).replace(/</g, "&lt;").replace(/>/g, "&gt;"),
        document: { getElementById: () => historyList },
        cancellationRecords: []
    };
    vm.runInNewContext(render, sandbox);
    const card = sandbox.renderCancellationCard({
        facilityName: "<script>alert(1)</script>", status: "completed", thankYouEmailStatus: "sent",
        requestedAt: "2026-10-16T04:00:00Z"
    });
    assert.match(card, /退会申込です/);
    assert.match(card, /退会・データ削除完了/);
    assert.match(card, /お礼メール：送信済み/);
    assert.match(card, /2026\/10\/16 13:00:00/);
    for (const requestedAt of [undefined, "invalid-date", "2026-10-16T04:00:00Z",
        { toDate: () => new Date("2026-10-16T04:00:00Z") }]) {
        const record = { facilityName: "Test", status: "completed", requestedAt };
        assert.doesNotThrow(() => sandbox.renderCancellationCard(record));
        sandbox.cancellationRecords = [record];
        assert.doesNotThrow(() => sandbox.renderCancellationRecords());
        assert.match(historyList.innerHTML, /Test/);
    }
    assert.equal(sandbox.formatCancellationDate(null), "日時不明");
    assert.match(sandbox.formatCancellationDate("invalid-date"), /保存日時を確認/);
    assert.ok(!card.includes("<script>"));
    assert.ok(!card.includes("onclick="));
    assert.match(html, /background: #000; color: #fff/);
    assert.match(html, /join\(""\) \+ cancellationRecords\.map/);
    assert.match(html, /facilities\.length === 0 && cancellationRecords\.length === 0/);
});

const pauseRequest = {
    auth: { uid: "pause-test", token: { role: "facility-delete" } },
    data: { password: "secret" }
};
const resumeRequest = {
    auth: { uid: "admin-control-panel", token: { role: "admin", mfaVerified: true } },
    data: { facilityId: "pause-test" }
};

test("facility pause keeps records and invoices but blocks login and all new invoicing", async () => {
    const context = loadHandlers({
        "facilities/pause-test": {
            facilityName: "Pause Test", password: "secret", status: "active",
            subscriptionStatus: "active", email: "facility@example.invalid",
            billingAnchorAt: "2026-01-01T00:00:00+09:00"
        },
        "facilities/pause-test/users/user-a": { name: "User A" },
        "facilities/pause-test/daily_records/record-a": { note: "keep" },
        "facilities/pause-test/invoiceHistory/OLD": { status: "sent", paymentStatus: "unpaid" },
        "facilityLineSettings/pause-test": { basicId: "@dedicated" }
    });
    await context.handlers.pauseFacilityUsage(pauseRequest);
    const facility = context.documents.get("facilities/pause-test");
    assert.equal(facility.usagePaused, true);
    assert.equal(facility.status, "locked");
    assert.equal(facility.billingAnchorAt, "2026-01-01T00:00:00+09:00");
    const firstPausedAt = facility.usagePausedAt;
    await context.handlers.pauseFacilityUsage(pauseRequest);
    assert.equal(context.documents.get("facilities/pause-test").usagePausedAt, firstPausedAt);
    assert.equal(context.documents.get("facilities/pause-test/daily_records/record-a").note, "keep");
    assert.equal(context.documents.has("facilities/pause-test/users/user-a"), true);
    assert.equal(context.documents.has("facilityLineSettings/pause-test"), true);
    assert.equal(context.documents.get("facilities/pause-test/invoiceHistory/OLD").paymentStatus, "unpaid");
    assert.equal(context.documents.has("facilityCancellations/pause-test"), false);
    assert.deepEqual(await context.handlers.getFacilityAccessStatus({
        auth: { uid: "pause-test", token: { role: "facility" } }
    }).then(r => r.status), "locked");
    await assert.rejects(context.handlers.createFacilitySession({
        data: { facilityName: "Pause Test", password: "secret" }
    }), { code: "permission-denied" });
    await assert.rejects(context.handlers.issueFacilityInvoiceForAdmin(resumeRequest), { code: "failed-precondition" });
    await context.handlers.sendMonthlyInvoices();
    assert.equal(context.sentEmails.length, 0);
});

test("pause requires facility deletion credentials and refuses in-flight invoices", async () => {
    const context = loadHandlers({
        "facilities/pause-test": { facilityName: "Pause Test", password: "secret", status: "active" },
        "facilities/pause-test/invoiceHistory/INITIAL": { status: "sending" }
    });
    await assert.rejects(context.handlers.pauseFacilityUsage({
        ...pauseRequest, auth: { uid: "pause-test", token: { role: "facility" } }
    }), { code: "unauthenticated" });
    await assert.rejects(context.handlers.pauseFacilityUsage({
        ...pauseRequest, data: { password: "wrong" }
    }), { code: "unauthenticated" });
    await assert.rejects(context.handlers.pauseFacilityUsage(pauseRequest), { code: "failed-precondition" });
    assert.equal(context.documents.get("facilities/pause-test").status, "active");
    assert.equal(context.sentEmails.length, 0);
});

test("only MFA administrators can resume and a new billing cycle preserves old invoices", async () => {
    const oldAnchor = "2026-01-01T00:00:00+09:00";
    const context = loadHandlers({
        "facilities/pause-test": {
            facilityName: "Pause Test", password: "secret", status: "locked", usagePaused: true,
            subscriptionStatus: "active", email: "facility@example.invalid", billingAnchorAt: oldAnchor
        },
        "facilities/pause-test/invoiceHistory/OLD": { status: "sent", paymentStatus: "unpaid" },
        "facilities/pause-test/daily_records/record-a": { note: "keep" }
    });
    for (const token of [{ role: "facility" }, { role: "admin" }]) {
        await assert.rejects(context.handlers.resumeFacilityUsage({
            ...resumeRequest, auth: { uid: "pause-test", token }
        }), { code: "unauthenticated" });
    }
    const before = Date.now();
    await context.handlers.resumeFacilityUsage(resumeRequest);
    const facility = context.documents.get("facilities/pause-test");
    assert.equal(facility.status, "active");
    assert.equal(facility.usagePaused, false);
    assert.ok(Date.parse(facility.billingAnchorAt) >= before);
    assert.match(facility.billingCycleId, /^[0-9a-f]{16}$/);
    assert.equal(facility.usageResumedBy, "admin-control-panel");
    assert.equal(context.documents.get("facilities/pause-test/invoiceHistory/OLD").paymentStatus, "unpaid");
    assert.equal(context.documents.get("facilities/pause-test/daily_records/record-a").note, "keep");
    await context.handlers.sendMonthlyInvoices();
    const invoice = [...context.documents.entries()].find(([key]) =>
        key.startsWith("facilities/pause-test/invoiceHistory/AUTO-"));
    assert.ok(invoice[0].endsWith("-" + facility.billingCycleId));
    const resumedDate = new Date(facility.billingAnchorAt).toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 10);
    assert.equal(invoice[1].billingPeriodStart, resumedDate);
    assert.equal(invoice[1].total, 5500);
    assert.equal(context.sentEmails.length, 2);
    await context.handlers.sendMonthlyInvoices();
    await assert.rejects(context.handlers.issueFacilityInvoiceForAdmin(resumeRequest), { code: "already-exists" });
    assert.equal(context.sentEmails.length, 2);
    await assert.rejects(context.handlers.resumeFacilityUsage(resumeRequest), { code: "failed-precondition" });
    assert.equal(context.documents.get("facilities/pause-test").billingAnchorAt, facility.billingAnchorAt);
});

for (const trialExpired of [true, false]) {
test(`paused ${trialExpired ? "expired" : "unexpired"} trials resume as paid subscriptions with standard monthly invoicing`, async () => {
    const trialEndsAt = new Date(Date.now() + (trialExpired ? -86400000 : 86400000)).toISOString();
    const context = loadHandlers({
        "facilities/pause-test": {
            facilityName: "Pause Test", password: "secret", status: "locked", usagePaused: true,
            subscriptionStatus: "trial", trialEndsAt, email: "facility@example.invalid"
        }
    });
    await assert.rejects(context.handlers.createFacilitySession({
        data: { facilityName: "Pause Test", password: "secret" }
    }), { code: "permission-denied" });
    await assert.rejects(context.handlers.requestFacilitySubscription({
        auth: { uid: "pause-test", token: { role: "facility", registrationOnly: true } },
        data: { serviceTypes: ["デイサービス"] }
    }), { code: "failed-precondition" });
    await assert.rejects(context.handlers.issueFacilityInvoiceForAdmin(resumeRequest), { code: "failed-precondition" });
    await context.handlers.resumeFacilityUsage(resumeRequest);
    assert.equal(context.documents.get("facilities/pause-test").trialEndsAt, trialEndsAt);
    const facility = context.documents.get("facilities/pause-test");
    assert.match(facility.billingCycleId, /^[0-9a-f]{16}$/);
    assert.equal(facility.subscriptionStatus, "active");
    assert.equal(facility.subscriptionApplicationStatus, "activated");
    assert.equal(facility.planActivatedAt, facility.usageResumedAt);
    const login = await context.handlers.createFacilitySession({
        data: { facilityName: "Pause Test", password: "secret" }
    });
    assert.equal(login.registrationOnly, false);
    assert.equal(context.sentEmails.length, 0);
    await context.handlers.issueFacilityInvoiceForAdmin(resumeRequest);
    const invoice = [...context.documents.entries()].find(([key]) =>
        key.startsWith("facilities/pause-test/invoiceHistory/AUTO-"))[1];
    assert.equal(invoice.type, "monthly");
    assert.equal(invoice.subtotal, 5000);
    assert.equal(invoice.tax, 500);
    assert.equal(invoice.total, 5500);
    assert.equal(context.documents.has("facilities/pause-test/invoiceHistory/INITIAL"), false);
    assert.match(context.sentEmails[0].subject, /【請求書】/);
    assert.equal(context.sentEmails.length, 2);
    await context.handlers.sendMonthlyInvoices();
    assert.equal(context.sentEmails.length, 2);
});
}

test("pause selection and administrator resume controls are wired without changing data retention", () => {
    const unsubscribe = readFileSync(path.join(__dirname, "..", "unsubscribe.html"), "utf8");
    const admin = readFileSync(path.join(__dirname, "..", "admin.html"), "utf8");
    assert.match(unsubscribe, /一時利用停止（名簿・連絡帳を残す）/);
    assert.match(unsubscribe, /httpsCallable\(functions, "pauseFacilityUsage"\)/);
    assert.match(unsubscribe, /写真・動画の自動削除期限/);
    assert.match(admin, /httpsCallable\(functions, "resumeFacilityUsage"\)/);
    assert.match(admin, /利用再開を承認する/);
});

test("only the family record button or exact command requests records", () => {
    assert.equal(isFamilyRecordRequest({ type: "postback", postback: { data: "view_records" } }), true);
    assert.equal(isFamilyRecordRequest({ type: "message", message: { type: "text", text: " 連絡帳を見る " } }), true);
    assert.equal(isFamilyRecordRequest({ type: "message", message: { type: "text", text: "ABCDEF123456" } }), false);
    assert.equal(isFamilyRecordRequest({ type: "follow" }), false);
});

test("latest records exclude drafts and future dates but include all services on the latest published date", () => {
    const records = [
        { date: "2026-10-05", serviceType: "A", familyPublished: true },
        { date: "2026-10-06", serviceType: "B", familyPublished: true },
        { date: "2026-10-06", serviceType: "A", familyPublished: true },
        { date: "2026-10-07", serviceType: "A" },
        { date: "2026-10-08", serviceType: "A", familyPublished: true },
        { date: "invalid", familyPublished: true }
    ];
    assert.deepEqual(latestPublishedRecords(records, "2026-10-07"), [records[2], records[1]]);
    assert.deepEqual(latestPublishedRecords([], "2026-10-07"), []);
});

test("staff publication never sends a LINE message", async () => {
    const recordPath = "facilities/facility-a/daily_records/2026-10-06_service_User";
    const context = loadHandlers({
        "facilities/facility-a": { status: "active" },
        "facilities/facility-a/users/User": { lineUserIds: ["family-a"] },
        [recordPath]: { facilityId: "facility-a", userName: "User", date: "2026-10-06", serviceType: "service" }
    });
    const result = await context.handlers.sendLineRecordNotification({
        auth: { uid: "facility-a", token: { role: "facility" } },
        data: { userName: "User", date: "2026-10-06", serviceType: "service" }
    });
    assert.equal(result.published, true);
    assert.equal(context.documents.get(recordPath).familyPublished, true);
    assert.equal(context.requests.length, 0);
});

test("facility can update its contact email and migrate its legacy password to a private hash", async () => {
    const context = loadHandlers({
        "facilities/facility-a": { status: "active", password: "current-password", email: "old@example.com", facilityName: "Facility" }
    });
    const result = await context.handlers.changeFacilityEmail({
        auth: { uid: "facility-a", token: { role: "facility" } },
        data: { currentPassword: "current-password", newEmail: "new@example.com" }
    });
    assert.equal(result.email, "new@example.com");
    assert.deepEqual(context.documents.get("facilities/facility-a"), {
        status: "active", email: "new@example.com", facilityName: "Facility"
    });
    assert.match(context.documents.get("facilityCredentials/facility-a").passwordHash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
});

test("facility login verifies the private password hash after migration", async () => {
    const context = loadHandlers({
        "facilities/facility-a": { facilityName: "Facility", status: "active", password: "current-password" }
    });
    await context.handlers.changeFacilityEmail({
        auth: { uid: "facility-a", token: { role: "facility" } },
        data: { currentPassword: "current-password", newEmail: "new@example.invalid" }
    });
    const result = await context.handlers.createFacilitySession({
        data: { facilityName: "Facility", password: "current-password" }
    });
    assert.equal(result.facilityId, "facility-a");
    await assert.rejects(context.handlers.createFacilitySession({
        data: { facilityName: "Facility", password: "wrong-password" }
    }), { code: "unauthenticated" });
});

test("family request uses only Reply API and returns only linked published records", async () => {
    const record = { facilityId: "facility-a", userName: "User", date: "2026-10-06", serviceType: "service", familyPublished: true };
    const context = loadHandlers({
        "facilities/facility-a": { status: "active", facilityName: "Facility" },
        "facilities/facility-a/users/User": { lineUserIds: ["family-a"] },
        "facilities/facility-a/users/Other": { lineUserIds: ["family-b"] },
        "facilities/facility-a/daily_records/2026-10-06_service_User": record,
        "facilities/facility-a/daily_records/2026-10-07_service_User": { ...record, date: "2026-10-07", familyPublished: false },
        "facilities/facility-a/daily_records/2026-10-06_service_Other": { ...record, userName: "Other" }
    });
    await sendFamilyEvent(context, "family-a");
    assert.equal(context.requests.length, 1);
    assert.equal(context.requests[0].url, "https://api.line.me/v2/bot/message/reply");
    assert.equal(context.requests[0].body.messages[0].quickReply.items[0].action.text, "連絡帳を見る");
    const links = [...context.documents.entries()].filter(([key]) => key.startsWith("lineRecordLinks/"));
    assert.equal(links.length, 1);
    assert.equal(links[0][1].userName, "User");
    assert.equal(links[0][1].date, "2026-10-06");
    await sendFamilyEvent(context, "unlinked-family");
    assert.equal([...context.documents.keys()].filter(key => key.startsWith("lineRecordLinks/")).length, 1);
    assert.match(context.requests[1].body.messages[0].text, /LINE連携が確認できません/);
});

test("common account cannot retrieve dedicated-account or expired-trial records", async () => {
    const context = loadHandlers({
        "facilities/dedicated": { status: "active" },
        "facilityLineSettings/dedicated": { displayName: "Dedicated" },
        "facilities/dedicated/users/User": { lineUserIds: ["family-a"] },
        "facilities/expired": { status: "active", subscriptionStatus: "trial", trialEndsAt: "2020-01-01T00:00:00Z" },
        "facilities/expired/users/User": { lineUserIds: ["family-a"] }
    });
    await sendFamilyEvent(context, "family-a");
    assert.match(context.requests[0].body.messages[0].text, /LINE連携が確認できません/);
    assert.equal([...context.documents.keys()].some(key => key.startsWith("lineRecordLinks/")), false);
});

test("disabled common LINE blocks pairing, publication and replies without removing stored records", async () => {
    const recordPath = "facilities/facility-a/daily_records/2026-10-06_service_User";
    const context = loadHandlers({
        "facilities/facility-a": { status: "active", commonLineEnabled: false },
        "facilities/facility-a/users/User": { lineUserIds: ["family-a"] },
        [recordPath]: { facilityId: "facility-a", userName: "User", date: "2026-10-06", serviceType: "service", familyPublished: true }
    });
    const request = { auth: { uid: "facility-a", token: { role: "facility" } }, data: { userName: "User", date: "2026-10-06", serviceType: "service" } };
    await assert.rejects(context.handlers.createLinePairingCode(request), { code: "failed-precondition" });
    await assert.rejects(context.handlers.sendLineRecordNotification(request), { code: "failed-precondition" });
    await sendFamilyEvent(context, "family-a");
    assert.equal(context.requests.length, 0);
    assert.equal(context.documents.has(recordPath), true);
    assert.equal([...context.documents.keys()].some(key => key.startsWith("lineRecordLinks/")), false);
    context.documents.get("facilities/facility-a").commonLineEnabled = true;
    await sendFamilyEvent(context, "family-a");
    assert.equal(context.requests.length, 1);
});

test("dedicated LINE remains available when common LINE is disabled", async () => {
    const context = loadHandlers({
        "facilities/facility-a": { status: "active", commonLineEnabled: false },
        "facilityLineSettings/facility-a": { displayName: "Dedicated", basicId: "@dedicated" },
        "facilities/facility-a/users/User": { lineUserIds: ["family-a"] },
        "facilities/facility-a/daily_records/2026-10-06_service_User": { facilityId: "facility-a", userName: "User", date: "2026-10-06", serviceType: "service" }
    });
    const request = { auth: { uid: "facility-a", token: { role: "facility" } }, data: { userName: "User", date: "2026-10-06", serviceType: "service" } };
    const status = await context.handlers.getFacilityLineSettingsStatus(request);
    assert.equal(status.configured, true);
    assert.equal(status.lineEnabled, true);
    assert.equal((await context.handlers.createLinePairingCode(request)).officialAccountId, "@dedicated");
    assert.equal((await context.handlers.sendLineRecordNotification(request)).published, true);
});

test("dedicated account receives pairing codes while the common account cannot link the facility", async () => {
    const code = "ABCDEF123456";
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const context = loadHandlers({
        "facilities/facility-a": { status: "active", commonLineEnabled: true },
        "facilityLineSettings/facility-a": { displayName: "Facility LINE", basicId: "@facilityonly" },
        "facilities/facility-a/users/User": { lineUserIds: [] },
        [`linePairingCodes/${codeHash}`]: { facilityId: "facility-a", userName: "User", expiresAt: new Date(Date.now() + 60000) }
    });
    const request = { auth: { uid: "facility-a", token: { role: "facility" } }, data: { userName: "User" } };
    const pairing = await context.handlers.createLinePairingCode(request);
    assert.equal(pairing.officialAccountName, "Facility LINE");
    assert.equal(pairing.officialAccountId, "@facilityonly");
    await sendFamilyEvent(context, "family-a", code);
    assert.deepEqual(context.documents.get("facilities/facility-a/users/User").lineUserIds, []);
});

test("@805xgtzu is the common LINE account even if it exists in facility settings", async () => {
    const code = "ABCDEF123456";
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const context = loadHandlers({
        "facilities/facility-a": { status: "active", commonLineEnabled: true },
        "facilityLineSettings/facility-a": { displayName: "えこすまいる連絡帳", basicId: "@805xgtzu" },
        "facilities/facility-a/users/User": { lineUserIds: [] },
        [`linePairingCodes/${codeHash}`]: { facilityId: "facility-a", userName: "User", expiresAt: new Date(Date.now() + 60000) }
    });
    const request = { auth: { uid: "facility-a", token: { role: "facility" } }, data: { userName: "User" } };
    const pairing = await context.handlers.createLinePairingCode(request);
    const status = await context.handlers.getFacilityLineSettingsStatus(request);
    assert.equal(pairing.officialAccountName, "えこすまいる連絡帳");
    assert.equal(pairing.officialAccountId, "@805xgtzu");
    assert.equal(status.configured, false);
    assert.equal(status.commonAccountConfiguredInFacility, true);
    assert.equal(status.webhookUrl, "https://us-central1-renrakucho-app-6b157.cloudfunctions.net/lineMessagingWebhook");
    await sendFamilyEvent(context, "family-a", code);
    const linkedUsers = context.documents.get("facilities/facility-a/users/User").lineUserIds;
    assert.equal(linkedUsers.length, 1);
    assert.equal(linkedUsers[0], "family-a");
});

test("LINE family record includes only custom fields marked for family display", async () => {
    const token = "d".repeat(64);
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const context = loadHandlers({
        "facilities/facility-a": {
            status: "active", commonLineEnabled: true,
            formCustomization: { customFields: [
                { id: "mood", label: "今日の気分", type: "text", familyVisible: true },
                { id: "staff", label: "職員メモ", type: "text", familyVisible: false }
            ] }
        },
        "facilities/facility-a/users/User": { lineUserIds: ["family-a"] },
        "facilities/facility-a/daily_records/2026-10-06_service_User": {
            facilityId: "facility-a", userName: "User", date: "2026-10-06", serviceType: "service",
            familyPublished: true,
            customFields: [
                { id: "mood", label: "今日の気分", type: "text", familyVisible: true, value: "元気" },
                { id: "staff", label: "職員メモ", type: "text", familyVisible: false, value: "内部のみ" }
            ]
        }
    });
    await sendFamilyEvent(context, "family-a");
    const reply = context.requests[0].body.messages[0].text;
    const viewerToken = reply.match(/token=([a-f0-9]{64})/)[1];
    const sharedRecord = await context.handlers.getLineSharedRecord({ data: { token: viewerToken } });
    assert.equal(sharedRecord.fields.some(field => field.label === "今日の気分" && field.value === "元気"), true);
    assert.equal(sharedRecord.fields.some(field => field.label === "職員メモ" || field.value === "内部のみ"), false);
});

test("LINE family record omits standard fields and media from hidden sections", async () => {
    const token = "e".repeat(64);
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const context = loadHandlers({
        "facilities/facility-a": { status: "active", commonLineEnabled: true },
        "facilities/facility-a/users/User": { lineUserIds: ["family-a"] },
        "facilities/facility-a/daily_records/2026-10-06_service_User": {
            facilityId: "facility-a", userName: "User", date: "2026-10-06", serviceType: "service",
            familyPublished: true, message: "施設内だけの連絡", familyMessage: "家庭連絡",
            hiddenFormSections: ["facilityMessageSection", "familyMessageSection", "mediaSection"], imageCount: 1
        },
        [`lineRecordLinks/${hash}`]: {
            facilityId: "facility-a", userName: "User", date: "2026-10-06", serviceType: "service",
            expiresAt: new Date(Date.now() + 60000)
        }
    });
    const sharedRecord = await context.handlers.getLineSharedRecord({ data: { token } });
    assert.equal(sharedRecord.fields.some(field => field.value === "施設内だけの連絡" || field.value === "家庭連絡"), false);
    assert.equal(sharedRecord.attachments.images.length, 0);
    assert.equal(sharedRecord.attachments.videos.length, 0);
});

test("removing a facility-specific copy of @805xgtzu preserves existing family links", async () => {
    const context = loadHandlers({
        "facilities/facility-a": { status: "active", commonLineEnabled: true },
        "facilityLineSettings/facility-a": { displayName: "えこすまいる連絡帳", basicId: "@805xgtzu" },
        "facilities/facility-a/users/User": { lineUserIds: ["family-a"] }
    });
    const result = await context.handlers.removeFacilityLineSettings({
        auth: { uid: "facility-a", token: { role: "facility" } }, data: {}
    });
    assert.equal(result.familyLinksPreserved, true);
    assert.equal(context.documents.has("facilityLineSettings/facility-a"), false);
    assert.equal(context.documents.get("facilities/facility-a/users/User").lineUserIds[0], "family-a");
});

test("administrator LINE stop blocks a dedicated account without deleting its links", async () => {
    const token = "c".repeat(64);
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const context = loadHandlers({
        "facilities/facility-a": { status: "active", commonLineEnabled: false, lineServiceEnabled: false },
        "facilityLineSettings/facility-a": { displayName: "Dedicated", basicId: "@dedicated" },
        "facilities/facility-a/users/User": { lineUserIds: ["family-a"] },
        [`lineRecordLinks/${hash}`]: { facilityId: "facility-a", userName: "User", date: "2026-10-06", serviceType: "service", lineAccountType: "dedicated", expiresAt: new Date(Date.now() + 60000) }
    });
    const request = { auth: { uid: "facility-a", token: { role: "facility" } }, data: { userName: "User", date: "2026-10-06", serviceType: "service" } };
    const status = await context.handlers.getFacilityLineSettingsStatus(request);
    assert.equal(status.configured, true);
    assert.equal(status.lineEnabled, false);
    const recipientStatus = await context.handlers.getLineRecipientStatus({ auth: request.auth, data: { userName: "User" } });
    assert.equal(recipientStatus.recipientCount, 1);
    assert.equal(recipientStatus.lineEnabled, false);
    await assert.rejects(context.handlers.createLinePairingCode(request), { code: "failed-precondition" });
    await assert.rejects(context.handlers.sendLineRecordNotification(request), { code: "failed-precondition" });
    await assert.rejects(context.handlers.getLineSharedRecord({ data: { token } }), { code: "permission-denied" });
    assert.equal(context.documents.has(`lineRecordLinks/${hash}`), true);
});

test("previously issued pairing code cannot bypass disabled common LINE", async () => {
    const code = "ABCDEF123456";
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const context = loadHandlers({
        "facilities/facility-a": { status: "active", commonLineEnabled: false },
        "facilities/facility-a/users/User": { lineUserIds: [] },
        [`linePairingCodes/${codeHash}`]: { facilityId: "facility-a", userName: "User", expiresAt: new Date(Date.now() + 60000) }
    });
    await sendFamilyEvent(context, "family-a", code);
    assert.equal(context.documents.get("facilities/facility-a/users/User").lineUserIds.length, 0);
    assert.equal(context.requests.length, 0);
    context.documents.get("facilities/facility-a").commonLineEnabled = true;
    await sendFamilyEvent(context, "family-a", code);
    assert.equal(context.documents.get("facilities/facility-a/users/User").lineUserIds.includes("family-a"), true);
    assert.equal(context.documents.has(`linePairingCodes/${codeHash}`), false);
    assert.equal(context.requests.length, 1);
});

test("issued shared viewing links are blocked after common LINE is stopped", async () => {
    const token = "a".repeat(64);
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const context = loadHandlers({
        "facilities/facility-a": { status: "active", commonLineEnabled: false },
        [`lineRecordLinks/${hash}`]: { facilityId: "facility-a", lineAccountType: "shared", expiresAt: new Date(Date.now() + 60000) }
    });
    await assert.rejects(context.handlers.getLineSharedRecord({ data: { token } }), { code: "permission-denied" });
    delete context.documents.get(`lineRecordLinks/${hash}`).lineAccountType;
    await assert.rejects(context.handlers.getLineSharedRecord({ data: { token } }), { code: "permission-denied" });
});

test("previously issued viewing links expire no later than three days after creation", async () => {
    const token = "e".repeat(64);
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const context = loadHandlers({
        "facilities/facility-a": { status: "active", facilityName: "Facility", commonLineEnabled: true },
        "facilities/facility-a/users/User": { photoNg: true },
        [`lineRecordLinks/${hash}`]: {
            facilityId: "facility-a",
            userName: "User",
            date: "2026-10-06",
            serviceType: "service",
            lineAccountType: "shared",
            createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
            expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
        }
    });
    await assert.rejects(context.handlers.getLineSharedRecord({ data: { token } }), { code: "unauthenticated" });
});

test("new trial registrations disable common LINE by default", async () => {
    const context = loadHandlers({});
    const result = await context.handlers.registerTrialFacility({ data: {
        registrationKey: "test-secret", acceptedTermsVersion: "2026-10-07-v1",
        facilityName: "Test Facility", password: "test-password", email: "test@example.invalid", phone: "03-1234-5678",
        contactPerson: "  Test Contact  "
    } });
    assert.equal(context.documents.get(`facilities/${result.facilityId}`).commonLineEnabled, false);
    assert.equal(context.documents.get(`facilities/${result.facilityId}`).contactPerson, "Test Contact");
    assert.equal(Object.hasOwn(context.documents.get(`facilities/${result.facilityId}`), "password"), false);
    assert.match(context.documents.get(`facilityCredentials/${result.facilityId}`).passwordHash, /^scrypt\$/);
    assert.equal(context.documents.get(`facilities/${result.facilityId}`).phone, "03-1234-5678");
    assert.match(context.sentEmails[0].text, /ご利用になるサービスにチェックを入れてください/);
    assert.match(context.sentEmails[0].text, /1サービスの場合は従来の料金.*2つ目以降は1サービスにつき税抜1,000円が加算されます/);
    assert.match(context.sentEmails[0].html, /ご利用になるサービスにチェックを入れてください/);
    assert.match(context.sentEmails[0].html, /2つ目以降は1サービスにつき税抜1,000円が加算されます/);
});

test("admin login requires a one-time email code and consumes it after successful verification", async () => {
    const context = loadHandlers({});
    const challenge = await context.handlers.createAdminLoginChallenge({
        data: { adminKey: "test-secret" }, rawRequest: { ip: "192.0.2.10" }
    });
    const code = context.sentEmails[0].text.match(/\d{6}/)[0];
    assert.equal(context.sentEmails[0].to, "test-secret");
    const result = await context.handlers.verifyAdminLoginCode({
        data: { challengeId: challenge.challengeId, code }, rawRequest: { ip: "192.0.2.10" }
    });
    assert.equal(result.customToken, "test-custom-token");
    assert.equal(context.customTokens[0].claims.mfaVerified, true);
    await assert.rejects(context.handlers.verifyAdminLoginCode({
        data: { challengeId: challenge.challengeId, code }, rawRequest: { ip: "192.0.2.10" }
    }), { code: "unauthenticated" });
});

test("admin login challenge requests are rate-limited by source IP", async () => {
    const context = loadHandlers({});
    for (let attempt = 0; attempt < 5; attempt++) {
        await assert.rejects(context.handlers.createAdminLoginChallenge({
            data: { adminKey: "wrong-key" }, rawRequest: { ip: "192.0.2.11" }
        }), { code: "unauthenticated" });
    }
    await assert.rejects(context.handlers.createAdminLoginChallenge({
        data: { adminKey: "wrong-key" }, rawRequest: { ip: "192.0.2.11" }
    }), { code: "resource-exhausted" });
});

test("facility can reset a forgotten password using a one-time code sent to its registered email", async () => {
    const context = loadHandlers({
        "facilities/facility-reset": {
            facilityName: "Facility Reset",
            email: "reset@example.invalid",
            password: "old-password",
            status: "active"
        }
    });
    const request = await context.handlers.requestFacilityPasswordReset({
        data: { facilityName: "Facility Reset", email: " RESET@example.invalid " },
        rawRequest: { ip: "192.0.2.20" }
    });
    assert.equal(request.accepted, true);
    assert.match(request.challengeId, /^[0-9a-f]{64}$/);
    assert.equal(context.sentEmails[0].to, "reset@example.invalid");
    const code = context.sentEmails[0].text.match(/\d{6}/)[0];

    const result = await context.handlers.completeFacilityPasswordReset({
        data: { challengeId: request.challengeId, code, newPassword: "new-password" },
        rawRequest: { ip: "192.0.2.20" }
    });
    assert.equal(result.success, true);
    assert.equal(Object.hasOwn(context.documents.get("facilities/facility-reset"), "password"), false);
    assert.match(context.documents.get("facilityCredentials/facility-reset").passwordHash, /^scrypt\$/);
    assert.equal(context.documents.has(`facilityPasswordResetChallenges/${request.challengeId}`), false);

    const login = await context.handlers.createFacilitySession({
        data: { facilityName: "Facility Reset", password: "new-password" }
    });
    assert.equal(login.facilityId, "facility-reset");
    await assert.rejects(context.handlers.createFacilitySession({
        data: { facilityName: "Facility Reset", password: "old-password" }
    }), { code: "unauthenticated" });
});

test("password reset does not reveal whether the facility name and email match", async () => {
    const context = loadHandlers({
        "facilities/facility-reset": {
            facilityName: "Facility Reset",
            email: "reset@example.invalid"
        }
    });
    const matching = await context.handlers.requestFacilityPasswordReset({
        data: { facilityName: "Facility Reset", email: "reset@example.invalid" },
        rawRequest: { ip: "192.0.2.21" }
    });
    const nonMatching = await context.handlers.requestFacilityPasswordReset({
        data: { facilityName: "Facility Reset", email: "wrong@example.invalid" },
        rawRequest: { ip: "192.0.2.22" }
    });
    assert.deepEqual(Object.keys(matching).sort(), Object.keys(nonMatching).sort());
    assert.equal(matching.accepted, true);
    assert.equal(nonMatching.accepted, true);
    assert.notEqual(matching.challengeId, nonMatching.challengeId);
    assert.equal(context.sentEmails.length, 1);
});

test("facility password reset codes are rate-limited by registered email", async () => {
    const context = loadHandlers({
        "facilities/facility-reset": {
            facilityName: "Facility Reset",
            email: "reset@example.invalid"
        }
    });
    for (let attempt = 0; attempt < 3; attempt++) {
        await context.handlers.requestFacilityPasswordReset({
            data: { facilityName: "Facility Reset", email: "reset@example.invalid" },
            rawRequest: { ip: `192.0.2.${30 + attempt}` }
        });
    }
    await assert.rejects(context.handlers.requestFacilityPasswordReset({
        data: { facilityName: "Facility Reset", email: "reset@example.invalid" },
        rawRequest: { ip: "192.0.2.40" }
    }), { code: "resource-exhausted" });
    assert.equal(context.sentEmails.length, 3);
});

test("facility password reset code is invalidated if the registered email changes", async () => {
    const context = loadHandlers({
        "facilities/facility-reset": {
            facilityName: "Facility Reset",
            email: "reset@example.invalid",
            password: "old-password"
        }
    });
    const request = await context.handlers.requestFacilityPasswordReset({
        data: { facilityName: "Facility Reset", email: "reset@example.invalid" },
        rawRequest: { ip: "192.0.2.41" }
    });
    const code = context.sentEmails[0].text.match(/\d{6}/)[0];
    context.documents.get("facilities/facility-reset").email = "changed@example.invalid";
    await assert.rejects(context.handlers.completeFacilityPasswordReset({
        data: { challengeId: request.challengeId, code, newPassword: "new-password" },
        rawRequest: { ip: "192.0.2.41" }
    }), { code: "unauthenticated" });
    assert.equal(context.documents.get("facilities/facility-reset").password, "old-password");
});

test("facility password reset rejects exhausted and expired codes without changing the password", async () => {
    const context = loadHandlers({
        "facilities/facility-reset": {
            facilityName: "Facility Reset",
            email: "reset@example.invalid",
            password: "old-password"
        }
    });
    const request = await context.handlers.requestFacilityPasswordReset({
        data: { facilityName: "Facility Reset", email: "reset@example.invalid" },
        rawRequest: { ip: "192.0.2.50" }
    });
    const code = context.sentEmails[0].text.match(/\d{6}/)[0];
    const wrongCode = code === "000000" ? "000001" : "000000";
    for (let attempt = 0; attempt < 5; attempt++) {
        await assert.rejects(context.handlers.completeFacilityPasswordReset({
            data: { challengeId: request.challengeId, code: wrongCode, newPassword: "new-password" },
            rawRequest: { ip: "192.0.2.50" }
        }), { code: "unauthenticated" });
    }
    await assert.rejects(context.handlers.completeFacilityPasswordReset({
        data: { challengeId: request.challengeId, code, newPassword: "new-password" },
        rawRequest: { ip: "192.0.2.50" }
    }), { code: "unauthenticated" });

    const expiredRequest = await context.handlers.requestFacilityPasswordReset({
        data: { facilityName: "Facility Reset", email: "reset@example.invalid" },
        rawRequest: { ip: "192.0.2.51" }
    });
    const expiredChallenge = context.documents.get(`facilityPasswordResetChallenges/${expiredRequest.challengeId}`);
    expiredChallenge.expiresAt = Date.now() - 1;
    const expiredCode = context.sentEmails[1].text.match(/\d{6}/)[0];
    await assert.rejects(context.handlers.completeFacilityPasswordReset({
        data: { challengeId: expiredRequest.challengeId, code: expiredCode, newPassword: "new-password" },
        rawRequest: { ip: "192.0.2.51" }
    }), { code: "unauthenticated" });
    assert.equal(context.documents.get("facilities/facility-reset").password, "old-password");
});

test("administrator can migrate legacy facility passwords without exposing them in facility documents", async () => {
    const context = loadHandlers({
        "facilities/legacy": { facilityName: "Legacy", password: "legacy-password" },
        "facilities/already-hashed": { facilityName: "Already hashed", password: "old-password" },
        "facilityCredentials/already-hashed": {
            passwordHash: `scrypt$${"a".repeat(32)}$${"b".repeat(128)}`
        }
    });
    const result = await context.handlers.migrateLegacyFacilityPasswords({
        auth: { uid: "admin-control-panel", token: { role: "admin", mfaVerified: true } }
    });
    assert.equal(result.checked, 2);
    assert.equal(result.migrated, 1);
    assert.equal(result.cleaned, 1);
    assert.equal(Object.hasOwn(context.documents.get("facilities/legacy"), "password"), false);
    assert.equal(Object.hasOwn(context.documents.get("facilities/already-hashed"), "password"), false);
    assert.match(context.documents.get("facilityCredentials/legacy").passwordHash, /^scrypt\$/);
    await assert.rejects(context.handlers.migrateLegacyFacilityPasswords({
        auth: { uid: "facility-a", token: { role: "facility" } }
    }), { code: "unauthenticated" });
    await assert.rejects(context.handlers.migrateLegacyFacilityPasswords({
        auth: { uid: "admin-control-panel", token: { role: "admin" } }
    }), { code: "unauthenticated" });
});

test("trial registration requires a contact phone number", async () => {
    const context = loadHandlers({});
    await assert.rejects(context.handlers.registerTrialFacility({ data: {
        registrationKey: "test-secret", acceptedTermsVersion: "2026-10-07-v1",
        facilityName: "Test Facility", password: "test-password", email: "test@example.invalid", contactPerson: "Test"
    } }), { code: "invalid-argument" });
});

test("trial registration rejects missing, blank, non-string and overlong contact names", async () => {
    for (const contactPerson of [undefined, "", "   ", 123, "a".repeat(101)]) {
        const context = loadHandlers({});
        await assert.rejects(context.handlers.registerTrialFacility({ data: {
            acceptedTermsVersion: "2026-10-07-v1", facilityName: "Test Facility",
            password: "test-password", email: "test@example.invalid", phone: "03-1234-5678", contactPerson
        } }), { code: "invalid-argument" });
        assert.equal(context.documents.size, 0);
        assert.equal(context.sentEmails.length, 0);
    }
});

test("manual invoice issuance is restricted to administrators", async () => {
    const context = loadHandlers({});
    await assert.rejects(context.handlers.issueFacilityInvoiceForAdmin({
        auth: { uid: "facility-a", token: { role: "facility" } },
        data: { facilityId: "facility-a" }
    }), { code: "unauthenticated" });
});

test("manual invoice issuance rejects a missing facility identifier", async () => {
    const context = loadHandlers({});
    await assert.rejects(context.handlers.issueFacilityInvoiceForAdmin({
        auth: { uid: "admin-control-panel", token: { role: "admin", mfaVerified: true } }, data: {}
    }), { code: "invalid-argument" });
});

test("manual initial invoice issuance prevents duplicate sent invoices", async () => {
    const context = loadHandlers({
        "facilities/facility-a": {
            facilityName: "Facility", email: "facility@example.invalid", subscriptionStatus: "trial"
        },
        "facilities/facility-a/invoiceHistory/INITIAL": { status: "sent", invoiceNumber: "INIT-20261015-FACILITY-A" }
    });
    await assert.rejects(context.handlers.issueFacilityInvoiceForAdmin({
        auth: { uid: "admin-control-panel", token: { role: "admin", mfaVerified: true } },
        data: { facilityId: "facility-a" }
    }), { code: "already-exists" });
});

test("manual monthly invoice issuance prevents duplicate automatic invoices", async () => {
    const activationDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(activationDate).map(part => [part.type, part.value]));
    const periodStart = `${parts.year}-${parts.month}-${parts.day}`;
    const context = loadHandlers({
        "facilities/facility-a": {
            facilityName: "Facility", email: "facility@example.invalid", status: "active",
            subscriptionStatus: "active", createdAt: activationDate.toISOString()
        },
        [`facilities/facility-a/invoiceHistory/AUTO-${periodStart.replace(/-/g, "")}`]: { status: "sent" }
    });
    await assert.rejects(context.handlers.issueFacilityInvoiceForAdmin({
        auth: { uid: "admin-control-panel", token: { role: "admin", mfaVerified: true } },
        data: { facilityId: "facility-a" }
    }), { code: "already-exists" });
});

test("manual invoices include selected services and the matching additional service charge", async () => {
    const activationDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const context = loadHandlers({
        "facilities/facility-b": {
            facilityName: "Facility B", email: "facility@example.invalid", status: "active",
            subscriptionStatus: "active", createdAt: activationDate.toISOString(),
            enabledServiceTypes: ["デイサービス", "生活介護"],
            billingServiceTypes: ["デイサービス", "生活介護"]
        }
    });
    const result = await context.handlers.issueFacilityInvoiceForAdmin({
        auth: { uid: "admin-control-panel", token: { role: "admin", mfaVerified: true } },
        data: { facilityId: "facility-b" }
    });
    const invoice = [...context.documents.entries()].find(([path]) =>
        path.startsWith("facilities/facility-b/invoiceHistory/AUTO-"))[1];

    assert.equal(result.type, "monthly");
    assert.deepEqual(invoice.serviceTypes, ["デイサービス", "生活介護"]);
    assert.equal(invoice.additionalServiceSubtotal, 1000);
    assert.equal(invoice.subtotal, 6000);
    assert.equal(invoice.tax, 600);
    assert.equal(invoice.total, 6600);
    assert.match(context.sentEmails[0].html, /利用サービス/);
    assert.match(context.sentEmails[0].html, /デイサービス、生活介護/);
    assert.match(context.sentEmails[0].html, /追加サービス利用料/);
    assert.match(context.sentEmails[0].html, /6,600円/);
    assert.equal(context.sentEmails.length, 2);
    assert.equal(context.sentEmails[1].to, "ecosmile39@gmail.com");
    assert.match(context.sentEmails[1].subject, /【請求書送信完了】Facility B/);
    assert.match(context.sentEmails[1].text, /施設の請求書を送信しました。/);
    assert.match(context.sentEmails[1].text, /送信先：facility@example.invalid/);
    assert.match(context.sentEmails[1].text, /6,600円/);
    assert.ok(context.sentEmails[1].text.includes(invoice.invoiceNumber));
    assert.equal(invoice.adminNotificationStatus, "sent");
    assert.equal(invoice.adminNotificationMessageId, "test-message-2");
});

test("manual invoice charges a saved one-time adjustment once and clears it after sending", async () => {
    const activationDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const adjustment = { id: "fee-change-1", description: "入力項目変更手数料", amount: 3000 };
    const context = loadHandlers({
        "facilities/facility-fee": {
            facilityName: "Facility Fee", email: "facility@example.invalid", status: "active",
            subscriptionStatus: "active", createdAt: activationDate.toISOString(),
            pendingInvoiceAdjustment: adjustment
        }
    });

    await context.handlers.issueFacilityInvoiceForAdmin({
        auth: { uid: "admin-control-panel", token: { role: "admin", mfaVerified: true } },
        data: { facilityId: "facility-fee" }
    });
    const invoice = [...context.documents.entries()].find(([path]) =>
        path.startsWith("facilities/facility-fee/invoiceHistory/AUTO-"))[1];
    const facility = context.documents.get("facilities/facility-fee");

    assert.deepEqual(invoice.oneTimeAdjustment, adjustment);
    assert.equal(invoice.subtotal, 8000);
    assert.equal(invoice.tax, 800);
    assert.equal(invoice.total, 8800);
    assert.match(context.sentEmails[0].html, /入力項目変更手数料/);
    assert.match(context.sentEmails[0].text, /入力項目変更手数料：3,000円/);
    assert.equal(facility.pendingInvoiceAdjustment, undefined);
    assert.equal(facility.lastConsumedInvoiceAdjustmentId, adjustment.id);
});

test("automatic monthly invoices include the saved services and surcharge", async () => {
    const activationDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const context = loadHandlers({
        "facilities/facility-e": {
            facilityName: "Facility E", email: "facility@example.invalid", status: "active",
            subscriptionStatus: "active", createdAt: activationDate.toISOString(),
            billingServiceTypes: ["デイサービス", "生活介護", "児童発達支援"]
        }
    });
    await context.handlers.sendMonthlyInvoices();
    const invoice = [...context.documents.entries()].find(([path]) =>
        path.startsWith("facilities/facility-e/invoiceHistory/AUTO-"))[1];

    assert.deepEqual(invoice.serviceTypes, ["デイサービス", "児童発達支援", "生活介護"]);
    assert.equal(invoice.additionalServiceSubtotal, 2000);
    assert.equal(invoice.subtotal, 7000);
    assert.equal(invoice.tax, 700);
    assert.equal(invoice.total, 7700);
    assert.match(context.sentEmails[0].html, /デイサービス、児童発達支援、生活介護/);
    assert.match(context.sentEmails[0].html, /7,700円/);
    assert.equal(context.sentEmails.length, 2);
    assert.equal(context.sentEmails[1].to, "ecosmile39@gmail.com");
    assert.match(context.sentEmails[1].subject, /【請求書送信完了】Facility E/);
    assert.match(context.sentEmails[1].text, /7,700円/);
    assert.equal(invoice.adminNotificationStatus, "sent");
    await context.handlers.sendMonthlyInvoices();
    assert.equal(context.sentEmails.length, 2);
});

test("automatic monthly invoice includes a pending one-time adjustment and consumes it after sending", async () => {
    const activationDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const adjustment = { id: "fee-change-2", description: "個別帳票作成料", amount: 2500 };
    const context = loadHandlers({
        "facilities/facility-auto-fee": {
            facilityName: "Facility Auto Fee", email: "facility@example.invalid", status: "active",
            subscriptionStatus: "active", createdAt: activationDate.toISOString(),
            pendingInvoiceAdjustment: adjustment
        }
    });

    await context.handlers.sendMonthlyInvoices();
    const invoice = [...context.documents.entries()].find(([path]) =>
        path.startsWith("facilities/facility-auto-fee/invoiceHistory/AUTO-"))[1];
    const facility = context.documents.get("facilities/facility-auto-fee");

    assert.deepEqual(invoice.oneTimeAdjustment, adjustment);
    assert.equal(invoice.subtotal, 7500);
    assert.equal(invoice.tax, 750);
    assert.equal(invoice.total, 8250);
    assert.match(context.sentEmails[0].html, /個別帳票作成料/);
    assert.equal(facility.pendingInvoiceAdjustment, undefined);
    assert.equal(facility.lastConsumedInvoiceAdjustmentId, adjustment.id);
});

test("billing service settings are saved independently from input service settings", async () => {
    const context = loadHandlers({
        "facilities/facility-d": {
            enabledServiceTypes: ["デイサービス"],
            billingServiceTypes: ["デイサービス"]
        }
    });
    await assert.rejects(context.handlers.updateFacilityBillingServiceTypes({
        auth: { uid: "facility-d", token: { role: "facility" } },
        data: { facilityId: "facility-d", serviceTypes: ["デイサービス"] }
    }), { code: "unauthenticated" });
    await assert.rejects(context.handlers.updateFacilityBillingServiceTypes({
        auth: { uid: "admin-control-panel", token: { role: "admin", mfaVerified: true } },
        data: { facilityId: "facility-d", serviceTypes: [] }
    }), { code: "invalid-argument" });
    const result = await context.handlers.updateFacilityBillingServiceTypes({
        auth: { uid: "admin-control-panel", token: { role: "admin", mfaVerified: true } },
        data: { facilityId: "facility-d", serviceTypes: ["生活介護", "デイサービス"] }
    });

    assert.deepEqual(result.serviceTypes, ["デイサービス", "生活介護"]);
    assert.deepEqual(context.documents.get("facilities/facility-d").enabledServiceTypes, ["デイサービス"]);
    assert.deepEqual(context.documents.get("facilities/facility-d").billingServiceTypes, ["デイサービス", "生活介護"]);
});

test("initial subscription invoices include the chosen billing services and surcharge", async () => {
    const context = loadHandlers({
        "facilities/facility-c": {
            facilityName: "Facility C", email: "facility@example.invalid", status: "active",
            subscriptionStatus: "trial",
            trialEndsAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
            enabledServiceTypes: ["デイサービス", "生活介護"],
            billingServiceTypes: ["生活介護", "児童発達支援"]
        }
    });
    const result = await context.handlers.requestFacilitySubscription({
        auth: { uid: "facility-c", token: { role: "facility" } },
        data: { serviceTypes: ["生活介護", "児童発達支援"] }
    });
    const invoice = context.documents.get("facilities/facility-c/invoiceHistory/INITIAL");
    const facility = context.documents.get("facilities/facility-c");

    assert.equal(result.status, "pending_payment");
    assert.deepEqual(invoice.serviceTypes, ["児童発達支援", "生活介護"]);
    assert.deepEqual(facility.enabledServiceTypes, ["児童発達支援", "生活介護"]);
    assert.deepEqual(facility.billingServiceTypes, ["児童発達支援", "生活介護"]);
    assert.equal(invoice.additionalServiceSubtotal, 1000);
    assert.equal(invoice.subtotal, 5000);
    assert.equal(invoice.tax, 500);
    assert.equal(invoice.total, 5500);
    assert.match(context.sentEmails[0].html, /児童発達支援、生活介護/);
    assert.match(context.sentEmails[0].html, /追加サービス利用料/);
    assert.match(context.sentEmails[0].html, /5,500円/);
    assert.equal(context.sentEmails.length, 2);
    assert.equal(context.sentEmails[1].to, "ecosmile39@gmail.com");
    assert.match(context.sentEmails[1].subject, /【請求書送信完了】Facility C/);
    assert.match(context.sentEmails[1].text, /5,500円/);
    assert.equal(invoice.adminNotificationStatus, "sent");
    await context.handlers.requestFacilitySubscription({
        auth: { uid: "facility-c", token: { role: "facility" } },
        data: { serviceTypes: ["生活介護", "児童発達支援"] }
    });
    assert.equal(context.sentEmails.length, 2);
});

for (const mode of ["initial", "manual-initial", "manual-monthly", "automatic"]) {
    for (const failure of ["facility", "admin"]) {
        test(`${mode} invoice handles ${failure} email failure without duplicate facility delivery`, async () => {
            const initial = mode === "initial" || mode === "manual-initial";
            const context = loadHandlers({
                "facilities/notification-test": {
                    facilityName: "Notification Test", email: "facility@example.invalid", status: "active",
                    subscriptionStatus: initial ? "trial" : "active",
                    trialEndsAt: new Date(Date.now() + 86400000).toISOString(),
                    createdAt: new Date(Date.now() - 20 * 86400000).toISOString(),
                    billingServiceTypes: ["デイサービス"],
                    pendingInvoiceAdjustment: { id: "notification-fee", description: "変更手数料", amount: 1000 }
                }
            }, {
                sendMail(message) {
                    if (message.to === (failure === "admin" ? "ecosmile39@gmail.com" : "facility@example.invalid")) {
                        throw new Error("Simulated email delivery failure");
                    }
                }
            });
            const invoke = () => {
                if (mode === "automatic") return context.handlers.sendMonthlyInvoices();
                if (mode === "initial") return context.handlers.requestFacilitySubscription({
                    auth: { uid: "notification-test", token: { role: "facility" } },
                    data: { serviceTypes: ["デイサービス"] }
                });
                return context.handlers.issueFacilityInvoiceForAdmin({
                    auth: { uid: "admin-control-panel", token: { role: "admin", mfaVerified: true } },
                    data: { facilityId: "notification-test" }
                });
            };
            if (failure === "facility" && mode !== "automatic") {
                await assert.rejects(invoke(), { code: "internal" });
            } else {
                await invoke();
            }
            const invoice = [...context.documents.entries()].find(([path]) =>
                path.startsWith("facilities/notification-test/invoiceHistory/"))[1];
            assert.equal(invoice.status, failure === "facility" ? "failed" : "sent");
            assert.equal(context.sentEmails.length, failure === "facility" ? 1 : 2);
            assert.equal(invoice.adminNotificationStatus, failure === "admin" ? "failed" : undefined);
            if (failure === "admin") {
                assert.match(invoice.adminNotificationFailureMessage, /Simulated email delivery failure/);
                assert.ok(context.loggedErrors.some(([message]) =>
                    message === "Invoice sent but administrator notification failed"));
                if (mode !== "initial") {
                    assert.equal(context.documents.get("facilities/notification-test").pendingInvoiceAdjustment, undefined);
                }
                if (mode.startsWith("manual")) {
                    await assert.rejects(invoke(), { code: "already-exists" });
                } else {
                    await invoke();
                }
                assert.equal(context.sentEmails.length, 2);
            }
        });
    }
}

test("manual initial invoices also notify the administrator", async () => {
    const context = loadHandlers({
        "facilities/manual-initial": {
            facilityName: "Manual Initial", email: "facility@example.invalid",
            status: "active", subscriptionStatus: "trial",
            billingServiceTypes: ["デイサービス"]
        }
    });
    await context.handlers.issueFacilityInvoiceForAdmin({
        auth: { uid: "admin-control-panel", token: { role: "admin", mfaVerified: true } },
        data: { facilityId: "manual-initial" }
    });
    const invoice = context.documents.get("facilities/manual-initial/invoiceHistory/INITIAL");
    assert.equal(invoice.status, "sent");
    assert.equal(invoice.adminNotificationStatus, "sent");
    assert.equal(context.sentEmails.length, 2);
    assert.equal(context.sentEmails[1].to, "ecosmile39@gmail.com");
    assert.match(context.sentEmails[1].text, /4,400円/);
});

test("initial subscription saves residential selections to available services, billing and invoice", async () => {
    const context = loadHandlers({
        "facilities/facility-residential": {
            facilityName: "Facility Residential", email: "facility@example.invalid", status: "active",
            subscriptionStatus: "trial",
            trialEndsAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString()
        }
    });
    await context.handlers.requestFacilitySubscription({
        auth: { uid: "facility-residential", token: { role: "facility" } },
        data: { serviceTypes: ["ユニット入所", "入所"] }
    });

    const facility = context.documents.get("facilities/facility-residential");
    const invoice = context.documents.get("facilities/facility-residential/invoiceHistory/INITIAL");
    assert.deepEqual(facility.enabledServiceTypes, ["入所", "ユニット入所"]);
    assert.deepEqual(facility.billingServiceTypes, ["入所", "ユニット入所"]);
    assert.deepEqual(invoice.serviceTypes, facility.billingServiceTypes);
    assert.equal(invoice.additionalServiceSubtotal, 1000);
    assert.equal(invoice.total, 5500);
    assert.match(context.sentEmails[0].html, /入所、ユニット入所/);
});

test("repeated initial subscription requests keep facility services aligned with the sent invoice", async () => {
    const invoiceServices = ["デイサービス", "生活介護"];
    const context = loadHandlers({
        "facilities/facility-already-invoiced": {
            facilityName: "Facility", email: "facility@example.invalid", status: "active",
            subscriptionStatus: "trial",
            trialEndsAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString()
        },
        "facilities/facility-already-invoiced/invoiceHistory/INITIAL": {
            status: "sent", serviceTypes: invoiceServices
        }
    });
    await context.handlers.requestFacilitySubscription({
        auth: { uid: "facility-already-invoiced", token: { role: "facility" } },
        data: { serviceTypes: ["児童発達支援"] }
    });

    const facility = context.documents.get("facilities/facility-already-invoiced");
    assert.deepEqual(facility.enabledServiceTypes, invoiceServices);
    assert.deepEqual(facility.billingServiceTypes, invoiceServices);
    assert.deepEqual(context.documents.get("facilities/facility-already-invoiced/invoiceHistory/INITIAL").serviceTypes, invoiceServices);
    assert.equal(context.sentEmails.length, 0);
});

test("expired locked trial can sign in with a registration-only session", async () => {
    const context = loadHandlers({
        "facilities/expired-facility": {
            facilityName: "Expired Facility", password: "secret", status: "locked",
            subscriptionStatus: "trial", trialEndsAt: new Date(Date.now() - 60_000).toISOString()
        }
    });
    const result = await context.handlers.createFacilitySession({
        data: { facilityName: "Expired Facility", password: "secret" }
    });

    assert.equal(result.registrationOnly, true);
    assert.equal(result.customToken, "test-custom-token");
    assert.equal(context.customTokens[0].uid, "expired-facility");
    assert.equal(context.customTokens[0].claims.role, "facility");
    assert.equal(context.customTokens[0].claims.registrationOnly, true);
});

test("expired locked trial can submit selected services and receive its initial invoice", async () => {
    const context = loadHandlers({
        "facilities/expired-facility": {
            facilityName: "Expired Facility", email: "facility@example.invalid", status: "locked",
            subscriptionStatus: "trial", trialEndsAt: new Date(Date.now() - 60_000).toISOString()
        }
    });
    const result = await context.handlers.requestFacilitySubscription({
        auth: { uid: "expired-facility", token: { role: "facility", registrationOnly: true } },
        data: { serviceTypes: ["デイサービス", "生活介護", "児童発達支援"] }
    });
    const facility = context.documents.get("facilities/expired-facility");
    const invoice = context.documents.get("facilities/expired-facility/invoiceHistory/INITIAL");

    assert.equal(result.status, "pending_payment");
    assert.deepEqual(facility.enabledServiceTypes, ["デイサービス", "児童発達支援", "生活介護"]);
    assert.deepEqual(facility.billingServiceTypes, ["デイサービス", "児童発達支援", "生活介護"]);
    assert.deepEqual(invoice.serviceTypes, facility.billingServiceTypes);
    assert.equal(invoice.subtotal, 6000);
    assert.equal(invoice.tax, 600);
    assert.equal(invoice.total, 6600);
    assert.match(context.sentEmails[0].html, /デイサービス、児童発達支援、生活介護/);
    assert.match(context.sentEmails[0].html, /6,600円/);
});

test("initial subscription rejects an empty service selection", async () => {
    const context = loadHandlers({
        "facilities/facility-empty-selection": {
            email: "facility@example.invalid", status: "active", subscriptionStatus: "trial",
            trialEndsAt: new Date(Date.now() + 60_000).toISOString()
        }
    });
    await assert.rejects(context.handlers.requestFacilitySubscription({
        auth: { uid: "facility-empty-selection", token: { role: "facility" } },
        data: { serviceTypes: [] }
    }), { code: "invalid-argument" });
    assert.equal(context.sentEmails.length, 0);
});

test("dedicated viewing links remain valid when common LINE is stopped", async () => {
    const token = "b".repeat(64);
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const context = loadHandlers({
        "facilities/facility-a": { status: "active", facilityName: "Dedicated Facility", commonLineEnabled: false },
        "facilityLineSettings/facility-a": { basicId: "@dedicated" },
        "facilities/facility-a/users/User": { photoNg: true },
        "facilities/facility-a/daily_records/2026-10-06_service_User": { facilityId: "facility-a", userName: "User", date: "2026-10-06", serviceType: "service" },
        [`lineRecordLinks/${hash}`]: { facilityId: "facility-a", userName: "User", date: "2026-10-06", serviceType: "service", lineAccountType: "dedicated", expiresAt: new Date(Date.now() + 60000) }
    });
    const result = await context.handlers.getLineSharedRecord({ data: { token } });
    assert.equal(result.facilityName, "Dedicated Facility");
    assert.equal(result.userName, "User");
});

test("facility can check only its own access status without receiving private data", async () => {
    const context = loadHandlers({
        "facilities/locked": { status: "locked", password: "private-password", email: "private@example.invalid" },
        "facilities/active": { status: "active" }
    });
    const locked = await context.handlers.getFacilityAccessStatus({
        auth: { uid: "locked", token: { role: "facility" } }, data: { facilityId: "active" }
    });
    assert.equal(locked.status, "locked");
    assert.deepEqual(Object.keys(locked), ["status"]);
    const active = await context.handlers.getFacilityAccessStatus({ auth: { uid: "active", token: { role: "facility" } } });
    assert.equal(active.status, "active");
    const missing = await context.handlers.getFacilityAccessStatus({ auth: { uid: "missing", token: { role: "facility" } } });
    assert.equal(missing.status, "missing");
    await assert.rejects(context.handlers.getFacilityAccessStatus({}), { code: "unauthenticated" });
    await assert.rejects(context.handlers.getFacilityAccessStatus({ auth: { uid: "locked", token: { role: "admin" } } }), { code: "unauthenticated" });
});