const { calculateServicePricing } = require("./service-types");

function normalizeOneTimeInvoiceAdjustment(value) {
    if (value == null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("追加請求の設定が正しくありません。");
    }

    const id = typeof value.id === "string" ? value.id.trim() : "";
    const description = typeof value.description === "string" ? value.description.trim() : "";
    const amount = value.amount;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) ||
        !description ||
        description.length > 80 ||
        !Number.isSafeInteger(amount) ||
        amount < 1 ||
        amount > 1000000) {
        throw new TypeError("追加請求の項目名または金額が正しくありません。");
    }
    return { id, description, amount };
}

function calculateInvoicePricing(baseSubtotal, serviceTypes, adjustmentValue, lineAgencyFeeValue) {
    const adjustment = normalizeOneTimeInvoiceAdjustment(adjustmentValue);
    const lineAgencyFee = normalizeOneTimeInvoiceAdjustment(lineAgencyFeeValue);
    const servicePricing = calculateServicePricing(baseSubtotal, serviceTypes);
    const subtotal = servicePricing.subtotal + (adjustment?.amount || 0) + (lineAgencyFee?.amount || 0);
    const tax = Math.round(subtotal * 0.1);
    return {
        ...servicePricing,
        subtotal,
        tax,
        total: subtotal + tax,
        oneTimeAdjustment: adjustment,
        ...(lineAgencyFee ? { lineAgencyFee } : {})
    };
}

module.exports = {
    calculateInvoicePricing,
    normalizeOneTimeInvoiceAdjustment
};
