// ===== CONFIG =====
const API_BASE = window.BOOKING_API_BASE || '';
const stripe = Stripe(window.STRIPE_PUBLIC_KEY);
const $ = (id) => document.getElementById(id);

let SERVICES = { individual: [], business: [], depositPercent: 30, workStartHour: 9, workEndHour: 20 };

const state = {
  individual: { serviceId: '', service: null, date: null, time: null, blockedTimes: [], price: 0 },
  business: { serviceId: '', service: null, date: null, time: null, blockedTimes: [], price: 0 },
};

let currentPaymentIntentId = null;

function formatNumber(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// ============================================================
// PAGE INIT — the toggle, calendars and buttons must all work
// even if the backend is unreachable, so wiring them up does NOT
// wait on the /api/services fetch. Only the service dropdowns
// (which need real data) depend on that fetch succeeding.
// ============================================================
function initStaticUI() {
  setupToggle();
  setupIndividualPanel();
  setupBusinessPanel();
  setupPolicyToggle();
}

async function loadServices() {
  try {
    const res = await fetch(`${API_BASE}/api/services`);
    if (!res.ok) throw new Error('Bad response');
    SERVICES = await res.json();
    populateSelect($('individual-select'), SERVICES.individual);
    populateSelect($('business-select'), SERVICES.business);
  } catch (err) {
    console.error('Could not load services config', err);
    const err1 = $('individual-form-error');
    if (err1) {
      err1.textContent = 'Could not load the services list from the server. The toggle and calendar still work, but please check BOOKING_API_BASE in booking.html and that the backend is running.';
      err1.classList.remove('hidden');
    }
  }
}

function populateSelect(selectEl, services) {
  services.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.price != null ? `${s.name} — ${formatNumber(s.price)} DKK` : s.name;
    selectEl.appendChild(opt);
  });
}

// ============================================================
// BRAND TOGGLE (visual behaviour copied 1:1 from the homepage toggle)
// ============================================================
function setupToggle() {
  const toggleContainer = $('toggle-container');
  const toggleBg = $('toggle-bg');
  const textB2C = $('text-b2c');
  const textB2B = $('text-b2b');
  const b2cContent = $('b2c-content');
  const b2bContent = $('b2b-content');

  if (!toggleContainer || !b2cContent || !b2bContent) return;

  let isBusinessMode = false;

  toggleBg.style.left = '4px';
  toggleBg.style.background = '#e2e8f0';
  textB2C.style.color = '#1e293b';
  textB2B.style.color = '#94a3b8';

  toggleContainer.addEventListener('click', () => {
    isBusinessMode = !isBusinessMode;

    if (isBusinessMode) {
      toggleBg.style.left = 'calc(100% - 142px)';
      toggleBg.style.background = '#2c3e50';
      textB2B.style.color = '#ffffff';
      textB2C.style.color = '#94a3b8';

      b2cContent.classList.add('hidden');
      b2bContent.classList.remove('hidden');
    } else {
      toggleBg.style.left = '4px';
      toggleBg.style.background = '#d8e0e9';
      textB2C.style.color = '#1e293b';
      textB2B.style.color = '#94a3b8';

      b2bContent.classList.add('hidden');
      b2cContent.classList.remove('hidden');
    }
  });
}

// ============================================================
// SHARED: date/time picker helpers (used for both b2c and b2b,
// each with its own prefix so they don't interfere)
// ============================================================
function setupCalendar(prefix, category) {
  new Litepicker({
    element: $(`${prefix}-datepicker`),
    format: 'YYYY-MM-DD',
    minDate: new Date(),
    setup: (picker) => {
      picker.on('selected', () => {
        state[category].date = $(`${prefix}-datepicker`).value;
        state[category].time = null;
        const warn = $(`${prefix}-date-warning`);
        if (warn) warn.classList.add('hidden');
        loadAvailabilityAndRenderSlots(prefix, category);
      });
    },
  });
}

async function loadAvailabilityAndRenderSlots(prefix, category) {
  const loading = $(`${prefix}-slots-loading`);
  const date = state[category].date;
  state[category].blockedTimes = [];

  if (!date) {
    renderTimeSlots(prefix, category);
    return;
  }

  if (loading) loading.classList.remove('hidden');

  try {
    const res = await fetch(`${API_BASE}/api/availability?date=${encodeURIComponent(date)}`);
    if (res.ok) {
      const data = await res.json();
      state[category].blockedTimes = data.blocked || [];
    }
  } catch (err) {
    console.error('Could not load availability', err);
  } finally {
    if (loading) loading.classList.add('hidden');
    renderTimeSlots(prefix, category);
  }
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function renderTimeSlots(prefix, category) {
  const container = $(`${prefix}-time-slots`);
  const display = $(`${prefix}-selected-time-display`);
  if (!container) return;

  container.innerHTML = '';
  const date = state[category].date;
  if (!date) return;

  const now = new Date();
  const isToday = date === formatDate(now);
  const { workStartHour, workEndHour } = SERVICES;

  for (let h = workStartHour; h <= workEndHour; h++) {
    const time = `${h.toString().padStart(2, '0')}:00`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slot-btn';
    btn.textContent = time;

    const isPast = isToday && h <= now.getHours();
    const isBlocked = state[category].blockedTimes.includes(time);

    if (isPast || isBlocked) btn.disabled = true;
    if (state[category].time === time) btn.classList.add('slot-btn-selected');

    btn.onclick = () => {
      state[category].time = time;
      if (display) display.textContent = `Selected: ${time}`;
      renderTimeSlots(prefix, category);
      if (category === 'individual') updateIndividualPayButtonState();
      else updateBusinessButtonState();
    };

    container.appendChild(btn);
  }
}

function toggleCalendarBlock(prefix, service) {
  const block = $(`${prefix === 'ind' ? 'individual' : 'business'}-calendar-block`);
  if (!block) return;
  const needsCalendar = service && service.blockAfterHours !== null;
  block.classList.toggle('hidden', !needsCalendar);
}

// ============================================================
// INDIVIDUAL (B2C) PANEL
// ============================================================
function setupIndividualPanel() {
  setupCalendar('ind', 'individual');

  const select = $('individual-select');
  select.addEventListener('change', () => {
    const service = SERVICES.individual.find((s) => s.id === select.value) || null;
    state.individual.serviceId = select.value;
    state.individual.service = service;
    state.individual.date = null;
    state.individual.time = null;
    $('ind-datepicker').value = '';
    $('ind-selected-time-display').textContent = '';

    toggleCalendarBlock('ind', service);
    renderIndividualLocationField(service);
    renderIndividualExtraFields(service);
    recomputeIndividualPrice();
    updateIndividualPayButtonState();
  });

  const giftCheckbox = $('gift-certificate');
  if (giftCheckbox) giftCheckbox.addEventListener('change', updateIndividualPayButtonState);

  const payBtn = $('individual-pay-button');
  payBtn.addEventListener('click', onIndividualPayClick);
}

function renderIndividualLocationField(service) {
  const group = $('individual-location-group');
  const label = $('individual-location-label');
  const input = group.querySelector('input[name="location"]');

  if (!service || service.locationField === 'none') {
    group.classList.add('hidden');
    input.required = false;
    return;
  }

  group.classList.remove('hidden');
  input.required = true;

  if (service.locationField === 'googlemeet') {
    label.textContent = 'Google Meet Email / Contact for the Call *';
    input.placeholder = 'e.g. your Google account email';
  } else {
    label.textContent = 'Location / Address of the Shoot *';
    input.placeholder = '';
  }
}

function renderIndividualExtraFields(service) {
  const container = $('individual-extra-fields');
  container.innerHTML = '';

  if (!service || !service.extraFields) return;

  service.extraFields.forEach((field) => {
    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.textContent = field.label + (field.required ? ' *' : '');
    group.appendChild(label);

    let input;
    if (field.type === 'service-select') {
      input = document.createElement('select');
      input.className = 'form-select';
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '-- Not selected --';
      input.appendChild(emptyOpt);

      SERVICES.individual
        .filter((s) => s.id !== service.id && s.price != null)
        .forEach((s) => {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = `${s.name} — ${formatNumber(s.price)} DKK`;
          input.appendChild(opt);
        });
    } else {
      input = document.createElement('input');
      input.className = 'form-input';
      input.type = field.type === 'number' ? 'number' : 'text';
      if (field.type === 'number') input.min = field.min || 1;
    }

    input.dataset.fieldKey = field.key;
    input.required = !!field.required;
    input.addEventListener('input', () => {
      recomputeIndividualPrice();
      updateIndividualPayButtonState();
    });
    input.addEventListener('change', () => {
      recomputeIndividualPrice();
      updateIndividualPayButtonState();
    });

    group.appendChild(input);
    container.appendChild(group);
  });
}

function getIndividualExtraValues() {
  const container = $('individual-extra-fields');
  const values = {};
  container.querySelectorAll('[data-field-key]').forEach((el) => {
    values[el.dataset.fieldKey] = el.value;
  });
  return values;
}

function recomputeIndividualPrice() {
  const service = state.individual.service;
  let price = 0;

  if (service) {
    if (service.specialFlow === 'giftcert') {
      const extra = getIndividualExtraValues();
      const target = SERVICES.individual.find((s) => s.id === extra.giftForServiceId);
      price = target ? target.price : 0;
    } else if (service.perUnit) {
      const extra = getIndividualExtraValues();
      const qty = parseInt(extra.photoCount, 10);
      price = qty > 0 ? service.price * qty : 0;
    } else {
      price = service.price;
    }
  }

  state.individual.price = price;
  $('individual-price-display').textContent = `Current Price: ${formatNumber(price)} DKK`;
}

function updateIndividualPayButtonState() {
  const btn = $('individual-pay-button');
  const service = state.individual.service;
  if (!service || state.individual.price <= 0) {
    btn.disabled = true;
    return;
  }
  const needsCalendar = service.blockAfterHours !== null;
  if (needsCalendar && (!state.individual.date || !state.individual.time)) {
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
}

function getIndividualContact() {
  const form = $('individual-form');
  const gift = $('gift-certificate').checked;
  let comment = form.comment.value.trim();
  if (gift) comment = `[GIFT PURCHASE] ${comment}`.trim();

  return {
    name: form.name.value.trim(),
    email: form.email.value.trim(),
    phone: form.phone.value.trim(),
    location: form.location.value.trim(),
    comment,
  };
}

async function onIndividualPayClick() {
  const formError = $('individual-form-error');
  formError.classList.add('hidden');

  const service = state.individual.service;
  if (!service) return;

  const needsCalendar = service.blockAfterHours !== null;
  if (needsCalendar && (!state.individual.date || !state.individual.time)) {
    formError.textContent = 'Please select a date and time.';
    formError.classList.remove('hidden');
    return;
  }

  const contact = getIndividualContact();
  if (!contact.name || !contact.email || !contact.phone) {
    formError.textContent = 'Please fill in your name, email and phone.';
    formError.classList.remove('hidden');
    return;
  }
  if (service.locationField !== 'none' && !contact.location) {
    formError.textContent = service.locationField === 'googlemeet'
      ? 'Please enter your Google Meet contact.'
      : 'Please enter the shoot location.';
    formError.classList.remove('hidden');
    return;
  }

  const extra = getIndividualExtraValues();
  if (service.extraFields) {
    for (const f of service.extraFields) {
      if (f.required && !extra[f.key]) {
        formError.textContent = `Please fill in: ${f.label}`;
        formError.classList.remove('hidden');
        return;
      }
    }
  }

  const payBtn = $('individual-pay-button');
  payBtn.disabled = true;
  payBtn.textContent = 'Preparing payment...';

  try {
    const res = await fetch(`${API_BASE}/api/create-payment-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serviceId: service.id,
        date: needsCalendar ? state.individual.date : null,
        time: needsCalendar ? state.individual.time : null,
        customer: contact,
        extra,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'This time slot is no longer available. Please pick another.');
    }

    const { clientSecret, paymentIntentId } = await res.json();
    currentPaymentIntentId = paymentIntentId;

    $('total-price').textContent = `Total: ${formatNumber(state.individual.price)} DKK`;
    openModal();
    await initStripePayment(clientSecret);
  } catch (err) {
    formError.textContent = err.message;
    formError.classList.remove('hidden');
  } finally {
    payBtn.disabled = false;
    payBtn.textContent = 'Pay and Book';
  }
}

// ============================================================
// BUSINESS (B2B) PANEL
// ============================================================
function setupBusinessPanel() {
  setupCalendar('biz', 'business');

  const select = $('business-select');
  select.addEventListener('change', () => {
    const service = SERVICES.business.find((s) => s.id === select.value) || null;
    state.business.serviceId = select.value;
    state.business.service = service;
    state.business.price = service ? service.price : 0;
    state.business.date = null;
    state.business.time = null;
    $('biz-datepicker').value = '';
    $('biz-selected-time-display').textContent = '';

    toggleCalendarBlock('biz', service);
    renderBusinessLocationField(service);

    $('business-price-display').textContent = `Service Price: ${formatNumber(state.business.price)} DKK`;
    updateBusinessButtonState();
  });

  $('business-submit-button').addEventListener('click', onBusinessSubmitClick);
}

function renderBusinessLocationField(service) {
  const group = $('business-location-group');
  const input = group.querySelector('input[name="location"]');
  if (!service || service.locationField === 'none') {
    group.classList.add('hidden');
    input.required = false;
  } else {
    group.classList.remove('hidden');
    input.required = true;
  }
}

function updateBusinessButtonState() {
  const btn = $('business-submit-button');
  const service = state.business.service;
  if (!service) {
    btn.disabled = true;
    return;
  }
  const needsCalendar = service.blockAfterHours !== null;
  if (needsCalendar && (!state.business.date || !state.business.time)) {
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
}

async function onBusinessSubmitClick() {
  const formError = $('business-form-error');
  const formSuccess = $('business-form-success');
  formError.classList.add('hidden');
  formSuccess.classList.add('hidden');

  const service = state.business.service;
  if (!service) return;

  const form = $('business-form');
  const customer = {
    companyName: form.companyName.value.trim(),
    cvr: form.cvr.value.trim(),
    legalAddress: form.legalAddress.value.trim(),
    invoiceEmail: form.invoiceEmail.value.trim(),
    contactName: form.contactName.value.trim(),
    location: form.location.value.trim(),
  };

  if (!customer.companyName || !customer.cvr || !customer.legalAddress || !customer.invoiceEmail || !customer.contactName) {
    formError.textContent = 'Please fill in all required company details.';
    formError.classList.remove('hidden');
    return;
  }
  if (service.locationField !== 'none' && !customer.location) {
    formError.textContent = 'Please enter the shoot location.';
    formError.classList.remove('hidden');
    return;
  }

  const needsCalendar = service.blockAfterHours !== null;
  if (needsCalendar && (!state.business.date || !state.business.time)) {
    formError.textContent = 'Please select a date and time.';
    formError.classList.remove('hidden');
    return;
  }

  const btn = $('business-submit-button');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    const res = await fetch(`${API_BASE}/api/business-booking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serviceId: service.id,
        date: needsCalendar ? state.business.date : null,
        time: needsCalendar ? state.business.time : null,
        customer,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Could not submit the request. Please try again.');
    }

    formSuccess.textContent = 'Your booking request was submitted! A deposit invoice has been sent to your email — please pay it within 24 hours to secure the slot.';
    formSuccess.classList.remove('hidden');
    form.reset();
    state.business.service = null;
    state.business.date = null;
    state.business.time = null;
    $('business-select').value = '';
    $('biz-datepicker').value = '';
    $('biz-selected-time-display').textContent = '';
    $('business-calendar-block').classList.add('hidden');
    $('business-price-display').textContent = 'Service Price: 0 DKK';
  } catch (err) {
    formError.textContent = err.message;
    formError.classList.remove('hidden');
  } finally {
    btn.textContent = 'Request Invoice & Book';
    updateBusinessButtonState();
  }
}

// ============================================================
// COLLAPSIBLE B2B POLICY
// ============================================================
function setupPolicyToggle() {
  const toggle = $('policy-toggle');
  const content = $('policy-content');
  if (!toggle || !content) return;
  toggle.addEventListener('click', () => {
    content.classList.toggle('hidden');
  });
}

// ============================================================
// STRIPE MODAL (individual bookings only)
// ============================================================
function openModal() {
  $('payment-modal')?.classList.remove('hidden');
}
function closeModal() {
  $('payment-modal')?.classList.add('hidden');
}

let elements;
let cardElement;

async function initStripePayment(clientSecret) {
  elements = stripe.elements();
  if (cardElement) cardElement.unmount();
  cardElement = elements.create('card');
  cardElement.mount('#card-element');

  const form = $('payment-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('submit-stripe');
    btn.disabled = true;
    btn.textContent = 'Processing...';

    const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
      payment_method: { card: cardElement },
    });

    if (error) {
      const err = $('card-errors');
      err.textContent = error.message;
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Pay Now';
      return;
    }

    if (paymentIntent && paymentIntent.status === 'succeeded') {
      try {
        await fetch(`${API_BASE}/api/finalize-booking`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentIntentId: currentPaymentIntentId }),
        });
      } catch (err) {
        console.error('Finalize call failed (webhook will still confirm it):', err);
      }

      alert('✅ Payment successful! A confirmation email is on its way to you.');
      location.reload();
    }
  };
}

window.addEventListener('DOMContentLoaded', () => {
  const closeBtn = $('close-modal');
  if (closeBtn) closeBtn.onclick = closeModal;

  const modal = $('payment-modal');
  if (modal) modal.addEventListener('click', closeModal);

  initStaticUI();
  loadServices();
});
