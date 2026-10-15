const SUPPORTED_SERVICE_TYPES = [
    "デイサービス",
    "ショートステイ",
    "放課後等デイサービス",
    "児童発達支援",
    "生活介護"
];

function normalizeFacilityServiceTypes(value) {
    if (!Array.isArray(value)) return [...SUPPORTED_SERVICE_TYPES];
    const selected = SUPPORTED_SERVICE_TYPES.filter(serviceType => value.includes(serviceType));
    return selected.length ? selected : [...SUPPORTED_SERVICE_TYPES];
}

function getFacilityBillingServiceTypes(facility) {
    const enabledTypes = normalizeFacilityServiceTypes(facility.enabledServiceTypes);
    const selected = Array.isArray(facility.billingServiceTypes)
        ? SUPPORTED_SERVICE_TYPES.filter(serviceType => facility.billingServiceTypes.includes(serviceType))
        : [];
    return selected.length ? selected : [enabledTypes[0]];
}

function calculateServicePricing(baseSubtotal, serviceTypes) {
    const additionalServiceCount = Math.max(0, serviceTypes.length - 1);
    const additionalServiceSubtotal = additionalServiceCount * 1000;
    const subtotal = baseSubtotal + additionalServiceSubtotal;
    const tax = Math.round(subtotal * 0.1);
    return { additionalServiceCount, additionalServiceSubtotal, subtotal, tax, total: subtotal + tax };
}

function validateFacilityServiceTypes(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > SUPPORTED_SERVICE_TYPES.length) return null;
    if (value.some(serviceType => typeof serviceType !== "string" || !SUPPORTED_SERVICE_TYPES.includes(serviceType))) return null;
    if (new Set(value).size !== value.length) return null;
    return SUPPORTED_SERVICE_TYPES.filter(serviceType => value.includes(serviceType));
}

module.exports = {
    calculateServicePricing,
    getFacilityBillingServiceTypes,
    normalizeFacilityServiceTypes,
    validateFacilityServiceTypes
};