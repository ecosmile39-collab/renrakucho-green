export const FORM_CUSTOMIZATION_SECTIONS = [
    { id: "careJournalArea", label: "介護日誌・重要申し送り" },
    { id: "dayServiceSection", label: "デイサービスの記録" },
    { id: "afterSchoolSection", label: "放課後等デイサービス・児童発達支援の記録" },
    { id: "lifeCareSection", label: "生活介護の記録" },
    { id: "shortStaySection", label: "ショートステイの記録" },
    { id: "facilityMessageSection", label: "施設からの連絡・お知らせ" },
    { id: "familyMessageSection", label: "ご家族からの連絡" },
    { id: "facilityPRSection", label: "施設からのお知らせ・PR" },
    { id: "mediaSection", label: "写真・動画" }
];

export const CUSTOM_FORM_FIELD_TYPES = ["text", "textarea", "number", "date", "checkbox"];
export const MAX_CUSTOM_FORM_FIELDS = 20;

export function normalizeFacilityFormCustomization(value) {
    const input = value && typeof value === "object" ? value : {};
    const knownSections = new Set(FORM_CUSTOMIZATION_SECTIONS.map(section => section.id));
    const hiddenSections = Array.isArray(input.hiddenSections)
        ? [...new Set(input.hiddenSections.filter(section => knownSections.has(section)))]
        : [];
    const customFields = Array.isArray(input.customFields)
        ? input.customFields.slice(0, MAX_CUSTOM_FORM_FIELDS).flatMap(field => {
            if (!field || typeof field !== "object") return [];
            const id = typeof field.id === "string" ? field.id : "";
            const label = typeof field.label === "string" ? field.label.trim().slice(0, 60) : "";
            const type = CUSTOM_FORM_FIELD_TYPES.includes(field.type) ? field.type : "text";
            if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !label) return [];
            return [{ id, label, type, familyVisible: field.familyVisible === true }];
        })
        : [];
    return { hiddenSections, customFields };
}