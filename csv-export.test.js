import { test } from "node:test";
import assert from "node:assert/strict";
import Papa from "papaparse";
import { createCsv, rosterTable, selectUsers, selectRecords, recordsTable } from "./csv-export.js";

const facility = { id: "facility-a", name: "テスト施設" };

test("CSV round-trips Japanese, commas, quotes, line breaks, blanks and zero with BOM", () => {
    const csv = createCsv([["氏名", "連絡事項", "数値"], ["架空 太郎", '食事,完食\n本人は"元気"', 0], ["空欄", null, false]]);
    assert.equal(csv.charCodeAt(0), 0xFEFF);
    const parsed = Papa.parse(csv).data;
    assert.deepEqual(parsed[1], ["架空 太郎", '食事,完食\n本人は"元気"', "0"]);
    assert.deepEqual(parsed[2], ["空欄", "", "いいえ"]);
});

test("CSV disables spreadsheet formulas including leading whitespace", () => {
    const values = ["=1+1", "+SUM(A1)", "-1+1", "@SUM(A1)", "  =1+1", "\tcmd", "普通の文章"];
    assert.deepEqual(Papa.parse(createCsv([values])).data[0], values.map(value => /^[\s]*[=+\-@\t\r]/.test(value) ? "'" + value : value));
});

test("roster includes inactive users and services but never exports LINE identifiers", () => {
    const csv = createCsv(rosterTable([{ name: "架空 花子", birthday: "1950-01-01", services: ["生活介護", "ショートステイ"], active: false,
        lineUserIds: ["private-line-id"] }], facility));
    const row = Papa.parse(csv).data[1];
    assert.equal(row[4], "生活介護、ショートステイ");
    assert.equal(row[5], "いいえ");
    assert.equal(row[8], "1");
    assert.equal(csv.includes("private-line-id"), false);
});

test("inclusive date filters isolate facility, user and service, including legacy service defaults", () => {
    const records = [
        { facilityId: facility.id, userName: "架空 太郎", date: "2026-10-07", serviceType: "生活介護" },
        { facilityId: facility.id, userName: "架空 太郎", date: "2026-10-01" },
        { facilityId: "other", userName: "架空 太郎", date: "2026-10-02" },
        { facilityId: facility.id, userName: "架空 花子", date: "2026-10-03" },
        { facilityId: facility.id, userName: "架空 太郎", date: "2026-09-30" }
    ];
    const filters = { facilityId: facility.id, startDate: "2026-10-01", endDate: "2026-10-07", userName: "架空 太郎", serviceType: "デイサービス" };
    assert.deepEqual(selectRecords(records, filters), [records[1]]);
    assert.deepEqual(selectRecords(records, { ...filters, serviceType: "生活介護" }), [records[0]]);
    assert.throws(() => selectRecords(records, { ...filters, serviceType: "" }), /サービス/);
    assert.throws(() => selectRecords(records, { ...filters, startDate: "2026-10-08" }));
    assert.throws(() => selectRecords(records, { ...filters, startDate: "2026-02-30" }));
});

test("record columns retain all five service types, timestamps and additional fields", () => {
    const records = [
        { serviceType: "デイサービス", temp1: "36.5", message: "本日の様子" },
        { serviceType: "ショートステイ", stMealLunch: "全量", num_in_1: "2" },
        { serviceType: "放課後等デイサービス", afterSchoolEpisode: "活動に参加" },
        { serviceType: "児童発達支援", afterSchoolTemperature: "36.6" },
        { serviceType: "生活介護", lifeCareActivityTags: ["創作", "運動"], customField: "残す", familyPublishedAt: { toDate: () => new Date("2026-10-07T06:00:00Z") } }
    ];
    const parsed = Papa.parse(createCsv(recordsTable(records, facility))).data;
    for (const record of records) assert.equal(parsed.some(row => row[4] === record.serviceType), true);
    assert.equal(parsed[0].includes("持参品1・入所時"), true);
    assert.equal(parsed[5].includes("創作、運動"), true);
    assert.equal(parsed[5].includes("残す"), true);
    assert.equal(parsed[5].includes("2026-10-07T06:00:00.000Z"), true);
    assert.deepEqual(recordsTable([], facility)[0], ["施設ID", "施設名", "日付", "氏名", "利用サービス"]);
});

test("each of five services exports only its own records for the same user and day", () => {
    const services = ["デイサービス", "ショートステイ", "放課後等デイサービス", "児童発達支援", "生活介護"];
    const records = services.map(serviceType => ({ facilityId: facility.id, userName: "架空 太郎", date: "2026-10-07", serviceType }));
    for (const serviceType of services) {
        const selected = selectRecords(records, { facilityId: facility.id, startDate: "2026-10-07", endDate: "2026-10-07", serviceType });
        const parsed = Papa.parse(createCsv(recordsTable(selected, facility))).data;
        assert.equal(parsed.length, 2);
        assert.equal(parsed[1][4], serviceType);
    }
});

test("service-specific roster filters members, preserves inactive users and labels only the selected service", () => {
    const users = [
        { name: "架空 太郎", services: ["デイサービス", "生活介護"], active: false },
        { name: "架空 花子", serviceType: "生活介護" },
        { name: "旧名簿" }
    ];
    const selected = selectUsers(users, { serviceType: "デイサービス" });
    assert.deepEqual(selected, [users[0], users[2]]);
    assert.deepEqual(selectUsers(users, { serviceType: "生活介護", userName: "架空 花子" }), [users[1]]);
    const parsed = Papa.parse(createCsv(rosterTable(selected, facility, "デイサービス"))).data;
    assert.equal(parsed.slice(1).every(row => row[4] === "デイサービス"), true);
    assert.throws(() => selectUsers(users, { serviceType: "" }), /サービス/);
});