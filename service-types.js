export const SERVICE_TYPES = [
    { value: "デイサービス", label: "☀️ デイサービス（日帰り）" },
    { value: "ショートステイ", label: "🌙 ショートステイ（宿泊）" },
    { value: "放課後等デイサービス", label: "🎒 放課後等デイサービス" },
    { value: "児童発達支援", label: "🧸 児童発達支援" },
    { value: "生活介護", label: "♿ 生活介護" }
];

export const ALL_SERVICE_TYPE_VALUES = SERVICE_TYPES.map(service => service.value);

export function normalizeServiceTypes(value) {
    if (!Array.isArray(value)) return [...ALL_SERVICE_TYPE_VALUES];
    const selected = ALL_SERVICE_TYPE_VALUES.filter(serviceType => value.includes(serviceType));
    return selected.length ? selected : [...ALL_SERVICE_TYPE_VALUES];
}

export function populateServiceTypeSelect(select, configuredTypes, preferredValue = select.value) {
    const enabledTypes = normalizeServiceTypes(configuredTypes);
    const enabledSet = new Set(enabledTypes);
    select.replaceChildren(...SERVICE_TYPES.filter(service => enabledSet.has(service.value)).map(service => {
        const option = document.createElement("option");
        option.value = service.value;
        option.textContent = service.label;
        return option;
    }));
    select.value = enabledSet.has(preferredValue) ? preferredValue : enabledTypes[0];
    return select.value;
}