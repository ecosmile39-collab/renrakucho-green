const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { LP_ANALYTICS_PROPERTY_ID, buildLpAnalyticsRequest, parseLpAnalyticsResponse } = require("./lp-analytics");

test("the request asks for today, yesterday, 7 and 28 days, a 14-day trend and traffic sources", () => {
    const { requests } = buildLpAnalyticsRequest();
    assert.equal(LP_ANALYTICS_PROPERTY_ID, "561014308");
    assert.deepEqual(requests[0].dateRanges.map(range => range.name), ["today", "yesterday", "last7Days", "last28Days"]);
    // Data API は1レポート4期間まで
    for (const request of requests) assert.ok(request.dateRanges.length <= 4);
    assert.deepEqual(requests[0].metrics.map(metric => metric.name), ["activeUsers", "screenPageViews", "sessions"]);
    assert.equal(requests[3].dateRanges[0].startDate, "2026-10-27");
    assert.equal(requests.length <= 5, true);
    assert.equal(requests[1].dimensions[0].name, "date");
    assert.equal(requests[1].dateRanges[0].startDate, "13daysAgo");
    assert.equal(requests[2].dimensions[0].name, "sessionDefaultChannelGroup");
});

test("the response is turned into visitor counts, a daily trend and Japanese source names", () => {
    const parsed = parseLpAnalyticsResponse({ reports: [
        { rows: [
            { dimensionValues: [{ value: "today" }], metricValues: [{ value: "3" }, { value: "5" }, { value: "4" }] },
            { dimensionValues: [{ value: "date_range_3" }], metricValues: [{ value: "40" }, { value: "90" }, { value: "55" }] }
        ] },
        { rows: [
            { dimensionValues: [{ value: "20261027" }], metricValues: [{ value: "3" }] },
            { dimensionValues: [{ value: "20261026" }], metricValues: [{ value: "7" }] }
        ] },
        { rows: [
            { dimensionValues: [{ value: "Organic Search" }], metricValues: [{ value: "20" }] },
            { dimensionValues: [{ value: "Something New" }], metricValues: [{ value: "1" }] }
        ] },
        { rows: [{ metricValues: [{ value: "120" }, { value: "300" }, { value: "150" }] }] }
    ] });
    assert.deepEqual(parsed.summary.today, { visitors: 3, pageViews: 5, sessions: 4 });
    assert.deepEqual(parsed.summary.last28Days, { visitors: 40, pageViews: 90, sessions: 55 });
    assert.deepEqual(parsed.summary.allTime, { visitors: 120, pageViews: 300, sessions: 150 });
    assert.deepEqual(parsed.summary.yesterday, { visitors: 0, pageViews: 0, sessions: 0 });
    assert.deepEqual(parsed.daily, [{ date: "2026-10-26", visitors: 7 }, { date: "2026-10-27", visitors: 3 }]);
    assert.deepEqual(parsed.channels, [
        { name: "検索（Google・Yahoo など）", visitors: 20 },
        { name: "Something New", visitors: 1 }
    ]);
});

test("an empty response (no visitors yet) shows zeros instead of failing", () => {
    const parsed = parseLpAnalyticsResponse({ reports: [{}, {}, {}, {}] });
    assert.equal(parsed.summary.allTime.visitors, 0);
    assert.equal(parsed.summary.last7Days.visitors, 0);
    assert.deepEqual(parsed.daily, []);
    assert.deepEqual(parsed.channels, []);
});

test("only MFA-verified administrators can read the LP visitor numbers", () => {
    const source = readFileSync(path.join(__dirname, "index.js"), "utf8");
    const start = source.indexOf("exports.getLpAnalyticsSummary = onCall(");
    const body = source.slice(start, source.indexOf("\nexports.", start + 1));
    assert.match(body, /request\.auth\?\.token\.role !== "admin" \|\| request\.auth\.token\.mfaVerified !== true/);
    assert.match(body, /analytics\.readonly/);
});
