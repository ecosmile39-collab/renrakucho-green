const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { isShortStayService } = require("./service-types");

const source = readFileSync(path.join(__dirname, "index.js"), "utf8");
const start = source.indexOf("function getFamilyVisibleFields(");
const end = source.indexOf("async function getLineAttachment(", start);
const sandbox = { isShortStayService };
vm.createContext(sandbox);
vm.runInContext(source.slice(start, end), sandbox);
const visible = (record, customization = {}) => Object.fromEntries(
    sandbox.getFamilyVisibleFields(record, customization).map(field => [field.label, field.value])
);

test("long-term residential records show daily life, supplies and visits to families", () => {
    const fields = visible({
        serviceType: "ユニット入所", recordLayout: "residential", careStaff: "佐藤",
        rsMorningTemp: "36.4", rsMealLunch: "10割", rsDailyActivity: "体操", rsSupplies: "歯磨き粉", rsVisit: "長女様面会",
        stTempIn: "37.0", stBelongingMemo: "旧形式", handoverNote: "職員だけの申し送り"
    });
    assert.equal(fields["朝・体温（℃）"], "36.4");
    assert.equal(fields["昼食"], "10割");
    assert.equal(fields["日中の活動・レクリエーション"], "体操");
    assert.equal(fields["日用品の残量・補充のお願い"], "歯磨き粉");
    assert.equal(fields["面会・外出の記録"], "長女様面会");
    assert.equal(fields["担当スタッフ"], "佐藤");
    assert.equal(fields["入所時体温"], undefined);
    assert.equal(fields["持ち物メモ"], undefined);
    assert.equal(Object.values(fields).includes("職員だけの申し送り"), false);
    const hidden = visible({ serviceType: "入所", recordLayout: "residential", rsVisit: "面会", hiddenFormSections: ["residentialSection"] });
    assert.equal(hidden["面会・外出の記録"], undefined);
});

test("older 入所 records without the residential layout keep the short-stay family view", () => {
    const fields = visible({ serviceType: "入所", stTempIn: "36.8", stBelongingMemo: "着替え" });
    assert.equal(fields["入所時体温"], "36.8");
    assert.equal(fields["持ち物メモ"], "着替え");
});

test("day service shows attendance and transport times, and child development shows lunch and domains", () => {
    const day = visible({ serviceType: "デイサービス", dsAttendance: "利用", dsPickupTime: "08:45", dsDropoffTime: "16:30", dsPickupType: "施設送迎" });
    assert.equal(day["利用状況"], "利用");
    assert.equal(day["お迎え時刻"], "08:45");
    assert.equal(day["お送り時刻"], "16:30");
    assert.equal(day["行きの送迎"], "施設送迎");
    const child = visible({ serviceType: "児童発達支援", afterSchoolLunch: "給食", afterSchoolLunchIntake: "完食",
        afterSchoolDomainTags: ["健康・生活", "人間関係・社会性"] });
    assert.equal(child["昼食"], "給食");
    assert.equal(child["昼食の摂取量"], "完食");
    assert.equal(child["支援の5領域"], "健康・生活、人間関係・社会性");
});

test("temperatures of 37.0 or more get a star for families, lower ones and other values stay as they are", () => {
    const fields = visible({ serviceType: "デイサービス", temp1: "37.0", temp2: "36.9", pulse: "37" });
    assert.equal(fields["体温"], "★37.0");
    assert.equal(fields["体温（途中）"], "36.9");
    assert.equal(fields["脈拍"], "37");
    const life = visible({ serviceType: "生活介護", lifeCareTemperature: "38.2" });
    assert.equal(life["体温"], "★38.2");
    const home = visible({ serviceType: "グループホーム", ghEveningTemp: "37.4", ghMorningTemp: "36.2" });
    assert.equal(home["夕・体温（℃）"], "★37.4");
    assert.equal(home["朝・体温（℃）"], "36.2");
    const child = visible({ serviceType: "児童発達支援", afterSchoolTemperature: "37.5" });
    assert.equal(child["来所時体温"], "★37.5");
});

test("day care records show the rehabilitation details to families, and hide them with the day section", () => {
    const record = {
        serviceType: "デイケア", careStaff: "佐藤", temp1: "36.5", training: "歩行訓練、バランス訓練",
        rhStaffRole: "理学療法士（PT）", rhStaffName: "山田", rhItems: "歩行訓練 10m×3回",
        rhItemRows: [{ name: "歩行訓練", amount: "10m×3回" }],
        rhGoal: "杖で自宅のトイレまで歩ける", rhChange: "手すりなしで5回立ち上がれた", dsAttendance: "利用"
    };
    const fields = visible(record);
    assert.equal(fields["実施したリハビリ"], "歩行訓練、バランス訓練");
    assert.equal(fields["機能訓練"], undefined);
    assert.equal(fields["担当リハビリ職"], "理学療法士（PT）");
    assert.equal(fields["リハビリ担当者"], "山田");
    assert.equal(fields["リハビリの内容と量"], "歩行訓練 10m×3回");
    assert.equal(fields["前回からの変化・できたこと"], "手すりなしで5回立ち上がれた");
    assert.equal(fields["リハビリの目標"], "杖で自宅のトイレまで歩ける");
    assert.equal(fields["利用状況"], "利用");
    const hidden = visible({ ...record, hiddenFormSections: ["dayServiceSection"] });
    assert.equal(hidden["リハビリの内容と量"], undefined);
    assert.equal(hidden["担当リハビリ職"], undefined);
    const dayService = visible({ serviceType: "デイサービス", training: "歩行訓練", rhItems: "古いデータ" });
    assert.equal(dayService["機能訓練"], "歩行訓練");
    assert.equal(dayService["リハビリの内容と量"], undefined);
});
