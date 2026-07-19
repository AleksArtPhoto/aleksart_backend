const nodemailer = require('nodemailer');
const { MATERIALS_EMAIL, BUSINESS_DEPOSIT_PERCENT } = require('./services-config');
const { buildDepositInvoiceHtml } = require('./invoice');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function send(to, subject, text, html) {
  return transporter.sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject,
    text,
    html: html || undefined,
  });
}

// ===== INDIVIDUAL (B2C) — sent after a successful Stripe payment =====
async function sendIndividualBookingEmails(booking) {
  const c = booking.customer;

  if (booking.isGift) {
    const whenLine = booking.date ? `\nScheduled for: ${booking.date} ${booking.time}` : '';
    const text = `Dear ${c.name},

Thank you for your purchase! You've gifted "${booking.serviceName}" to ${booking.recipientName}.
${whenLine}
Amount paid: ${booking.price} DKK

You will receive the gift certificate itself by email shortly, ready to pass on to ${booking.recipientName}.

Best regards,
Aleks Art Photo`;

    await send(c.email, 'Gift Certificate Purchase Confirmed | Aleks Art Photo', text);
    await send(process.env.OWNER_EMAIL, `New gift purchase — ${c.name} → ${booking.recipientName}`,
      `Gift certificate purchased.\n\nService: ${booking.serviceName}${whenLine}\nRecipient name: ${booking.recipientName}\nAmount paid: ${booking.price} DKK\n\nBuyer: ${c.name}\nEmail: ${c.email}\nPhone: ${c.phone}`);
    return;
  }

  if (booking.specialFlow === 'materials') {
    // Pro Edit / Fine Art Retouch / Photo Restoration — no calendar slot
    const qtyLine = booking.quantity ? `Quantity: ${booking.quantity} photo(s)\n` : '';
    const text = `Dear ${c.name},

Thank you for your payment — your order for "${booking.serviceName}" has been confirmed.

${qtyLine}Amount paid: ${booking.price} DKK

Next step: please send your photos/materials to ${MATERIALS_EMAIL} so we can begin working on your order. Please reference your name and order date in the email.

If you have any questions, feel free to reply to this email.

Best regards,
Aleks Art Photo`;

    await send(c.email, 'Payment Confirmed — Please Send Your Materials | Aleks Art Photo', text);
    await send(process.env.OWNER_EMAIL, `New paid order (materials): ${booking.serviceName} — ${c.name}`,
      `${text}\n\n--- Customer contact ---\nEmail: ${c.email}\nPhone: ${c.phone}`);
    return;
  }

  // Regular photoshoot/session booking
  const locationLine = booking.locationFieldType === 'googlemeet'
    ? `Google Meet contact: ${c.location}`
    : `Location: ${c.location}`;

  const text = `Dear ${c.name},

Your payment was successful and your session is booked.

Service: ${booking.serviceName}
Date: ${booking.date}
Time: ${booking.time}
Price: ${booking.price} DKK
${locationLine}
${c.comment ? `Comment: ${c.comment}` : ''}

See you then!
Aleks Art Photo`;

  await send(c.email, 'Your Booking is Confirmed | Aleks Art Photo', text);
  await send(process.env.OWNER_EMAIL, `New paid booking: ${c.name} — ${booking.date} ${booking.time}`,
    `${text}\n\n--- Customer contact ---\nEmail: ${c.email}\nPhone: ${c.phone}`);
}

// ===== BUSINESS (B2B) — sent right after a "Request Invoice & Book" =====
async function sendBusinessBookingEmails(booking) {
  const { html, depositAmount, remaining, dueDate } = buildDepositInvoiceHtml(booking);
  const c = booking.customer;

  const clientText = `Dear ${c.contactName},

Thank you for your booking request for "${booking.serviceName}"${booking.date ? ` on ${booking.date} at ${booking.time}` : ''}.

Your slot is provisionally held. To fully secure it, please pay the attached deposit invoice (${BUSINESS_DEPOSIT_PERCENT}% of the total, ${depositAmount} DKK) within 24 hours (by ${dueDate.toLocaleDateString('da-DK')}). If payment isn't received in time, the slot will be released automatically.

Please see the attached invoice for full payment details.

Best regards,
Aleks Art Photo`;

  await send(
    c.invoiceEmail,
    `Deposit Invoice — ${booking.serviceName} | Aleks Art Photo`,
    clientText,
    html
  );

  const ownerText = `New pending B2B booking request:

Service: ${booking.serviceName}
Date/time: ${booking.date ? `${booking.date} ${booking.time}` : 'N/A (no calendar for this service)'}
Full price: ${booking.price} DKK
Deposit invoiced: ${depositAmount} DKK / remaining: ${remaining} DKK

Company: ${c.companyName}
CVR: ${c.cvr}
Legal address: ${c.legalAddress}
Invoice email: ${c.invoiceEmail}
Contact / PO: ${c.contactName}
${c.location ? `Location: ${c.location}` : ''}

This booking will auto-expire in 48 hours if you don't confirm it in the admin panel.`;

  await send(process.env.OWNER_EMAIL, `New B2B booking request: ${c.companyName}`, ownerText);
}

// ===== Called from the admin panel's "resend confirmation" button =====
async function resendConfirmation(booking) {
  if (booking.category === 'business') {
    return sendBusinessBookingEmails(booking);
  }
  return sendIndividualBookingEmails(booking);
}

module.exports = {
  sendIndividualBookingEmails,
  sendBusinessBookingEmails,
  resendConfirmation,
};
