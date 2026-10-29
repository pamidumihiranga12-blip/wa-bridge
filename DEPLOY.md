# WhatsApp Baileys Bridge — Railway.app Deploy Guide

## 📋 Prerequisites
- [Railway.app](https://railway.app) account (Free — GitHub ෙකෙන් sign up)
- [GitHub](https://github.com) account

---

## 🚀 Deploy Steps (10 minutes)

### Step 1: GitHub Repository Create කරන්න

```bash
# baileys-bridge/ folder ෙකන්
cd baileys-bridge
git init
git add .
git commit -m "Initial commit"
```

GitHub ෙකේ new repository create → push:
```bash
git remote add origin https://github.com/YOUR_USERNAME/wa-bridge.git
git push -u origin main
```

---

### Step 2: Railway.app Deploy

1. **railway.app** → Login with GitHub
2. **"New Project"** → **"Deploy from GitHub repo"**
3. ඔබේ `wa-bridge` repo select කරන්න
4. Railway auto-deploy start වෙයි

---

### Step 3: Environment Variables Set කරන්න

Railway dashboard → ඔබේ project → **Variables** tab:

```
PHP_BACKEND_URL  = https://codflow.lk           (CodFlow production domain)
BRIDGE_SECRET    = smartzone_baileys_secret_2026 (Bridge secret string)
MERCHANT_ID      = 1                             (merchant ID)
```

> ⚠️ **BRIDGE_SECRET** same value PHP ෙකේ `config.php` ෙකේ `BRIDGE_SECRET` ෙකෙවත් දාන්න!

---

### Step 4: Railway URL ගන්න

Railway deploy වෙලා → **Settings** → **Domains** → URL copy:
```
https://wa-bridge-production-xxxx.railway.app
```

---

### Step 5: PHP Config Update

`src/config/config.php` edit:
```php
define('BRIDGE_URL', 'https://wa-bridge-production-xxxx.railway.app');
define('BRIDGE_SECRET', 'abc123randomsecret456xyz789');  // Same as Railway
```

---

### Step 6: QR Code Scan

Dashboard → WhatsApp Connect → **"QR Generate"** click

Railway ෙකේ **Logs** tab ෙකේ terminal QR code දිස්වෙයි:
- ඔබේ WhatsApp → Linked Devices → Link a Device → Scan

**Done! ✅** WhatsApp connected!

---

## 🔁 Flow Diagram

```
Customer msg
    ↓
Baileys (Railway.app)
    ↓ POST /bridge_receive.php
PHP cPanel hosting
    ↓ Gemini AI
Reply JSON { "reply": "..." }
    ↓
Baileys sends to customer ✅
```

---

## 💰 Cost Breakdown

| Service | Free Tier | Limits |
|---------|-----------|--------|
| Railway.app | ✅ $5 credit/month | ~500 hours |
| Baileys (WhatsApp) | ✅ FREE | Unlimited |
| Gemini AI | ✅ FREE | 1500 req/day |
| PHP Hosting | ✅ ඔබේ existing | - |
| **TOTAL** | **$0** | - |

> **Railway free tier:** $5/month credit. 512MB RAM instance = ~$2-3/month → **Free!** ✅

---

## 🛠️ Troubleshooting

**QR code නොදිස්වෙන්නේ:**
- Railway Logs check කරන්න
- `BRIDGE_SECRET` PHP + Railway match කරනවද?

**Messages ලැබෙන්නේ නෑ:**
- Railway URL correct ද? (`BRIDGE_URL` in config.php)
- PHP hosting ෙකේ `bridge_receive.php` accessible ද?

**Session expire:**
- Railway volume mount confirm කරන්න (`/app/sessions`)
- Session files delete නොවිය යුතුයි

