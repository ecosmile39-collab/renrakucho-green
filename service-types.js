export const SERVICE_TYPES = [
    { value: "デイサービス", label: "☀️ デイサービス（日帰り）" },
    { value: "ショートステイ", label: "🌙 ショートステイ（宿泊）" },
    { value: "入所", label: "🏠 入所" },
    { value: "ユニット入所", label: "🏢 ユニット入所" },
    { value: "放課後等デイサービス", label: "🎒 放課後等デイサービス" },
    { value: "児童発達支援", label: "🧸 児童発達支援" },
    { value: "生活介護", label: "♿ 生活介護" },
    { value: "グループホーム", label: "🏡 グループホーム" }
];

export const ALL_SERVICE_TYPE_VALUES = SERVICE_TYPES.map(service => service.value);

export function isShortStayService(serviceType) {
    return ["ショートステイ", "入所", "ユニット入所"].includes(serviceType);
}

export function normalizeServiceTypes(value) {
    if (!Array.isArray(value)) return [...ALL_SERVICE_TYPE_VALUES];
    const selected = ALL_SERVICE_TYPE_VALUES.filter(serviceType => value.includes(serviceType));
    return selected.length ? selected : [...ALL_SERVICE_TYPE_VALUES];
}

export function normalizeBillingServiceTypes(value, configuredTypes = ALL_SERVICE_TYPE_VALUES) {
    const enabledTypes = normalizeServiceTypes(configuredTypes);
    const selected = Array.isArray(value)
        ? ALL_SERVICE_TYPE_VALUES.filter(serviceType => value.includes(serviceType))
        : [];
    return selected.length ? selected : [enabledTypes[0]];
}

export function getFacilityBillingServiceTypes(facility) {
    return normalizeBillingServiceTypes(facility.billingServiceTypes, facility.enabledServiceTypes);
}

export function calculateServicePricing(baseSubtotal, serviceTypes) {
    const additionalServiceCount = Math.max(0, serviceTypes.length - 1);
    const additionalServiceSubtotal = additionalServiceCount * 1000;
    const subtotal = baseSubtotal + additionalServiceSubtotal;
    const tax = Math.round(subtotal * 0.1);
    return { additionalServiceCount, additionalServiceSubtotal, subtotal, tax, total: subtotal + tax };
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