import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import {
    GROUP_HOME_FIELDS, readGroupHomeFields, restoreGroupHomeFields,
    renderGroupHomeRecord, validateGroupHomeFields
} from "./group-home.js";
import { isShortStayService } from "./service-types.js";
import { removeUndefinedFields } from "./firestore-data.js";

const source = readFileSync(new URL("./index.html", import.meta.url), "utf8");

function extract(start, end) {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex);
    assert.ok(startIndex >= 0 && endIndex > startIndex, `missing source boundary: ${start}`);
    return source.slice(startIndex, endIndex);
}

function createContext() {
    const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    const elements = new Map([...ids, ...GROUP_HOME_FIELDS.map(field => field.id)].map(id => [id, {
        value: "", checked: false, style: {}, textContent: "", innerHTML: "",
        reportValidity: () => true, focus() {}
    }]));
    const storage = new Map([["currentFacilityId", "test-facility"]]);
    const sandbox = {
        document: {
            getElementById: id => elements.get(id),
            getElementsByName: () => [],
            querySelectorAll: () => []
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
    elements.get("serviceType").value = "グループホーム";
    elements.get("userName").value = "Test User";
    elements.get("date").value = "2026-10-24";
    return { sandbox, elements, storage };
}

const sample = Object.fromEntries(GROUP_HOME_FIELDS.map(field => [field.id,
    field.type === "number" ? "0" : field.type === "date" ? "2026-10-24" :
    field.type === "time" ? "08:30" : field.type === "select" ? field.options[0] : `${field.id}\n記録`
]));

test("group home records serialize every field without hidden day/short-stay values", () => {
    const { sandbox, elements } = createContext();
    restoreGroupHomeFields(sandbox.document, sample);
    elements.get("careStaff").value = "Staff";
    elements.get("careJournal").value = "Journal";
    elements.get("handoverRequired").checked = true;
    elements.get("temp1").value = "99";
    elements.get("stTempIn").value = "99";
    const data = sandbox.getFormData();
    for (const field of GROUP_HOME_FIELDS) assert.equal(data[field.id], sample[field.id]);
    assert.equal(data.careStaff, "Staff");
    assert.equal(data.careJournal, "Journal");
    assert.equal(data.handoverRequired, true);
    assert.equal(data.serviceType, "グループホーム");
    assert.equal(data.temp1, undefined);
    assert.equal(data.stTempIn, undefined);
    elements.get("serviceType").value = "デイサービス";
    const dayData = sandbox.getFormData();
    assert.equal(dayData.temp1, "99");
    assert.equal(dayData.ghMorningTemp, undefined);
    elements.get("serviceType").value = "ショートステイ";
    const shortData = sandbox.getFormData();
    assert.equal(shortData.stTempIn, "99");
    assert.equal(shortData.ghMorningTemp, undefined);
});

test("group home draft restores all fields and reset prevents leaking between users", () => {
    const { sandbox, elements, storage } = createContext();
    storage.set("draft_test-facility_2026-10-24_グループホーム_Test User",
        JSON.stringify({ ...sample, careStaff: "Staff" }));
    sandbox.applyDraftOrEmpty("Test User", "2026-10-24");
    assert.deepEqual(readGroupHomeFields(sandbox.document), sample);
    assert.equal(elements.get("careStaff").value, "Staff");
    sandbox.applyDraftOrEmpty("Other User", "2026-10-24");
    assert.ok(Object.values(readGroupHomeFields(sandbox.document)).every(value => value === ""));
});

test("group home server record restores all fields but does not overwrite a local draft", async () => {
    const { sandbox, storage } = createContext();
    sandbox.serverRecord = { ...sample, serviceType: "グループホーム" };
    assert.equal(await sandbox.fetchServerData("Test User", "2026-10-24"), true);
    assert.deepEqual(readGroupHomeFields(sandbox.document), sample);
    storage.set("draft_test-facility_2026-10-24_グループホーム_Test User", "{}");
    sandbox.document.getElementById("ghRoles").value = "Unsaved draft";
    await sandbox.fetchServerData("Test User", "2026-10-24");
    assert.equal(sandbox.document.getElementById("ghRoles").value, "Unsaved draft");
});

test("group home printing/history retains every field, zero, line breaks and escapes HTML", () => {
    const html = renderGroupHomeRecord({ ...sample, ghRoles: "<script>alert(1)</script>",
        careStaff: "Staff", careJournal: "Journal", handoverNote: "private-staff-note" });
    for (const field of GROUP_HOME_FIELDS) assert.ok(html.includes(field.label));
    assert.ok(html.includes(">0</td>"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.equal(html.includes("<script>"), false);
    assert.equal(html.includes("private-staff-note"), false);
    const hidden = renderGroupHomeRecord({ ...sample, hiddenFormSections: ["groupHomeSection", "careJournalArea"] });
    assert.equal(hidden, "");
});

test("compact print groups fields in pairs without dropping any recorded values", () => {
    const html = renderGroupHomeRecord(sample, true);
    for (const field of GROUP_HOME_FIELDS) {
        assert.ok(html.includes(field.label), field.id);
        assert.ok(html.includes(sample[field.id]), field.id);
    }
    assert.equal((html.match(/<tr>/g) || []).length, 17);
    assert.equal((renderGroupHomeRecord(sample).match(/<tr>/g) || []).length, 33);
});

test("invalid numeric/date/time entries stop group home saving and focus the offending field", () => {
    const { sandbox, elements } = createContext();
    let focused = false;
    elements.get("ghWater").reportValidity = () => false;
    elements.get("ghWater").focus = () => { focused = true; };
    assert.equal(validateGroupHomeFields(sandbox.document), false);
    assert.equal(focused, true);
    elements.get("ghWater").reportValidity = () => true;
    assert.equal(validateGroupHomeFields(sandbox.document), true);
});

for (const mode of ["single", "batch"]) {
    test(`group home ${mode} sending persists every field and uses its own record ID`, async () => {
        const { sandbox } = createContext();
        const saved = [], notifications = [], messages = [];
        Object.assign(sandbox, {
            batchPreparationInProgress: false, batchDataList: [],
            validateGroupHomeFields, validateDateEntries: () => true,
            confirm: () => true, prepareVideoFiles: async files => files,
            setDoc: async (reference, data) => saved.push({ reference, data }),
            notifyRecordsViaLine: async records => { notifications.push(...records); return "saved"; },
            loadImportantHandoverDashboard: async () => {},
            getPreviousDateString: () => "2026-10-23",
            updatePendingListUI() {}, onUserSelected() {},
            showToast: text => messages.push(text), getErrorMessage: error => error.message
        });
        sandbox.window.scrollTo = () => {};
        vm.runInContext([
            extract("        window.saveToBatch =", "        async function notifyRecordsViaLine("),
            extract("        window.sendSingleData =", "        function updatePendingListUI()"),
            extract("        window.sendBatchData =", "        function resetFormInputs()")
        ].join("\n"), sandbox);
        restoreGroupHomeFields(sandbox.document, sample);
        if (mode === "single") {
            await sandbox.window.sendSingleData();
        } else {
            await sandbox.window.saveToBatch();
            assert.equal(sandbox.batchDataList.length, 1);
            assert.equal(saved.length, 0);
            await sandbox.window.sendBatchData();
        }
        assert.equal(saved.length, 1, messages.join("\n"));
        assert.equal(saved[0].reference, "facilities/test-facility/daily_records/2026-10-24_グループホーム_Test User");
        for (const field of GROUP_HOME_FIELDS) assert.equal(saved[0].data[field.id], sample[field.id]);
        assert.equal(saved[0].data.imageFiles, undefined);
        assert.equal(saved[0].data.videoFiles, undefined);
        assert.equal(saved[0].data.publishToFamily, undefined);
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].serviceType, "グループホーム");
        assert.equal(messages.at(-1), "saved");
    });
}
