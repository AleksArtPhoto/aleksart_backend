require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 3000;
const BLOCK_HOURS_AFTER_BOOKING = parseInt(process.env.BLOCK_HOURS_AFTER_BOOKING || '2', 10);
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 20;

const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

const app = express();

app.use(cors({
  origin: (process.env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim()),
}));

// ===== Stripe webhook needs the RAW body, so it must be registered
// BEFORE the json() body parser below =====
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
      await finalizeBookingFromIntent(event.data.object);
    } catch (err) {
      console.error('Error finalizing booking from webhook:', err);
    }
  }

  res.json({ received: true });
});

app.use(express.json());

// ===== Storage helpers (simple JSON file — fine for a single-photographer calendar) =====
function loadBookings() {
  if (!fs.existsSync(BOOKINGS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveBookings(bookings) {
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
}

// Hourly slots a booking occupies: the booked hour itself, plus the
// configured number of hours after it (buffer to travel to the next job).
function blockedSlotsForStart(hour) {
  const slots = [];
  for (let h = hour; h <= Math.min(hour + BLOCK_HOURS_AFTER_BOOKING, WORK_END_HOUR); h++) {
    slots.push(`${h.toString().padStart(2, '0')}:00`);
  }
  return slots;
}

function isSlotFree(bookings, date, time) {
  const hour = parseInt(time.split(':')[0], 10);
  return !bookings.some(b => {
    if (b.date !== date) return false;
    return b.blockedTimes.includes(`${hour.toString().padStart(2, '0')}:00`);
  });
}

// ===== Mail =====
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendBookingEmails(booking) {
  const summary = `
Service: ${booking.serviceName}${booking.isGift ? ' (Gift Certificate)' : ''}
Date: ${booking.date}
Time: ${booking.time}
Price: ${booking.price} DKK
Location: ${booking.customer.location}
${booking.customer.comment ? `Comment: ${booking.customer.comment}` : ''}
`.trim();

  // Confirmation to the client
  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: booking.customer.email,
    subject: 'Your booking is confirmed — Aleks Art Photo',
    text: `Hi ${booking.customer.name},\n\nYour payment went through and your session is booked.\n\n${summary}\n\nSee you then!\nAleks Art Photo`,
  });

  // Copy to the owner for record-keeping
  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: process.env.OWNER_EMAIL,
    subject: `New paid booking: ${booking.customer.name} — ${booking.date} ${booking.time}`,
    text: `New confirmed booking:\n\n${summary}\n\nClient: ${booking.customer.name}\nEmail: ${booking.customer.email}\nPhone: ${booking.customer.phone}\n\nPayment Intent: ${booking.paymentIntentId}`,
  });
}

// ===== Idempotent finalize: called from both the webhook and the
// client's "finalize" call right after confirmCardPayment resolves =====
async function finalizeBookingFromIntent(paymentIntentObjOrId) {
  const paymentIntent = typeof paymentIntentObjOrId === 'string'
    ? await stripe.paymentIntents.retrieve(paymentIntentObjOrId)
    : paymentIntentObjOrId;

  if (paymentIntent.status !== 'succeeded') {
    throw new Error('Payment not completed yet.');
  }

  const bookings = loadBookings();

  // already recorded (webhook + client call can both fire) — skip duplicate
  if (bookings.some(b => b.paymentIntentId === paymentIntent.id)) {
    return bookings.find(b => b.paymentIntentId === paymentIntent.id);
  }

  const meta = paymentIntent.metadata;
  const hour = parseInt(meta.time.split(':')[0], 10);

  const booking = {
    id: paymentIntent.id,
    paymentIntentId: paymentIntent.id,
    date: meta.date,
    time: meta.time,
    blockedTimes: blockedSlotsForStart(hour),
    category: meta.category,
    serviceId: meta.serviceId,
    serviceName: meta.serviceName,
    price: parseInt(meta.price, 10),
    isGift: meta.isGift === 'true',
    customer: {
      name: meta.customerName,
      email: meta.customerEmail,
      phone: meta.customerPhone,
      location: meta.customerLocation,
      comment: meta.customerComment || '',
    },
    createdAt: new Date().toISOString(),
  };

  bookings.push(booking);
  saveBookings(bookings);

  await sendBookingEmails(booking);

  return booking;
}

// ===== Routes =====

// Which hourly slots are already taken for a given date
app.get('/api/availability', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ message: 'Missing date' });

  const bookings = loadBookings();
  const blocked = new Set();
  bookings.filter(b => b.date === date).forEach(b => {
    b.blockedTimes.forEach(t => blocked.add(t));
  });

  res.json({ blocked: Array.from(blocked) });
});

// Create a PaymentIntent for the chosen service/date/time, after
// re-checking the slot is still free (protects against double-booking
// when two people are looking at the same slot at once)
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { category, serviceId, serviceName, price, isGift, date, time, customer } = req.body;

    if (!category || !serviceId || !serviceName || !price || !date || !time || !customer) {
      return res.status(400).json({ message: 'Missing booking details.' });
    }
    if (!customer.name || !customer.email || !customer.phone || !customer.location) {
      return res.status(400).json({ message: 'Missing contact details.' });
    }

    const bookings = loadBookings();
    if (!isSlotFree(bookings, date, time)) {
      return res.status(409).json({ message: 'This time slot was just booked by someone else. Please choose another.' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(price * 100), // DKK -> øre
      currency: 'dkk',
      automatic_payment_methods: { enabled: true },
      metadata: {
        category,
        serviceId,
        serviceName,
        price: String(price),
        isGift: String(!!isGift),
        date,
        time,
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        customerLocation: customer.location,
        customerComment: (customer.comment || '').slice(0, 400),
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not start payment. Please try again.' });
  }
});

// Called by the frontend right after stripe.confirmCardPayment succeeds.
// Also mirrored by the webhook above so a booking still gets recorded
// and emailed even if the client's tab closes right after paying.
app.post('/api/finalize-booking', async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) return res.status(400).json({ message: 'Missing paymentIntentId' });

    const booking = await finalizeBookingFromIntent(paymentIntentId);
    res.json({ ok: true, booking });
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Booking backend running on port ${PORT}`);
});
