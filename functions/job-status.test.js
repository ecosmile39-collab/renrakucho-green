const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { createJobStatusWrapper } = require("./job-status");

function fakeDb({ failWrites = false } = {}) {
    const docs = new Map();
    return {
        docs,
        collection: name => ({ doc: id => ({ set: async (data) => {
            if (failWrites) throw new Error("firestore down");
            docs.set(`${name}/${id}`, { ...(docs.get(`${name}/${id}`) || {}), ...data });
        } }) })
    };
}

test("a successful run records success time and the returned summary", async () => {
    const db = fakeDb();
    const withJobStatus = createJobStatusWrapper(() => db, { warn() {} });
    const result = await withJobStatus("sendMonthlyInvoices", async () => ({ sent: 2, failed: 0 }))();
    assert.deepEqual(result, { sent: 2, failed: 0 });
    const status = db.docs.get("systemStatus/sendMonthlyInvoices");
    assert.equal(status.lastStatus, "success");
    assert.ok(status.lastSuccessAt instanceof Date);
    assert.deepEqual(status.details, { sent: 2, failed: 0 });
    assert.equal(status.lastError, "");
});

test("a failed run records the error and still fails so Cloud Scheduler retries it", async () => {
    const db = fakeDb();
    const withJobStatus = createJobStatusWrapper(() => db, { warn() {} });
    await assert.rejects(withJobStatus("exportDailyRecordsBackup", async () => { throw new Error("export failed"); })(), /export failed/);
    const status = db.docs.get("systemStatus/exportDailyRecordsBackup");
    assert.equal(status.lastStatus, "error");
    assert.equal(status.lastError, "export failed");
    assert.equal(status.lastSuccessAt, undefined);
});

test("status recording problems never stop the real job", async () => {
    const warnings = [];
    const withJobStatus = createJobStatusWrapper(() => fakeDb({ failWrites: true }), { warn: (...args) => warnings.push(args) });
    assert.equal(await withJobStatus("lockExpiredTrials", async () => "done")(), "done");
    assert.ok(warnings.length >= 2);
});

test("every scheduled function records its status", () => {
    const source = readFileSync(path.join(__dirname, "index.js"), "utf8");
    const scheduled = [...source.matchAll(/exports\.(\w+) = onSchedule\(/g)].map(match => match[1]);
    assert.ok(scheduled.length >= 9);
    for (const name of scheduled) {
        const start = source.indexOf(`exports.${name} = onSchedule(`);
        const header = source.slice(start, source.indexOf("async () => {", start) + 13);
        assert.ok(header.includes(`withJobStatus("${name}", async () => {`), name);
    }
});
