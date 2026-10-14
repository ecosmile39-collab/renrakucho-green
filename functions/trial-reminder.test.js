"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { daysUntilTrialEnds, isTrialReminderDue } = require("./trial-reminder");

test("trial reminder is due three Tokyo calendar days before expiry", () => {
    const now = new Date("2026-10-14T09:00:00+09:00");
    assert.equal(daysUntilTrialEnds("2026-10-17T23:59:00+09:00", now), 3);
    assert.equal(isTrialReminderDue("2026-10-17T23:59:00+09:00", now), true);
});

test("trial reminder accepts late retries before expiry but not after expiry", () => {
    const now = new Date("2026-10-14T09:00:00+09:00");
    assert.equal(isTrialReminderDue("2026-10-18T00:00:00+09:00", now), false);
    assert.equal(isTrialReminderDue("2026-10-15T23:59:00+09:00", now), true);
    assert.equal(isTrialReminderDue("2026-10-14T23:59:00+09:00", now), false);
    assert.equal(isTrialReminderDue("2026-10-13T23:59:00+09:00", now), false);
});

test("trial reminder compares Tokyo calendar dates across UTC boundaries", () => {
    const now = new Date("2026-10-14T16:30:00Z");
    const trialEndsAt = new Date("2026-10-17T15:30:00Z");
    assert.equal(daysUntilTrialEnds(trialEndsAt, now), 3);
    assert.equal(isTrialReminderDue(trialEndsAt, now), true);
});

test("invalid trial dates are not eligible for reminders", () => {
    assert.equal(daysUntilTrialEnds("invalid", new Date("2026-10-14T09:00:00+09:00")), null);
    assert.equal(isTrialReminderDue("invalid", new Date("2026-10-14T09:00:00+09:00")), false);
});
