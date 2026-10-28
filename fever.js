// 体温が37.0℃以上のときに「★」を付けて目立たせる（入力画面・印刷・過去データで共通）
export const FEVER_THRESHOLD = 37.0;

export const TEMPERATURE_FIELD_IDS = [
    "temp1", "temp2", "stTempIn", "stTempOut", "afterSchoolTemperature", "lifeCareTemperature",
    "ghMorningTemp", "ghEveningTemp", "rsMorningTemp", "rsEveningTemp"
];

export function isFever(value) {
    const text = String(value ?? "").trim();
    if (!/^\d+(\.\d+)?$/.test(text)) return false;
    return Number(text) >= FEVER_THRESHOLD;
}

// 文字として表示するとき（例：「★37.2」）
export function markFever(value) {
    const text = String(value ?? "").trim();
    return isFever(text) ? `★${text}` : text;
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
}[character]));

// 印刷・過去データ用のHTML。37.0℃以上は赤の太字で「★37.2℃」
export function temperatureHtml(value, { unit = "℃", empty = "--" } = {}) {
    const text = String(value ?? "").trim();
    if (!text) return escapeHtml(empty);
    if (!isFever(text)) return `${escapeHtml(text)}${unit}`;
    return `<span class="fever-mark" style="color:#c92a2a;font-weight:bold;">★${escapeHtml(text)}${unit}</span>`;
}
