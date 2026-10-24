const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getFacilityRetentionDeadline, isFacilityRetentionExpired } = require("./facility-retention");

for (const [start, expected] of [
    ["2026-10-24T13:54:21.961+09:00", "2026-12-24T13:54:21.961+09:00"],
    ["2026-12-31T00:01:00+09:00", "2027-02-28T00:01:00+09:00"],
    ["2027-12-31T23:59:59+09:00", "2028-02-29T23:59:59+09:00"],
    ["2026-07-31T01:00:00+09:00", "2026-09-30T01:00:00+09:00"]
]) {
    test(`two calendar months in Tokyo: ${start}`, () => {
        for (const facility of [
            { subscriptionStatus: "trial", trialEndsAt: start },
            { usagePaused: true, usagePausedAt: start, subscriptionStatus: "active" }
        ]) {
            const deadline = getFacilityRetentionDeadline(facility);
            assert.equal(deadline.getTime(), new Date(expected).getTime());
            assert.equal(isFacilityRetentionExpired(facility, new Date(deadline.getTime() - 1)), false);
            assert.equal(isFacilityRetentionExpired(facility, deadline), false);
            assert.equal(isFacilityRetentionExpired(facility, new Date(deadline.getTime() + 1)), true);
        }
    });
}

test("active facilities have no deadline; pause takes precedence over trial expiry", () => {
    assert.equal(getFacilityRetentionDeadline({ subscriptionStatus: "active", trialEndsAt: "2020-01-01" }), null);
    assert.equal(getFacilityRetentionDeadline({ subscriptionStatus: "trial", trialEndsAt: "2020-01-01",
        usagePaused: true, usagePausedAt: "2026-10-24T00:00:00+09:00" }).toISOString(),
    new Date("2026-12-24T00:00:00+09:00").toISOString());
});

test("missing or invalid dates fail explicitly rather than deleting or extending retention", () => {
    for (const value of [undefined, null, "", "invalid", true, 1, "1", "2026-02-31",
        "2026-10-24T12:00:00", "2026-02-31T12:00:00+09:00"]) {
        assert.throws(() => getFacilityRetentionDeadline({ usagePaused: true, usagePausedAt: value }));
        assert.throws(() => getFacilityRetentionDeadline({ subscriptionStatus: "trial", trialEndsAt: value }));
    }
});

test("Firestore timestamp and Date values use the same deadline as ISO strings", () => {
    const date = new Date("2026-10-24T00:00:00+09:00");
    for (const source of [date, { toDate: () => date }]) {
        assert.equal(getFacilityRetentionDeadline({ usagePaused: true, usagePausedAt: source }).toISOString(),
            "2026-12-23T15:00:00.000Z");
    }
});
