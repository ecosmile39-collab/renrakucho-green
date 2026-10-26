const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getTrialAccessEndsAt, isTrialAccessOpen, getPaymentGraceFields } = require("./trial-access");

const trialEnd = "2026-10-28T12:00:00.000Z";
const now = Date.parse("2026-10-30T00:00:00.000Z");

test("without an application the trial end decides access", () => {
    assert.equal(isTrialAccessOpen({ trialEndsAt: trialEnd }, now), false);
    assert.equal(isTrialAccessOpen({ trialEndsAt: trialEnd }, Date.parse("2026-10-27T00:00:00Z")), true);
});

test("an applied facility stays usable until the end of its payment due date in Japan", () => {
    const facility = { trialEndsAt: trialEnd, paymentGraceUntil: "2026-11-05T14:59:59.999Z" };
    assert.equal(isTrialAccessOpen(facility, now), true);
    assert.equal(isTrialAccessOpen(facility, Date.parse("2026-11-05T14:59:59.000Z")), true);
    assert.equal(isTrialAccessOpen(facility, Date.parse("2026-11-05T15:00:00.000Z")), false);
    assert.equal(getTrialAccessEndsAt({ trialEndsAt: "2026-12-01T00:00:00Z", paymentGraceUntil: "2026-11-05T14:59:59.999Z" }),
        Date.parse("2026-12-01T00:00:00Z"));
});

test("sending the initial invoice sets the grace date and lifts only a trial-expiry lock", () => {
    assert.deepEqual(getPaymentGraceFields({ subscriptionStatus: "trial", trialEndsAt: trialEnd }, "2026-11-05", now),
        { paymentGraceUntil: "2026-11-05T14:59:59.999Z" });
    assert.deepEqual(getPaymentGraceFields({ subscriptionStatus: "trial", status: "locked", trialExpiredAt: "x" }, "2026-11-05", now),
        { paymentGraceUntil: "2026-11-05T14:59:59.999Z", status: "active" });
    assert.deepEqual(getPaymentGraceFields({ subscriptionStatus: "trial", status: "locked" }, "2026-11-05", now),
        { paymentGraceUntil: "2026-11-05T14:59:59.999Z" }, "an administrator lock is kept");
    assert.deepEqual(getPaymentGraceFields({ subscriptionStatus: "trial", status: "locked", trialExpiredAt: "x", lockReason: "payment_overdue" }, "2026-11-05", now),
        { paymentGraceUntil: "2026-11-05T14:59:59.999Z" }, "an overdue lock is kept");
    assert.deepEqual(getPaymentGraceFields({ subscriptionStatus: "trial", status: "locked", trialExpiredAt: "x" }, "2026-10-20", now),
        { paymentGraceUntil: "2026-10-20T14:59:59.999Z" }, "a past due date does not unlock");
    assert.deepEqual(getPaymentGraceFields({ subscriptionStatus: "active" }, "2026-11-05", now), {});
    assert.deepEqual(getPaymentGraceFields({ subscriptionStatus: "trial" }, "bad", now), {});
});
