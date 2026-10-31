const assert = require("node:assert/strict");
const { test } = require("node:test");
const crypto = require("node:crypto");
const {
    buildCardPaymentUrl, buildCheckoutSessionForm, cardPaymentButtonHtml, createCardPaymentToken,
    getCardPaymentBlocker, getPaidInvoiceFromEvent, tokensMatch, verifyStripeSignature
} = require("./card-payment");

const invoice = {
    status: "sent", test: false, total: 6600, invoiceNumber: "INV-20261116-ABC",
    facilityName: "さわやかグループホーム", recipient: "facility@example.com", cardPaymentToken: "tok"
};

test("the pay link carries the facility, invoice and a secret token", () => {
    const token = createCardPaymentToken();
    assert.match(token, /^[0-9a-f]{48}$/);
    const url = new URL(buildCardPaymentUrl("fac1", "AUTO-20261116", token));
    assert.equal(url.pathname, "/startCardPayment");
    assert.equal(url.searchParams.get("f"), "fac1");
    assert.equal(url.searchParams.get("i"), "AUTO-20261116");
    assert.equal(url.searchParams.get("t"), token);
    assert.equal(tokensMatch(token, token), true);
    assert.equal(tokensMatch(token, "0".repeat(48)), false);
    assert.equal(tokensMatch("", ""), false);
});

test("only sent, unpaid, real invoices with an amount can be paid by card", () => {
    assert.equal(getCardPaymentBlocker(invoice), null);
    assert.equal(getCardPaymentBlocker({ ...invoice, paymentStatus: "paid" }), "paid");
    assert.equal(getCardPaymentBlocker({ ...invoice, test: true }), "test");
    assert.equal(getCardPaymentBlocker({ ...invoice, status: "sending" }), "not_sent");
    assert.equal(getCardPaymentBlocker({ ...invoice, total: 0 }), "no_amount");
    assert.equal(getCardPaymentBlocker({ ...invoice, cardPaymentToken: "" }), "no_token");
    assert.equal(getCardPaymentBlocker(null), "not_found");
});

test("the Stripe checkout asks for exactly the invoice total in yen and remembers which invoice it is", () => {
    const form = buildCheckoutSessionForm({ facilityId: "fac1", invoiceDocId: "AUTO-20261116", invoice });
    assert.equal(form.get("mode"), "payment");
    assert.equal(form.get("line_items[0][price_data][currency]"), "jpy");
    assert.equal(form.get("line_items[0][price_data][unit_amount]"), "6600");
    assert.equal(form.get("metadata[facilityId]"), "fac1");
    assert.equal(form.get("metadata[invoiceDocId]"), "AUTO-20261116");
    assert.equal(form.get("payment_intent_data[metadata][invoiceNumber]"), "INV-20261116-ABC");
    assert.equal(form.get("customer_email"), "facility@example.com");
    assert.match(form.get("success_url"), /card-payment\.html\?result=success/);
    assert.match(form.get("cancel_url"), /result=cancel/);
});

test("a Stripe notice is accepted only with a correct, recent signature", () => {
    const secret = "whsec_test";
    const body = JSON.stringify({ type: "checkout.session.completed" });
    const now = 1_800_000_000;
    const sign = (t, payload = body, key = secret) => crypto.createHmac("sha256", key).update(`${t}.${payload}`).digest("hex");
    assert.equal(verifyStripeSignature(Buffer.from(body), `t=${now},v1=${sign(now)}`, secret, now), true);
    assert.equal(verifyStripeSignature(body, `t=${now},v1=bad,v1=${sign(now)}`, secret, now), true);
    assert.equal(verifyStripeSignature(body, `t=${now},v1=${sign(now, body, "other")}`, secret, now), false);
    assert.equal(verifyStripeSignature(body + " ", `t=${now},v1=${sign(now)}`, secret, now), false);
    assert.equal(verifyStripeSignature(body, `t=${now - 1000},v1=${sign(now - 1000)}`, secret, now), false);
    assert.equal(verifyStripeSignature(body, "", secret, now), false);
});

test("only a completed, paid checkout marks an invoice as paid", () => {
    const event = {
        type: "checkout.session.completed",
        data: { object: { id: "cs_1", payment_status: "paid", payment_intent: "pi_1", amount_total: 6600, currency: "jpy", metadata: { facilityId: "fac1", invoiceDocId: "AUTO-1" } } }
    };
    assert.deepEqual(getPaidInvoiceFromEvent(event), { facilityId: "fac1", invoiceDocId: "AUTO-1", sessionId: "cs_1", paymentIntentId: "pi_1", amountTotal: 6600, currency: "jpy" });
    assert.equal(getPaidInvoiceFromEvent({ ...event, type: "checkout.session.expired" }), null);
    assert.equal(getPaidInvoiceFromEvent({ ...event, data: { object: { ...event.data.object, payment_status: "unpaid" } } }), null);
    assert.equal(getPaidInvoiceFromEvent({ ...event, data: { object: { ...event.data.object, metadata: {} } } }), null);
});

test("the email button escapes the link", () => {
    const html = cardPaymentButtonHtml("https://example.com/pay?f=1&i=2");
    assert.ok(html.includes("https://example.com/pay?f=1&amp;i=2"));
    assert.ok(html.includes("クレジットカードで支払う"));
});
