"use strict";

const TOKYO_DAY_MS = 24 * 60 * 60 * 1000;

function toDate(value) {
    if (value && typeof value.toDate === "function") return value.toDate();
    return new Date(value);
}

function getTokyoDayNumber(date) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(date).map(part => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / TOKYO_DAY_MS;
}

function daysUntilTrialEnds(trialEndsAt, now) {
    const trialEndDate = toDate(trialEndsAt);
    const currentDate = toDate(now);
    if (!Number.isFinite(trialEndDate.getTime()) || !Number.isFinite(currentDate.getTime())) return null;
    return getTokyoDayNumber(trialEndDate) - getTokyoDayNumber(currentDate);
}

function isTrialReminderDue(trialEndsAt, now) {
    const daysRemaining = daysUntilTrialEnds(trialEndsAt, now);
    return daysRemaining !== null && daysRemaining >= 1 && daysRemaining <= 3;
}

module.exports = { daysUntilTrialEnds, isTrialReminderDue };
