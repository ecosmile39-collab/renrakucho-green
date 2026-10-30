import assert from "node:assert/strict";
import { test } from "node:test";
import {
    DAY_CARE_REHAB_ROWS,
    dayCareRehabStaffText,
    fillDayCareRehabFields,
    formatDayCareRehabItems,
    hasDayCareRehab,
    normalizeDayCareRehabRows,
    readDayCareRehabFields
} from "./day-care.js";
import { ALL_SERVICE_TYPE_VALUES, isShortStayService, normalizeBillingServiceTypes } from "./service-types.js";

function fakeDocument(values = {}) {
    const fields = {};
    const ids = ["rhStaffRole", "rhStaffName", "rhGoal", "rhChange"];
    for (let i = 1; i <= DAY_CARE_REHAB_ROWS; i++) ids.push(`rhItemName${i}`, `rhItemAmount${i}`);
    ids.forEach(id => { fields[id] = { value: values[id] ?? "" }; });
    return { fields, getElementById: id => fields[id] || null };
}

test("day care is a selectable service that uses the day form, not the short-stay form", () => {
    assert.ok(ALL_SERVICE_TYPE_VALUES.includes("デイケア"));
    assert.equal(ALL_SERVICE_TYPE_VALUES.indexOf("デイケア"), ALL_SERVICE_TYPE_VALUES.indexOf("デイサービス") + 1);
    assert.equal(isShortStayService("デイケア"), false);
    assert.deepEqual(normalizeBillingServiceTypes(undefined), ["デイサービス"]);
});

test("rehab rows become one readable line and skip empty rows", () => {
    const rows = [{ name: "歩行訓練", amount: "10m×3回" }, { name: "", amount: "" }, { name: "立ち上がり", amount: "" }, { name: " ", amount: "15分" }];
    assert.equal(formatDayCareRehabItems(rows), "歩行訓練 10m×3回、立ち上がり、15分");
    assert.deepEqual(normalizeDayCareRehabRows(rows), [
        { name: "歩行訓練", amount: "10m×3回" }, { name: "立ち上がり", amount: "" }, { name: "", amount: "15分" }
    ]);
    assert.equal(formatDayCareRehabItems(null), "");
});

test("reading the form keeps both the rows and the summary text", () => {
    const doc = fakeDocument({
        rhStaffRole: "理学療法士（PT）", rhStaffName: " 山田 ",
        rhItemName1: "歩行訓練", rhItemAmount1: "10m×3回",
        rhItemName3: "バランス訓練", rhItemAmount3: "5分",
        rhGoal: "杖で自宅のトイレまで歩ける", rhChange: "手すりなしで5回立ち上がれた"
    });
    const data = readDayCareRehabFields(doc);
    assert.equal(data.rhStaffName, "山田");
    assert.equal(data.rhItems, "歩行訓練 10m×3回、バランス訓練 5分");
    assert.equal(data.rhItemRows.length, 2);
    assert.equal(dayCareRehabStaffText(data), "理学療法士（PT） 山田");
    assert.equal(hasDayCareRehab(data), true);
    assert.equal(hasDayCareRehab({}), false);
});

test("filling the form restores saved rows and clears old values", () => {
    const doc = fakeDocument({ rhItemName4: "前の値", rhGoal: "前の目標" });
    fillDayCareRehabFields(doc, { rhStaffRole: "作業療法士（OT）", rhItemRows: [{ name: "更衣動作訓練", amount: "2回" }] });
    assert.equal(doc.fields.rhStaffRole.value, "作業療法士（OT）");
    assert.equal(doc.fields.rhItemName1.value, "更衣動作訓練");
    assert.equal(doc.fields.rhItemAmount1.value, "2回");
    assert.equal(doc.fields.rhItemName4.value, "");
    assert.equal(doc.fields.rhGoal.value, "");
});
