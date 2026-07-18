const fs = require('fs');
const path = require('path');
const { BUSINESS_HOLD_HOURS } = require('./services-config');

const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

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

// Business bookings that are still 'pending_business' and older than
// BUSINESS_HOLD_HOURS get auto-cancelled and free up their slot.
// Called at the top of every read so the calendar is always accurate
// without needing a separate background worker/cron.
function expireStaleBookings() {
  const bookings = loadBookings();
  const now = Date.now();
  let changed = false;

  bookings.forEach(b => {
    if (b.status === 'pending_business' && b.expiresAt && now > new Date(b.expiresAt).getTime()) {
      b.status = 'expired';
      changed = true;
    }
  });

  if (changed) saveBookings(bookings);
  return bookings;
}

function activeBookings(bookings) {
  return bookings.filter(b => b.status === 'confirmed' || b.status === 'pending_business');
}

function isSlotFree(date, time, excludeId = null) {
  const bookings = activeBookings(expireStaleBookings());
  const hour = time; // already "HH:00"
  return !bookings.some(b => {
    if (b.id === excludeId) return false;
    if (b.date !== date) return false;
    return b.blockedTimes.includes(hour);
  });
}

function getBlockedSlotsForDate(date) {
  const bookings = activeBookings(expireStaleBookings());
  const map = {}; // time -> { status, isStart, bookingId }
  bookings.filter(b => b.date === date).forEach(b => {
    b.blockedTimes.forEach(t => {
      map[t] = {
        status: b.status,
        isStart: t === b.time,
        bookingId: b.id,
      };
    });
  });
  return map;
}

function addBooking(booking) {
  const bookings = loadBookings();
  bookings.push(booking);
  saveBookings(bookings);
  return booking;
}

function updateBooking(id, patch) {
  const bookings = loadBookings();
  const idx = bookings.findIndex(b => b.id === id);
  if (idx === -1) return null;
  bookings[idx] = { ...bookings[idx], ...patch };
  saveBookings(bookings);
  return bookings[idx];
}

function cancelBooking(id) {
  return updateBooking(id, { status: 'cancelled' });
}

function getBooking(id) {
  return loadBookings().find(b => b.id === id) || null;
}

function getBookingsForDate(date) {
  return expireStaleBookings().filter(b => b.date === date);
}

module.exports = {
  loadBookings,
  saveBookings,
  expireStaleBookings,
  isSlotFree,
  getBlockedSlotsForDate,
  addBooking,
  updateBooking,
  cancelBooking,
  getBooking,
  getBookingsForDate,
  BUSINESS_HOLD_HOURS,
};
