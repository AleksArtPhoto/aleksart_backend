const fs = require('fs');
const path = require('path');
const { BUSINESS_DEPOSIT_PERCENT } = require('./services-config');

const TEMPLATE_PATH = path.join(__dirname, 'invoice-template.html');

function fillTemplate(template, data) {
  let out = template;
  Object.entries(data).forEach(([key, value]) => {
    out = out.split(`{{${key}}}`).join(String(value));
  });
  return out;
}

function nextInvoiceNumber() {
  // Simple, readable invoice number: date + random 4 digits.
  // Good enough for a single-photographer volume; swap for a running
  // counter in bookings-store.js if you want strictly sequential numbers.
  const now = new Date();
  const y = now.getFullYear();
  const m = (now.getMonth() + 1).toString().padStart(2, '0');
  const d = now.getDate().toString().padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `INV-${y}${m}${d}-${rand}`;
}

function formatDateDK(date) {
  return date.toLocaleDateString('da-DK', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

// booking: { serviceName, price, date, time, customer: { companyName, cvr, legalAddress, ... } }
function buildDepositInvoiceHtml(booking) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  const fullPrice = booking.price;
  const depositAmount = Math.round(fullPrice * (BUSINESS_DEPOSIT_PERCENT / 100));
  const remaining = fullPrice - depositAmount;

  // Danish VAT (moms) is 25%, assume displayed prices are VAT-inclusive.
  const subtotal = Math.round((depositAmount / 1.25) * 100) / 100;
  const momsAmount = Math.round((depositAmount - subtotal) * 100) / 100;

  const now = new Date();
  const due = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const html = fillTemplate(template, {
    client_company_name: booking.customer.companyName || '',
    client_address: booking.customer.legalAddress || '',
    client_cvr: booking.customer.cvr || '',
    client_contact_name: booking.customer.contactName || '',
    invoice_number: nextInvoiceNumber(),
    invoice_date: formatDateDK(now),
    due_date: formatDateDK(due),
    service_description: `${booking.serviceName} — ${BUSINESS_DEPOSIT_PERCENT}% Deposit`,
    booking_date_time: booking.date && booking.time ? `${booking.date} ${booking.time}` : 'N/A',
    price: depositAmount,
    subtotal,
    moms_amount: momsAmount,
    total_amount: depositAmount,
    deposit_percent: BUSINESS_DEPOSIT_PERCENT,
    full_service_price: fullPrice,
    remaining_balance: remaining,
  });

  return { html, depositAmount, remaining, dueDate: due };
}

module.exports = { buildDepositInvoiceHtml };
