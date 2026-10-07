const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isFamilyRecordRequest, latestPublishedRecords } = require("./line-family-records");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");

function loadHandlers(entries) {
    const documents = new Map(Object.entries(entries));
    const requests = [];
    function document(referencePath) {
        return {
            id: referencePath.split("/").at(-1),
            collection: name => collection(`${referencePath}/${name}`),
            async get() {
                return { exists: documents.has(referencePath), id: this.id, ref: this,
                    data: () => documents.get(referencePath) };
            },
            async update(fields) { documents.set(referencePath, { ...documents.get(referencePath), ...fields }); },
            async set(fields) { documents.set(referencePath, fields); }
        };
    }
    function collection(collectionPath, conditions = []) {
        return {
            doc: name => document(`${collectionPath}/${name}`),
            where: (field, operator, value) => collection(collectionPath, [...conditions, { field, operator, value }]),
            async get() {
                const docs = [];
                for (const [referencePath, data] of documents) {
                    if (referencePath.slice(0, referencePath.lastIndexOf("/")) !== collectionPath) continue;
                    if (!conditions.every(({ field, operator, value }) => operator === "array-contains"
                        ? data[field]?.includes(value) : data[field] === value)) continue;
                    docs.push(await document(referencePath).get());
                }
                return { docs, empty: docs.length === 0 };
            }
        };
    }
    const mockRequire = name => {
        if (name === "firebase-admin/app") return { initializeApp() {} };
        if (name === "firebase-admin/auth") return {};
        if (name === "firebase-admin/firestore") return {
            getFirestore: () => ({ collection }), FieldValue: { serverTimestamp: () => "timestamp" }
        };
        if (name === "firebase-admin/storage") return {};
        if (name === "firebase-functions/v2/scheduler") return { onSchedule: (...args) => args.at(-1) };
        if (name === "firebase-functions/v2/https") return {
            onCall: (...args) => args.at(-1), onRequest: (...args) => args.at(-1), HttpsError: Error
        };
        if (name === "firebase-functions/params") return { defineSecret: () => ({ value: () => "test-secret" }) };
        if (name === "firebase-functions/logger") return { warn() {}, error() {}, info() {} };
        if (name === "nodemailer" || name === "google-auth-library") return {};
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
    return { handlers: sandbox.exports, documents, requests };
}

async function sendFamilyEvent(context, userId) {
    const body = { events: [{ type: "message", source: { userId }, replyToken: "test-reply",
        message: { type: "text", text: "連絡帳を見る" } }] };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = crypto.createHmac("sha256", "test-secret").update(rawBody).digest("base64");
    const response = { status(value) { this.statusCode = value; return this; }, send(value) { this.body = value; return this; } };
    await context.handlers.lineMessagingWebhook({ method: "POST", body, rawBody, get: () => signature }, response);
    assert.equal(response.statusCode, 200);
}

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