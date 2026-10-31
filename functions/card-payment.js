// クレジットカード払い（Stripe）
// 請求書メールの「クレジットカードで支払う」ボタン → startCardPayment がその請求書の Stripe 決済画面を作って移動
// → 支払いが済むと Stripe から stripeWebhook に連絡が届き、請求書を「入金あり」にする。
// Stripe の公式ライブラリは使わず、決済画面の作成（REST API）と連絡の署名確認だけを自前で行う。

const crypto = require("node:crypto");

const CARD_PAYMENT_START_URL = "https://us-central1-renrakucho-app-6b157.cloudfunctions.net/startCardPayment";
const CARD_PAYMENT_RESULT_URL = "https://renrakucho-green.vercel.app/card-payment.html";
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

function createCardPaymentToken() {
    return crypto.randomBytes(24).toString("hex");
}

function buildCardPaymentUrl(facilityId, invoiceDocId, token, baseUrl = CARD_PAYMENT_START_URL) {
    const params = new URLSearchParams({ f: facilityId, i: invoiceDocId, t: token });
    return `${baseUrl}?${params.toString()}`;
}

function tokensMatch(supplied, expected) {
    if (typeof supplied !== "string" || typeof expected !== "string" || !supplied || !expected) return false;
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// カードで払える請求書か（送信済み・未入金・テストでない・金額がある・合言葉がある）
function getCardPaymentBlocker(invoice) {
    if (!invoice) return "not_found";
    if (invoice.test === true) return "test";
    if (invoice.paymentStatus === "paid") return "paid";
    if (invoice.status !== "sent") return "not_sent";
    if (!Number.isInteger(invoice.total) || invoice.total <= 0) return "no_amount";
    if (!invoice.cardPaymentToken) return "no_token";
    return null;
}

// Stripe の決済画面（Checkout Session）を作るときの中身（application/x-www-form-urlencoded）
function buildCheckoutSessionForm({ facilityId, invoiceDocId, invoice, resultUrl = CARD_PAYMENT_RESULT_URL }) {
    const invoiceNumber = String(invoice.invoiceNumber || invoiceDocId);
    const form = new URLSearchParams();
    form.set("mode", "payment");
    form.set("locale", "ja");
    form.set("line_items[0][quantity]", "1");
    form.set("line_items[0][price_data][currency]", "jpy");
    form.set("line_items[0][price_data][unit_amount]", String(invoice.total));
    form.set("line_items[0][price_data][product_data][name]", `えこすまいる連絡帳 ご利用料金（請求書番号 ${invoiceNumber}）`);
    const facilityName = String(invoice.facilityName || "").slice(0, 200);
    if (facilityName) form.set("line_items[0][price_data][product_data][description]", `${facilityName} 様`);
    if (typeof invoice.recipient === "string" && invoice.recipient.includes("@")) form.set("customer_email", invoice.recipient);
    form.set("client_reference_id", `${facilityId}/${invoiceDocId}`);
    for (const [key, value] of Object.entries({ facilityId, invoiceDocId, invoiceNumber })) {
        form.set(`metadata[${key}]`, value);
        form.set(`payment_intent_data[metadata][${key}]`, value);
    }
    form.set("payment_intent_data[description]", `えこすまいる連絡帳 請求書 ${invoiceNumber}`);
    form.set("success_url", `${resultUrl}?result=success&invoice=${encodeURIComponent(invoiceNumber)}`);
    form.set("cancel_url", `${resultUrl}?result=cancel&invoice=${encodeURIComponent(invoiceNumber)}`);
    return form;
}

// Stripe-Signature（t=タイムスタンプ,v1=署名）を確かめる
function verifyStripeSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000), tolerance = STRIPE_SIGNATURE_TOLERANCE_SECONDS) {
    if (!rawBody || typeof header !== "string" || !secret) return false;
    const parts = header.split(",").map(part => part.trim().split("="));
    const timestamp = Number((parts.find(([key]) => key === "t") || [])[1]);
    const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
    if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
    if (Math.abs(nowSeconds - timestamp) > tolerance) return false;
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
    const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    return signatures.some(signature => tokensMatch(signature, expected));
}

// 支払い完了の連絡から、どの請求書かを取り出す
function getPaidInvoiceFromEvent(event) {
    if (!event || event.type !== "checkout.session.completed") return null;
    const session = event.data && event.data.object;
    if (!session || session.payment_status !== "paid") return null;
    const metadata = session.metadata || {};
    if (!metadata.facilityId || !metadata.invoiceDocId) return null;
    return {
        facilityId: String(metadata.facilityId),
        invoiceDocId: String(metadata.invoiceDocId),
        sessionId: String(session.id || ""),
        paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : "",
        amountTotal: Number(session.amount_total),
        currency: String(session.currency || "")
    };
}

function cardPaymentButtonHtml(url) {
    const href = String(url).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    return `<div style="margin:20px 0;padding:14px;background:#f3f0ff;border:1px solid #b197fc;border-radius:6px">
        <p style="margin:0 0 10px;font-weight:bold">クレジットカードでもお支払いいただけます</p>
        <a href="${href}" style="display:inline-block;padding:12px 20px;background:#5f3dc4;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">💳 クレジットカードで支払う</a>
        <p style="margin:10px 0 0;font-size:12px;color:#555">決済は Stripe の安全な画面で行います。カード番号は当社には届きません。お支払い後、自動で入金済みになります。</p>
    </div>`;
}

function cardPaymentText(url) {
    return `【クレジットカードでのお支払い】\n下のURLから、クレジットカードでもお支払いいただけます（決済は Stripe の画面で行います）。\n${url}`;
}

module.exports = {
    CARD_PAYMENT_START_URL,
    CARD_PAYMENT_RESULT_URL,
    createCardPaymentToken,
    buildCardPaymentUrl,
    tokensMatch,
    getCardPaymentBlocker,
    buildCheckoutSessionForm,
    verifyStripeSignature,
    getPaidInvoiceFromEvent,
    cardPaymentButtonHtml,
    cardPaymentText
};
