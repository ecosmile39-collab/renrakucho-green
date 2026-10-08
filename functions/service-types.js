const SUPPORTED_SERVICE_TYPES = [
    "デイサービス",
    "ショートステイ",
    "放課後等デイサービス",
    "児童発達支援",
    "生活介護"
];

function validateFacilityServiceTypes(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > SUPPORTED_SERVICE_TYPES.length) return null;
    if (value.some(serviceType => typeof serviceType !== "string" || !SUPPORTED_SERVICE_TYPES.includes(serviceType))) return null;
    if (new Set(value).size !== value.length) return null;
    return SUPPORTED_SERVICE_TYPES.filter(serviceType => value.includes(serviceType));
}

module.exports = { validateFacilityServiceTypes };