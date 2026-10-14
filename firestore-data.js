export function removeUndefinedFields(value) {
    if (Array.isArray(value)) {
        return value.map(item => item === undefined ? null : removeUndefinedFields(item));
    }
    if (!value || typeof value !== "object") return value;

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;

    return Object.fromEntries(
        Object.entries(value)
            .filter(([, fieldValue]) => fieldValue !== undefined)
            .map(([key, fieldValue]) => [key, removeUndefinedFields(fieldValue)])
    );
}
