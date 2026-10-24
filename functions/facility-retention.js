const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;

function getFacilityRetentionDeadline(facility) {
    if (facility.usagePaused !== true && facility.subscriptionStatus !== "trial") return null;
    const source = facility.usagePaused === true ? facility.usagePausedAt
        : facility.trialEndsAt;
    let date;
    if (source && typeof source.toDate === "function") {
        date = source.toDate();
    } else if (source instanceof Date) {
        date = source;
    } else if (typeof source === "string" &&
        /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(source)) {
        const [year, month, day] = source.slice(0, 10).split("-").map(Number);
        if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
            throw new Error("Facility retention start date is missing or invalid.");
        }
        date = new Date(source);
    } else {
        throw new Error("Facility retention start date is missing or invalid.");
    }
    const timestamp = date.getTime();
    if (!Number.isFinite(timestamp)) throw new Error("Facility retention start date is missing or invalid.");
    const local = new Date(timestamp + TOKYO_OFFSET_MS);
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth() + 2;
    const day = Math.min(local.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
    return new Date(Date.UTC(year, month, day, local.getUTCHours(), local.getUTCMinutes(),
        local.getUTCSeconds(), local.getUTCMilliseconds()) - TOKYO_OFFSET_MS);
}

function isFacilityRetentionExpired(facility, now = new Date()) {
    const deadline = getFacilityRetentionDeadline(facility);
    return deadline !== null && now.getTime() > deadline.getTime();
}

module.exports = { getFacilityRetentionDeadline, isFacilityRetentionExpired };
