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
            path: referencePath,
            collection: name => collection(`${referencePath}/${name}`),
            async get() {
                return { exists: documents.has(referencePath), id: this.id, ref: this,
                    data: () => documents.get(referencePath) };
            },
            async update(fields) { documents.set(referencePath, { ...documents.get(referencePath), ...fields }); },
            async set(fields, options) { documents.set(referencePath, options?.merge ? { ...documents.get(referencePath), ...fields } : fields); }
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
                return { docs, empty: docs.length === 0 };
            }
        };
    }
    const mockRequire = name => {
        if (name === "firebase-admin/app") return { initializeApp() {} };
        if (name === "firebase-admin/auth") return { getAuth: () => ({ createCustomToken: async () => "test-custom-token" }) };
        if (name === "firebase-admin/firestore") return {
            getFirestore: () => ({ collection, runTransaction: callback => callback({
                get: reference => reference.get(),
                set: (reference, fields, options) => reference.set(fields, options),
                delete: reference => documents.delete(reference.path)
            }) }), FieldValue: { serverTimestamp: () => "timestamp" }
        };
        if (name === "firebase-admin/storage") return {};
        if (name === "firebase-functions/v2/scheduler") return { onSchedule: (...args) => args.at(-1) };
        if (name === "firebase-functions/v2/https") return {
            onCall: (...args) => args.at(-1), onRequest: (...args) => args.at(-1),
            HttpsError: class extends Error { constructor(code, message) { super(message); this.code = code; } }
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

async function sendFamilyEvent(context, userId, text = "連絡帳を見る") {
    const body = { events: [{ type: "message", source: { userId }, replyToken: "test-reply",
        message: { type: "text", text } }] };
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

test("new trial registrations disable common LINE by default", async () => {
    const context = loadHandlers({});
    const result = await context.handlers.registerTrialFacility({ data: {
        registrationKey: "test-secret", acceptedTermsVersion: "2026-10-07-v1",
        facilityName: "Test Facility", password: "test-password", email: "test@example.invalid"
    } });
    assert.equal(context.documents.get(`facilities/${result.facilityId}`).commonLineEnabled, false);
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