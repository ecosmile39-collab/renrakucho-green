// LP（WordPress）の訪問者数を Google アナリティクス 4 の Data API から読む
const LP_ANALYTICS_PROPERTY_ID = "561014308";
// 計測を始めた日（Site Kit でアナリティクスを設定した日）。全期間の合計はこの日から数える
const LP_ANALYTICS_START_DATE = "2026-10-27";

const SUMMARY_RANGES = [
    { name: "today", startDate: "today", endDate: "today" },
    { name: "yesterday", startDate: "yesterday", endDate: "yesterday" },
    { name: "last7Days", startDate: "6daysAgo", endDate: "today" },
    { name: "last28Days", startDate: "27daysAgo", endDate: "today" }
];
// Data API は1つのレポートで期間を4つまでしか指定できないため、全期間の合計は別のレポートにする
const ALL_TIME_RANGE = { name: "allTime", startDate: LP_ANALYTICS_START_DATE, endDate: "today" };
const SUMMARY_METRICS = [{ name: "activeUsers" }, { name: "screenPageViews" }, { name: "sessions" }];

function buildLpAnalyticsRequest() {
    return {
        requests: [
            {
                dateRanges: SUMMARY_RANGES,
                metrics: SUMMARY_METRICS
            },
            {
                dateRanges: [{ startDate: "13daysAgo", endDate: "today" }],
                dimensions: [{ name: "date" }],
                metrics: [{ name: "activeUsers" }],
                orderBys: [{ dimension: { dimensionName: "date" } }]
            },
            {
                dateRanges: [{ startDate: "27daysAgo", endDate: "today" }],
                dimensions: [{ name: "sessionDefaultChannelGroup" }],
                metrics: [{ name: "activeUsers" }],
                orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
                limit: 6
            },
            {
                dateRanges: [ALL_TIME_RANGE],
                metrics: SUMMARY_METRICS
            }
        ]
    };
}

const toNumber = value => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
};

const CHANNEL_LABELS = {
    "Organic Search": "検索（Google・Yahoo など）",
    Direct: "直接（URL入力・ブックマークなど）",
    Referral: "ほかのサイトのリンク",
    "Organic Social": "SNS",
    "Paid Search": "検索広告",
    "Paid Social": "SNS広告",
    Email: "メール",
    Display: "ディスプレイ広告",
    "Organic Video": "動画サイト",
    Unassigned: "不明"
};

function parseLpAnalyticsResponse(response) {
    const reports = Array.isArray(response?.reports) ? response.reports : [];
    const [summaryReport, dailyReport, channelReport, allTimeReport] = reports;
    const metricsOf = row => {
        const [visitors, pageViews, sessions] = (row?.metricValues || []).map(metric => toNumber(metric.value));
        return { visitors: visitors || 0, pageViews: pageViews || 0, sessions: sessions || 0 };
    };
    const summary = Object.fromEntries([...SUMMARY_RANGES, ALL_TIME_RANGE].map(range => [range.name, { visitors: 0, pageViews: 0, sessions: 0 }]));
    if (allTimeReport?.rows?.[0]) summary.allTime = metricsOf(allTimeReport.rows[0]);
    for (const row of summaryReport?.rows || []) {
        // 期間が複数あると、各行に dateRange の列が付く（名前を付けた期間はその名前、なければ date_range_0 など）
        const rangeValue = row.dimensionValues?.[0]?.value || "";
        const rangeIndex = /^date_range_\d+$/.test(rangeValue) ? Number(rangeValue.replace("date_range_", "")) : -1;
        const range = SUMMARY_RANGES.find(item => item.name === rangeValue) || SUMMARY_RANGES[rangeIndex];
        if (!range) continue;
        summary[range.name] = metricsOf(row);
    }
    const daily = (dailyReport?.rows || []).map(row => {
        const raw = row.dimensionValues?.[0]?.value || "";
        const date = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
        return { date, visitors: toNumber(row.metricValues?.[0]?.value) };
    }).sort((first, second) => first.date.localeCompare(second.date));
    const channels = (channelReport?.rows || []).map(row => {
        const name = row.dimensionValues?.[0]?.value || "Unassigned";
        return { name: CHANNEL_LABELS[name] || name, visitors: toNumber(row.metricValues?.[0]?.value) };
    });
    return { summary, daily, channels };
}

module.exports = {
    LP_ANALYTICS_PROPERTY_ID,
    LP_ANALYTICS_START_DATE,
    buildLpAnalyticsRequest,
    parseLpAnalyticsResponse
};
