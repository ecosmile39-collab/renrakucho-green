const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const source = readFileSync(path.join(__dirname, "index.js"), "utf8");

function scheduleOptions(name) {
    const start = source.indexOf(`exports.${name} = onSchedule({`);
    assert.notEqual(start, -1, `${name} must use an options object`);
    const end = source.indexOf("}, withJobStatus(", start);
    return source.slice(start, end);
}

function functionBody(name) {
    const start = source.indexOf(`exports.${name} = onSchedule(`);
    const next = source.indexOf("\nexports.", start + 1);
    return source.slice(start, next === -1 ? undefined : next);
}

test("daily scheduled jobs retry when a run fails, so one cold-start error does not skip a day", () => {
    for (const name of [
        "exportDailyRecordsBackup",
        "sendMonthlyInvoices",
        "sendTrialExpiryReminders",
        "deleteExpiredLineLinks",
        "cleanExpiredAdminLoginData"
    ]) {
        const options = scheduleOptions(name);
        assert.match(options, /retryCount: 3/, `${name} retryCount`);
        assert.match(options, /minBackoffSeconds: 120/, `${name} minBackoffSeconds`);
    }
});

test("retried email jobs keep their duplicate-send guards", () => {
    const invoices = functionBody("sendMonthlyInvoices");
    assert.match(invoices, /if \(history\.status === "sent"\) return null;/);
    assert.match(invoices, /history\.status === "sending" && Date\.now\(\) - attemptStartedAt < 60 \* 60 \* 1000/);
    assert.match(invoices, /doc\(`AUTO-\$\{monthlyInvoiceKey\(period\.startDate, facility\)\}`\)/);

    const reminders = functionBody("sendTrialExpiryReminders");
    assert.match(reminders, /if \(currentFacility\.trialReminderStatus === "sent"\) return false;/);
    assert.match(reminders, /currentFacility\.trialReminderStatus === "sending" && Date\.now\(\) - attemptStartedAt < 60 \* 60 \* 1000/);
});

test("retry delay stays inside the one-hour sending lock", () => {
    // retryCount 3 with at most 600 seconds between attempts finishes well within 60 minutes,
    // so a retry never re-sends an invoice that an earlier attempt is still sending.
    for (const name of ["sendMonthlyInvoices", "sendTrialExpiryReminders"]) {
        assert.match(scheduleOptions(name), /maxBackoffSeconds: 600/);
    }
});
