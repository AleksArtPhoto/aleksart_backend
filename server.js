require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const Stripe = require('stripe');

const cfg = require('./services-config');
const store = require('./bookings-store');
const mail = require('./mail');
const adminAuth = require('./admin-auth');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 3000;

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  credentials: true,
}));

// ===== Stripe webhook needs the RAW body — must be registered BEFORE express.json() =====
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    try {
      await finalizeIndividualBooking(event.data.object);
    } catch (err) {
      console.error('Error finalizing booking from webhook:', err);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(cookieParser());

// ============================================================
// PUBLIC: services config (single source of truth for the frontend)
// ============================================================
app.get('/api/services', (req, res) => {
  res.json({
    individual: cfg.INDIVIDUAL_SERVICES,
    business: cfg.BUSINESS_SERVICES,
    depositPercent: cfg.BUSINESS_DEPOSIT_PERCENT,
    workStartHour: cfg.WORK_START_HOUR,
    workEndHour: cfg.WORK_END_HOUR,
    materialsEmail: cfg.MATERIALS_EMAIL,
  });
});

// ============================================================
// PUBLIC: availability for a date (used by both B2C and B2B tabs)
// ============================================================
app.get('/api/availability', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ message: 'Missing date' });
  const map = store.getBlockedSlotsForDate(date);
  res.json({ blocked: Object.keys(map) });
});

// ============================================================
// INDIVIDUAL (B2C) — Stripe PaymentIntent
// ============================================================
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { serviceId, date, time, customer, extra } = req.body;
    const service = cfg.findService('individual', serviceId);
    if (!service) return res.status(400).json({ message: 'Unknown service.' });
    if (!customer || !customer.name || !customer.email || !customer.phone) {
      return res.status(400).json({ message: 'Missing contact details.' });
    }

    let price = service.price;
    let quantity = null;
    let giftForServiceId = null;
    let giftForServiceName = null;
    let recipientName = null;

    if (service.specialFlow === 'giftcert') {
      const target = cfg.findService('individual', extra && extra.giftForServiceId);
      if (!target || target.price == null) {
        return res.status(400).json({ message: 'Please choose a valid service for the gift certificate.' });
      }
      if (!extra || !extra.recipientName) {
        return res.status(400).json({ message: 'Please enter the recipient\'s full name.' });
      }
      price = target.price;
      giftForServiceId = target.id;
      giftForServiceName = target.name;
      recipientName = extra.recipientName;
    } else if (service.perUnit) {
      quantity = parseInt(extra && extra.photoCount, 10);
      if (!quantity || quantity < 1) {
        return res.status(400).json({ message: 'Please enter a valid number of photos.' });
      }
      price = service.price * quantity;
    }

    const needsCalendar = service.blockAfterHours !== null;
    let blockedTimes = [];

    if (needsCalendar) {
      if (!date || !time) return res.status(400).json({ message: 'Please select a date and time.' });
      const hour = parseInt(time.split(':')[0], 10);
      blockedTimes = cfg.computeBlockedSlots(hour, service.blockAfterHours);
      const anyTaken = blockedTimes.some(t => !store.isSlotFree(date, t));
      if (anyTaken) {
        return res.status(409).json({ message: 'This time slot is no longer fully available. Please choose another.' });
      }
    }

    if (service.locationField !== 'none' && !customer.location) {
      return res.status(400).json({ message: service.locationField === 'googlemeet' ? 'Please enter your Google Meet contact.' : 'Please enter the shoot location.' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(price * 100),
      currency: 'dkk',
      automatic_payment_methods: { enabled: true },
      metadata: {
        category: 'individual',
        serviceId: service.id,
        serviceName: service.name,
        price: String(price),
        quantity: quantity ? String(quantity) : '',
        specialFlow: service.specialFlow || '',
        giftForServiceId: giftForServiceId || '',
        giftForServiceName: giftForServiceName || '',
        recipientName: recipientName || '',
        date: needsCalendar ? date : '',
        time: needsCalendar ? time : '',
        blockedTimes: JSON.stringify(blockedTimes),
        locationFieldType: service.locationField,
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        customerLocation: customer.location || '',
        customerComment: (customer.comment || '').slice(0, 400),
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not start payment. Please try again.' });
  }
});

async function finalizeIndividualBooking(paymentIntentObjOrId) {
  const paymentIntent = typeof paymentIntentObjOrId === 'string'
    ? await stripe.paymentIntents.retrieve(paymentIntentObjOrId)
    : paymentIntentObjOrId;

  if (paymentIntent.status !== 'succeeded') throw new Error('Payment not completed yet.');

  const existing = store.loadBookings().find(b => b.paymentIntentId === paymentIntent.id);
  if (existing) return existing;

  const m = paymentIntent.metadata;
  const blockedTimes = m.blockedTimes ? JSON.parse(m.blockedTimes) : [];

  const booking = {
    id: paymentIntent.id,
    paymentIntentId: paymentIntent.id,
    source: 'stripe',
    status: 'confirmed',
    category: 'individual',
    serviceId: m.serviceId,
    serviceName: m.serviceName,
    price: parseInt(m.price, 10),
    quantity: m.quantity ? parseInt(m.quantity, 10) : null,
    specialFlow: m.specialFlow || null,
    giftForServiceName: m.giftForServiceName || null,
    recipientName: m.recipientName || null,
    date: m.date || null,
    time: m.time || null,
    blockedTimes,
    locationFieldType: m.locationFieldType,
    customer: {
      name: m.customerName,
      email: m.customerEmail,
      phone: m.customerPhone,
      location: m.customerLocation,
      comment: m.customerComment,
    },
    createdAt: new Date().toISOString(),
  };

  store.addBooking(booking);
  try {
    await mail.sendIndividualBookingEmails(booking);
  } catch (mailErr) {
    console.error('Booking saved, but sending the confirmation email failed:', mailErr);
  }
  return booking;
}

app.post('/api/finalize-booking', async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) return res.status(400).json({ message: 'Missing paymentIntentId' });
    const booking = await finalizeIndividualBooking(paymentIntentId);
    res.json({ ok: true, booking });
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: err.message });
  }
});

// ============================================================
// BUSINESS (B2B) — no Stripe, 48h held slot + deposit invoice by email
// ============================================================
app.post('/api/business-booking', async (req, res) => {
  try {
    const { serviceId, date, time, customer } = req.body;
    const service = cfg.findService('business', serviceId);
    if (!service) return res.status(400).json({ message: 'Unknown service.' });

    if (!customer || !customer.companyName || !customer.cvr || !customer.legalAddress || !customer.invoiceEmail || !customer.contactName) {
      return res.status(400).json({ message: 'Please fill in all required company details.' });
    }
    if (service.locationField !== 'none' && !customer.location) {
      return res.status(400).json({ message: 'Please enter the shoot location.' });
    }

    const needsCalendar = service.blockAfterHours !== null;
    let blockedTimes = [];

    if (needsCalendar) {
      if (!date || !time) return res.status(400).json({ message: 'Please select a date and time.' });
      const hour = parseInt(time.split(':')[0], 10);
      blockedTimes = cfg.computeBlockedSlots(hour, service.blockAfterHours);
      const anyTaken = blockedTimes.some(t => !store.isSlotFree(date, t));
      if (anyTaken) {
        return res.status(409).json({ message: 'This time slot is no longer fully available. Please choose another.' });
      }
    }

    const booking = {
      id: crypto.randomUUID(),
      source: 'business',
      status: 'pending_business',
      category: 'business',
      serviceId: service.id,
      serviceName: service.name,
      price: service.price,
      blockAfterHoursRule: service.blockAfterHours,
      date: needsCalendar ? date : null,
      time: needsCalendar ? time : null,
      blockedTimes,
      locationFieldType: service.locationField,
      customer: {
        companyName: customer.companyName,
        cvr: customer.cvr,
        legalAddress: customer.legalAddress,
        invoiceEmail: customer.invoiceEmail,
        contactName: customer.contactName,
        location: customer.location || '',
      },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + cfg.BUSINESS_HOLD_HOURS * 60 * 60 * 1000).toISOString(),
    };

    store.addBooking(booking);
    try {
      await mail.sendBusinessBookingEmails(booking);
    } catch (mailErr) {
      console.error('B2B booking saved, but sending the invoice email failed:', mailErr);
    }

    res.json({ ok: true, bookingId: booking.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not submit the booking request. Please try again.' });
  }
});

// ============================================================
// ADMIN
// ============================================================
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const token = adminAuth.login(username, password);
  if (!token) return res.status(401).json({ message: 'Invalid credentials.' });

  res.cookie('admin_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 12 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  adminAuth.logout(req.cookies ? req.cookies.admin_token : null);
  res.clearCookie('admin_token');
  res.json({ ok: true });
});

app.get('/api/admin/check', adminAuth.requireAdmin, (req, res) => res.json({ ok: true }));

// Full day view for the admin calendar: per-hour status + full booking list
app.get('/api/admin/day', adminAuth.requireAdmin, (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ message: 'Missing date' });

  const slots = store.getBlockedSlotsForDate(date);
  const bookings = store.getBookingsForDate(date).filter(b => b.status !== 'cancelled' && b.status !== 'expired');

  res.json({ slots, bookings });
});

app.get('/api/admin/bookings/:id', adminAuth.requireAdmin, (req, res) => {
  const booking = store.getBooking(req.params.id);
  if (!booking) return res.status(404).json({ message: 'Not found' });
  res.json(booking);
});

app.put('/api/admin/bookings/:id', adminAuth.requireAdmin, (req, res) => {
  const existing = store.getBooking(req.params.id);
  if (!existing) return res.status(404).json({ message: 'Not found' });

  const patch = { ...req.body };

  // If date/time changed, recompute the blocked buffer using the rule
  // stored at creation time (falls back to no recompute if unknown).
  if ((patch.date && patch.date !== existing.date) || (patch.time && patch.time !== existing.time)) {
    const rule = existing.blockAfterHoursRule !== undefined ? existing.blockAfterHoursRule
      : (cfg.findService(existing.category, existing.serviceId) || {}).blockAfterHours;
    const hour = parseInt((patch.time || existing.time).split(':')[0], 10);
    patch.blockedTimes = cfg.computeBlockedSlots(hour, rule);
  }

  const updated = store.updateBooking(req.params.id, patch);
  res.json({ ok: true, booking: updated });
});

app.delete('/api/admin/bookings/:id', adminAuth.requireAdmin, (req, res) => {
  const cancelled = store.cancelBooking(req.params.id);
  if (!cancelled) return res.status(404).json({ message: 'Not found' });
  res.json({ ok: true });
});

app.post('/api/admin/bookings/:id/resend', adminAuth.requireAdmin, async (req, res) => {
  const booking = store.getBooking(req.params.id);
  if (!booking) return res.status(404).json({ message: 'Not found' });
  try {
    await mail.resendConfirmation(booking);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not resend the email.' });
  }
});

// Manually create a booking from the admin panel (no payment, immediately confirmed)
app.post('/api/admin/bookings', adminAuth.requireAdmin, (req, res) => {
  const { category, serviceId, date, time, customer, price, notes } = req.body;
  const service = cfg.findService(category, serviceId);
  if (!service) return res.status(400).json({ message: 'Unknown service.' });

  let blockedTimes = [];
  if (date && time && service.blockAfterHours !== null) {
    const hour = parseInt(time.split(':')[0], 10);
    blockedTimes = cfg.computeBlockedSlots(hour, service.blockAfterHours);
    const anyTaken = blockedTimes.some(t => !store.isSlotFree(date, t));
    if (anyTaken) return res.status(409).json({ message: 'That slot overlaps an existing booking.' });
  }

  const booking = {
    id: crypto.randomUUID(),
    source: 'admin',
    status: 'confirmed',
    category,
    serviceId: service.id,
    serviceName: service.name,
    price: price || service.price,
    blockAfterHoursRule: service.blockAfterHours,
    date: date || null,
    time: time || null,
    blockedTimes,
    locationFieldType: service.locationField,
    customer: customer || {},
    adminNote: notes || '',
    createdAt: new Date().toISOString(),
  };

  store.addBooking(booking);
  res.json({ ok: true, booking });
});

app.listen(PORT, () => {
  console.log(`Booking backend running on port ${PORT}`);
});
