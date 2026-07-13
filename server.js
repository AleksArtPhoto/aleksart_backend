const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// Разрешаем вашему сайту на GitHub Pages общаться с сервером
app.use(cors({
  origin: 'https://github.io'
}));
app.use(express.json());

// База данных цен на сервере (для сверки)
const servicesPriceList = {
  "mini": 2500, "standard": 4500, "signature": 6500, "private": 5500,
  "wedding": 12500, "fullday": 22000, "reels": 3500, "cinematic": 6000,
  "family": 8500, "filmlook": 3500, "proedit": 1500, "fineart": 450,
  "restoration": 600, "workshop": 2500, "review": 1200,
  "ecom_mini": 3000, "comm_signature": 6500, "premium_exp": 9500,
  "prod_basic": 2800, "prod_brand": 5500, "prod_camp": 9500,
  "interior_ess": 3500, "interior_std": 5500, "interior_prem": 8500,
  "social_clip": 3500, "social_plus": 5500, "brand_intro": 7500,
  "biz_promo": 9500, "comm_pkg": 15000, "property_vid": 4500,
  "logo_anim": 1500, "motion_basic": 1800, "motion_ctx": 2500, "motion_upgrade": 3500
};

// 1. НАСТРОЙКА РОБОТА ОТПРАВКИ ПИСЕМ (GMAIL SMTP)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,       // Ваш Gmail адрес
    pass: process.env.EMAIL_APP_PASS   // Тот самый 16-значный пароль приложения
  }
});

// Эндпоинт инициализации платежа Stripe
app.post('/api/create-payment-intent', async (req, res) => {
  const { name, email, phone, location, comment, serviceId, serviceName, isGiftCertificate, date, startTime } = req.body;

  const price = servicesPriceList[serviceId];
  if (!price) {
    return res.status(400).json({ error: "Invalid service type" });
  }

  try {
    // 2. СОЗДАНИЕ СЕССИИ ПЛАТЕЖА В STRIPE
    const paymentIntent = await stripe.paymentIntents.create({
      amount: price * 100, // Конвертируем DKK в гроши (2500 DKK = 250000)
      currency: 'dkk',
      automatic_payment_methods: { enabled: true },
      metadata: {
        name, email, phone, location, date, startTime,
        serviceId, isGiftCertificate: String(isGiftCertificate), comment
      }
    });

    // 3. ОТПРАВКА СЕКРЕТНОГО ТОКЕНА КЛИЕНТУ НА ФРОНТЕНД
    res.json({ clientSecret: paymentIntent.client_secret });

    // 4. АВТОМАТИЧЕСКАЯ ОТПРАВКА КРАСИВОГО ПИСЬМА-ПОДТВЕРЖДЕНИЯ
    sendBookingEmail(email, {
      name, phone, location, comment, date, startTime, price, serviceName, isGiftCertificate
    });

  } catch (error) {
    console.error("Stripe error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ФУНКЦИЯ СБОРКИ И ОТПРАВКИ HTML-ПИСЬМА
async function sendBookingEmail(clientEmail, data) {
  const giftStatus = data.isGiftCertificate ? "🎁 YES (Gift Certificate)" : "❌ No (Standard Session)";
  
  const htmlContent = `
    <div style="font-family: 'Josefin Sans', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #f1f5f9; border-radius: 8px;">
      <h2 style="color: #1e293b; text-align: center; border-bottom: 2px solid #f1f5f9; padding-bottom: 15px;">📸 Photoshoot Booking Details</h2>
      <p>Hello! A new photo session registration has been initialized.</p>
      
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr style="background-color: #f8fafc;"><td style="padding: 10px; font-weight: bold;">Client Name:</td><td style="padding: 10px;">${data.name}</td></tr>
        <tr><td style="padding: 10px; font-weight: bold;">Email:</td><td style="padding: 10px;">${data.email || clientEmail}</td></tr>
        <tr style="background-color: #f8fafc;"><td style="padding: 10px; font-weight: bold;">Phone:</td><td style="padding: 10px;">${data.phone}</td></tr>
        <tr><td style="padding: 10px; font-weight: bold;">Service:</td><td style="padding: 10px; font-weight: #600;">${data.serviceName || data.serviceId}</td></tr>
        <tr style="background-color: #f8fafc;"><td style="padding: 10px; font-weight: bold;">Date:</td><td style="padding: 10px; color: #1e3a8a;"><b>${data.date}</b></td></tr>
        <tr><td style="padding: 10px; font-weight: bold;">Start Time:</td><td style="padding: 10px;">Starts at ${data.startTime}</td></tr>
        <tr style="background-color: #f8fafc;"><td style="padding: 10px; font-weight: bold;">Location:</td><td style="padding: 10px;">${data.location}</td></tr>
        <tr><td style="padding: 10px; font-weight: bold;">Gift Certificate:</td><td style="padding: 10px;">${giftStatus}</td></tr>
        <tr style="background-color: #f8fafc;"><td style="padding: 10px; font-weight: bold;">Price:</td><td style="padding: 10px; font-size: 18px; color: #0f172a; font-weight: bold;">${data.price} DKK</td></tr>
      </table>
      
      <div style="background-color: #f8fafc; padding: 15px; border-radius: 6px; margin-top: 15px;">
        <h4 style="margin: 0 0 5px 0; color: #475569;">Client's Comment:</h4>
        <p style="margin: 0; font-style: italic; color: #334155;">"${data.comment || 'No comments left.'}"</p>
      </div>
      
      <p style="font-size: 12px; color: #94a3b8; text-align: center; margin-top: 30px;">Automated system by Aleks Art Photo. Payment processing secured via Stripe.</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: [process.env.EMAIL_USER, clientEmail], // Отправка копии и вам на почту, и клиенту
      subject: `📸 Photoshoot Booking Confirmed — ${data.date}`,
      html: htmlContent
    });
    console.log("Emails sent successfully to manager and client.");
  } catch (err) {
    console.error("Email delivery failed:", err);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
