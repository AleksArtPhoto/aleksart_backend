// ============================================================
// SINGLE SOURCE OF TRUTH for every service: price, whether it
// needs the calendar, how many buffer hours it blocks, which
// extra fields it needs, and which flow it triggers after payment.
//
// blockAfterHours:
//   number  -> that many hourly slots are blocked AFTER the booked hour
//   'fullday' -> every remaining hour of that day is blocked
//   null    -> service has no calendar/time at all
//
// locationField: 'address' | 'googlemeet' | 'none'
// specialFlow:   null | 'materials' | 'giftcert'
//   'materials' -> after payment, email asks client to send files to
//                  aleksartphoto.dk@gmail.com
//   'giftcert'  -> after payment, confirmation + "certificate coming soon"
//                  email to client, notification with entered data to owner
// ============================================================

const MATERIALS_EMAIL = 'aleksartphoto.dk@gmail.com';

const INDIVIDUAL_SERVICES = [
  { id: 'mini', name: 'Mini Session', price: 2500, blockAfterHours: 2, locationField: 'address', specialFlow: null },
  { id: 'standard', name: 'Standard Session', price: 4500, blockAfterHours: 2, locationField: 'address', specialFlow: null },
  { id: 'signature', name: 'Signature Session', price: 6500, blockAfterHours: 3, locationField: 'address', specialFlow: null },
  { id: 'private', name: 'Private Event', price: 5500, blockAfterHours: 4, locationField: 'address', specialFlow: null },
  { id: 'wedding', name: 'Wedding Essentials', price: 12500, blockAfterHours: 'fullday', locationField: 'address', specialFlow: null },
  { id: 'fullday', name: 'Full Day Story', price: 22000, blockAfterHours: 'fullday', locationField: 'address', specialFlow: null },
  { id: 'reels', name: 'Lifestyle Reels', price: 3500, blockAfterHours: 3, locationField: 'address', specialFlow: null },
  { id: 'cinematic', name: 'Cinematic Love Story', price: 6000, blockAfterHours: 3, locationField: 'address', specialFlow: null },
  { id: 'family', name: 'Family Documentary', price: 8500, blockAfterHours: 6, locationField: 'address', specialFlow: null },
  { id: 'filmlook', name: 'Digital Film Look', price: 3500, blockAfterHours: 2, locationField: 'address', specialFlow: null },

  { id: 'proedit', name: 'Pro Edit (Your Photos)', price: 1500, blockAfterHours: null, locationField: 'none', specialFlow: 'materials' },

  {
    id: 'fineart', name: 'Fine Art Retouch', price: 450, blockAfterHours: null, locationField: 'none',
    specialFlow: 'materials', perUnit: true, unitLabel: 'Number of photos',
    extraFields: [{ key: 'photoCount', label: 'Number of photos', type: 'number', min: 1, required: true }],
  },

  { id: 'restoration', name: 'Photo Restoration', price: 600, blockAfterHours: null, locationField: 'none', specialFlow: 'materials' },

  { id: 'workshop', name: 'Camera Photo Workshop', price: 2500, blockAfterHours: 3, locationField: 'address', specialFlow: null },

  {
    id: 'review', name: 'Portfolio Review', price: 1200, blockAfterHours: 2, locationField: 'googlemeet', specialFlow: null,
  },
];

const BUSINESS_SERVICES = [
  { id: 'ecom_mini', name: 'E-commerce Pack Mini', price: 3000, blockAfterHours: 2, locationField: 'address' },
  { id: 'ecom_pack', name: 'E-commerce Pack', price: 5000, blockAfterHours: 2, locationField: 'address' },
  { id: 'comm_signature', name: 'Commercial Signature Session', price: 6500, blockAfterHours: 3, locationField: 'address' },
  { id: 'premium_exp', name: 'Premium Experience', price: 9500, blockAfterHours: 4, locationField: 'address' },
  { id: 'prod_basic', name: 'Product Basic', price: 2800, blockAfterHours: null, locationField: 'none' },
  { id: 'prod_brand', name: 'Product Branding', price: 5500, blockAfterHours: null, locationField: 'none' },
  { id: 'prod_camp', name: 'Product Campaign', price: 9500, blockAfterHours: null, locationField: 'none' },
  { id: 'interior_ess', name: 'Interior Essential', price: 3500, blockAfterHours: 2, locationField: 'address' },
  { id: 'interior_std', name: 'Interior Standard', price: 5500, blockAfterHours: 3, locationField: 'address' },
  { id: 'interior_prem', name: 'Interior Premium', price: 8500, blockAfterHours: 5, locationField: 'address' },
  { id: 'social_clip', name: 'Social Clip', price: 3500, blockAfterHours: 2, locationField: 'address' },
  { id: 'social_plus', name: 'Social Plus', price: 5500, blockAfterHours: 3, locationField: 'address' },
  { id: 'brand_intro', name: 'Brand Intro Video', price: 7500, blockAfterHours: 4, locationField: 'address' },
  { id: 'biz_promo', name: 'Business Promo', price: 9500, blockAfterHours: 4, locationField: 'address' },
  { id: 'comm_pkg', name: 'Commercial Package', price: 15000, blockAfterHours: 7, locationField: 'address' },
  { id: 'property_vid', name: 'Property Video', price: 4500, blockAfterHours: 2, locationField: 'address' },
  { id: 'logo_anim', name: 'Logo Animation', price: 1500, blockAfterHours: null, locationField: 'none' },
  { id: 'motion_basic', name: 'Motion Graphics Basic', price: 1800, blockAfterHours: null, locationField: 'none' },
  { id: 'motion_ctx', name: 'Context Motion Graphics', price: 2500, blockAfterHours: null, locationField: 'none' },
  { id: 'motion_upgrade', name: 'Social Motion Upgrade', price: 3500, blockAfterHours: null, locationField: 'none' },
];

const BUSINESS_DEPOSIT_PERCENT = 30; // % of total paid upfront via invoice
const BUSINESS_HOLD_HOURS = 48; // pending business bookings auto-expire after this

const WORK_START_HOUR = 9;
const WORK_END_HOUR = 20;

function findService(category, id) {
  const list = category === 'business' ? BUSINESS_SERVICES : INDIVIDUAL_SERVICES;
  return list.find(s => s.id === id) || null;
}

// Returns the list of "HH:00" slots a booking blocks, given a start hour
// and a service's blockAfterHours rule.
function computeBlockedSlots(startHour, blockAfterHours) {
  if (blockAfterHours === null || blockAfterHours === undefined) return [];
  let endHour;
  if (blockAfterHours === 'fullday') {
    endHour = WORK_END_HOUR;
  } else {
    endHour = Math.min(startHour + blockAfterHours, WORK_END_HOUR);
  }
  const slots = [];
  for (let h = startHour; h <= endHour; h++) {
    slots.push(`${h.toString().padStart(2, '0')}:00`);
  }
  return slots;
}

module.exports = {
  INDIVIDUAL_SERVICES,
  BUSINESS_SERVICES,
  BUSINESS_DEPOSIT_PERCENT,
  BUSINESS_HOLD_HOURS,
  WORK_START_HOUR,
  WORK_END_HOUR,
  MATERIALS_EMAIL,
  findService,
  computeBlockedSlots,
};
