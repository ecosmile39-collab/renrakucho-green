import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { GROUP_HOME_FIELDS, readGroupHomeFields, restoreGroupHomeFields } from "./group-home.js";
import {
    RESIDENTIAL_FIELDS, RESIDENTIAL_RECORD_LAYOUT, isLongTermResidentialService, isResidentialLayoutRecord,
    readResidentialFields, renderResidentialRecord, restoreResidentialFields
} from "./residential-care.js";
import { isShortStayService } from "./service-types.js";
import { removeUndefinedFields } from "./firestore-data.js";
import { FORM_CUSTOMIZATION_SECTIONS } from "./facility-form-customization.js";

const source = readFileSync(new URL("./index.html", import.meta.url), "utf8");

function extract(start, end) {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex);
    assert.ok(startIndex >= 0 && endIndex > startIndex, `missing source boundary: ${start}`);
    return source.slice(startIndex, endIndex);
}

function createContext(serviceType) {
    const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    const allIds = [...ids, ...GROUP_HOME_FIELDS.map(field => field.id), ...RESIDENTIAL_FIELDS.map(field => field.id)];
    const elements = new Map(allIds.map(id => [id, {
        value: "", checked: false, style: {}, textContent: "", innerHTML: "",
        reportValidity: () => true, focus() {}
    }]));
    const checkboxes = new Map();
    const checkbox = (name, value) => {
        const key = `${name}:${value}`;
        if (!checkboxes.has(key)) checkboxes.set(key, { name, value, checked: false });
        return checkboxes.get(key);
    };
    const storage = new Map([["currentFacilityId", "test-facility"]]);
    const sandbox = {
        document: {
            getElementById: id => elements.get(id),
            getElementsByName: () => [],
            querySelectorAll: selector => {
                const match = selector.match(/name="([^"]+)"\](:checked)?/);
                if (!match) return [];
                return [...checkboxes.values()].filter(item => item.name === match[1] && (!match[2] || item.checked));
            }
        },
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: key => storage.delete(key)
        },
        window: { currentImageCount: 0, currentVideoCount: 0, checkTemp() {} },
        accumulatedFiles: [], familyLinePublicationEnabled: true,
        facilityFormCustomization: { customFields: [], hiddenSections: [] },
        getCustomProfileFieldValues: () => ({}),
        syncTextSuggestionSelects() {},
        readGroupHomeFields, restoreGroupHomeFields, isShortStayService, removeUndefinedFields,
        readResidentialFields, restoreResidentialFields, isLongTermResidentialService, RESIDENTIAL_RECORD_LAYOUT,
        serverDataLoadSequence: 0, db: {},
        doc: (...parts) => parts.slice(1).join("/"),
        getDoc: async () => ({ exists: () => true, data: () => sandbox.serverRecord }),
        console
    };
    vm.createContext(sandbox);
    vm.runInContext([
        extract("        function getFormData()", "        window.saveToBatch"),
        extract("        function resetFormInputs()", "        window.checkTemp ="),
        extract("        function applyDraftOrEmpty(", "        async function fetchServerData("),
        extract("        async function fetchServerData(", "        window.showUserFace =")
    ].join("\n"), sandbox);
    elements.get("serviceType").value = serviceType;
    elements.get("userName").value = "Test User";
    elements.get("date").value = "2026-10-24";
    return { sandbox, elements, checkbox, storage };
}

const residentialSample = Object.fromEntries(RESIDENTIAL_FIELDS.map(field => [field.id,
    field.type === "number" ? "0" : field.type === "date" ? "2026-10-24" :
    field.type === "time" ? "08:30" : field.type === "select" ? field.options[0] : `${field.id}\n記録`
]));

for (const serviceType of ["入所", "ユニット入所"]) {
    test(`${serviceType} saves the long-term residential fields instead of short-stay check-in/out fields`, () => {
        const { sandbox, elements } = createContext(serviceType);
        restoreResidentialFields(sandbox.document, residentialSample);
        elements.get("stTempIn").value = "99";
        elements.get("careJournal").value = "Journal";
        const data = sandbox.getFormData();
        for (const field of RESIDENTIAL_FIELDS) assert.equal(data[field.id], residentialSample[field.id], field.id);
        assert.equal(data.recordLayout, "residential");
        assert.equal(data.careJournal, "Journal");
        assert.equal(data.stTempIn, undefined);
        assert.equal(data.stBelongingMemo, undefined);
        assert.equal(data.ghMorningTemp, undefined);
        assert.equal(isResidentialLayoutRecord(data), true);
    });
}

test("short stay keeps its check-in/out record and is not treated as the residential layout", () => {
    const { sandbox, elements } = createContext("ショートステイ");
    restoreResidentialFields(sandbox.document, residentialSample);
    elements.get("stTempIn").value = "36.5";
    const data = sandbox.getFormData();
    assert.equal(data.stTempIn, "36.5");
    assert.equal(data.recordLayout, undefined);
    assert.equal(data.rsMorningTemp, undefined);
    assert.equal(isResidentialLayoutRecord({ ...data, serviceType: "ショートステイ", recordLayout: "residential" }), false);
});

test("older 入所 records saved with short-stay fields keep the legacy display", () => {
    assert.equal(isResidentialLayoutRecord({ serviceType: "入所", stTempIn: "36.5" }), false);
    assert.equal(isResidentialLayoutRecord({ serviceType: "ユニット入所", recordLayout: "residential" }), true);
});

test("residential draft and server record restore every field, and reset clears them", async () => {
    const { sandbox, storage } = createContext("入所");
    storage.set("draft_test-facility_2026-10-24_入所_Test User", JSON.stringify(residentialSample));
    sandbox.applyDraftOrEmpty("Test User", "2026-10-24");
    assert.deepEqual(readResidentialFields(sandbox.document), residentialSample);
    sandbox.applyDraftOrEmpty("Other User", "2026-10-24");
    assert.ok(Object.values(readResidentialFields(sandbox.document)).every(value => value === ""));
    storage.clear();
    storage.set("currentFacilityId", "test-facility");
    sandbox.serverRecord = { ...residentialSample, serviceType: "入所", recordLayout: "residential" };
    assert.equal(await sandbox.fetchServerData("Test User", "2026-10-24"), true);
    assert.deepEqual(readResidentialFields(sandbox.document), residentialSample);
});

test("residential print/history shows every field, escapes HTML and respects hidden sections", () => {
    const html = renderResidentialRecord({ ...residentialSample, rsVisit: "<b>面会</b>", careStaff: "Staff", careJournal: "Journal" });
    for (const field of RESIDENTIAL_FIELDS) assert.ok(html.includes(field.label), field.id);
    assert.ok(html.includes("&lt;b&gt;面会&lt;/b&gt;"));
    assert.equal(html.includes("持ち物"), false);
    assert.equal(html.includes("退所時"), false);
    assert.equal(renderResidentialRecord({ ...residentialSample, hiddenFormSections: ["residentialSection", "careJournalArea"] }), "");
    assert.ok(FORM_CUSTOMIZATION_SECTIONS.some(section => section.id === "residentialSection"));
});

test("day service saves attendance and transport; child services do not", () => {
    const values = { dsAttendance: "利用", dsPickupTime: "08:45", dsDropoffTime: "16:30",
        dsPickupType: "施設送迎", dsDropoffType: "家族お迎え", dsTransportNote: "長女様宅へ" };
    const day = createContext("デイサービス");
    for (const [id, value] of Object.entries(values)) day.elements.get(id).value = value;
    const dayData = day.sandbox.getFormData();
    for (const [id, value] of Object.entries(values)) assert.equal(dayData[id], value, id);
    const child = createContext("放課後等デイサービス");
    for (const [id, value] of Object.entries(values)) child.elements.get(id).value = value;
    const childData = child.sandbox.getFormData();
    for (const id of Object.keys(values)) assert.equal(childData[id], undefined, id);
});

test("child development saves lunch and the five support domains; after-school care has no lunch", () => {
    const early = createContext("児童発達支援");
    early.elements.get("afterSchoolLunch").value = "給食";
    early.elements.get("afterSchoolLunchIntake").value = "完食";
    early.checkbox("afterSchoolDomainTag", "健康・生活").checked = true;
    early.checkbox("afterSchoolDomainTag", "言語・コミュニケーション").checked = true;
    const earlyData = early.sandbox.getFormData();
    assert.equal(earlyData.afterSchoolLunch, "給食");
    assert.equal(earlyData.afterSchoolLunchIntake, "完食");
    assert.deepEqual([...earlyData.afterSchoolDomainTags], ["健康・生活", "言語・コミュニケーション"]);
    const afterSchool = createContext("放課後等デイサービス");
    afterSchool.elements.get("afterSchoolLunch").value = "給食";
    assert.equal(afterSchool.sandbox.getFormData().afterSchoolLunch, "");
});

test("child activity choices match each service and toileting includes diaper and toilet training", () => {
    const section = source.slice(source.indexOf('id="afterSchoolSection"'), source.indexOf('id="lifeCareSection"'));
    assert.match(section, /data-child-service="放課後等デイサービス"><input type="checkbox" name="afterSchoolActivityTag" value="学習支援（宿題）"/);
    assert.match(section, /data-child-service="児童発達支援"><input type="checkbox" name="afterSchoolActivityTag" value="遊び・感覚あそび"/);
    assert.match(section, /data-child-service="児童発達支援"><input type="checkbox" name="afterSchoolActivityTag" value="生活の練習（着替え・手洗い・食事）"/);
    for (const domain of ["健康・生活", "運動・感覚", "認知・行動", "言語・コミュニケーション", "人間関係・社会性"]) {
        assert.ok(section.includes(`name="afterSchoolDomainTag" value="${domain}"`), domain);
    }
    assert.ok(section.includes('<option value="おむつ交換">'));
    assert.ok(section.includes('<option value="トイレトレーニング（トイレで成功）">'));
    assert.ok(section.includes('id="afterSchoolLunchRow"'));
});
