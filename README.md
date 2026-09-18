# Lilsheep-TikTok — แดชบอร์ด TikTok ของ Lilsheep (standalone)

เว็บแดชบอร์ดแยกสำหรับลูกค้า **Lilsheep** (Report Pilot client `M039`, TikTok Shop `THLCJ8WLTT`) โมเดลตาม
[`anc-tiktok`](https://github.com/tidjaruadai-commits/anc-tiktok) แต่เป็นร้านเดียว/บัญชีเดียว และ
**ไม่ผูกกับเว็บ P/L**. เจ้าของแบรนด์ล็อกอินเข้ามาดูยอดขาย + โฆษณาของร้านตัวเอง.

## มีอะไรในแอปนี้
- **แดชบอร์ด 5 แท็บ** (`/`): ภาพรวม (KPI + ROAS + โดนัทช่องทาง), ร้าน (GMV/ออเดอร์/AOV + LIVE/วิดีโอ/การ์ด),
  โฆษณา (แยกตามประเภทแคมเปญ + ROAS), คลิป (ปก + แคปชั่น + เมตริกรายคลิป), ตั้งค่า (กรอกโทเคน + ปุ่มซิงก์).
- **ดึงข้อมูลผ่าน Report Pilot gateway** (`https://api.tidjaruad.co`, Bearer `rpt_...`) — ไม่ต่อ TikTok เอง.
- **ซิงก์อัตโนมัติ** เดือนนี้ + เดือนก่อน ตอนบูต แล้วทุก 6 ชม.; เก็บรูปปกคลิปถาวรทุก 12 ชม.
- **ล็อกอินบัญชีเดียว** (เจ้าของแบรนด์).

## ความปลอดภัย (สำคัญ)
- ใช้ **Supabase ร่วมกับ Report Pilot** (`cjmdmvpbgmqwguakylci`) ตารางขึ้นต้น `m039_` แต่คนละกุญแจ:
  แอปนี้คุยกับฐานด้วย role **`m039_app`** ที่แตะได้เฉพาะตาราง `m039_*` + bucket `m039-covers` เท่านั้น —
  ไม่ใช่ service key, ไม่เห็นข้อมูลลูกค้ารายอื่น.
- **เบราว์เซอร์ไม่เคยเห็นกุญแจฐานหรือโทเคน** เลย (เซิร์ฟเวอร์เป็นคนคุยกับฐาน; `/env.js` ส่งแค่ `{role}`).
- แอปจะ **ไม่บูต** ถ้าไม่ตั้ง `OWNER_PASSWORD` / `SECRET_STORE_KEY` (ไม่มีค่า default).

## Stack
Node ≥18 (ESM) · Express + cookie-session · Chart.js 4.4.1 (CDN) · Supabase PostgREST/Storage · ไม่มี build step.

## ตั้งค่าครั้งแรก (ครั้งเดียว)
ดู **[`docs/SETUP.md`](docs/SETUP.md)** — รัน migration + สร้าง role `m039_app` + สร้าง JWT + รัน
`npm run containment-check` ให้ขึ้น `CONTAINMENT OK` **ก่อน**ต่อข้อมูลจริง.

## รันในเครื่อง
```bash
npm install
# ต้องตั้ง env ให้ครบก่อน (ดู .env.example) แล้ว:
npm start          # http://localhost:3000
npm test           # 65 tests
```

## Deploy
ดู **[`docs/DEPLOY.md`](docs/DEPLOY.md)** — Vercel (ฟรี, sync วันละครั้งผ่าน Vercel Cron): Import repo นี้จาก
GitHub แล้วตั้ง env ตาม `.env.example`.

## โครงไฟล์
```
server.js                 Express: boot guard, login, /api/*, autosync timers
lib/env.js                config + refuse-to-boot
lib/db.js                 fail-closed Supabase client (m039_app Bearer + anon apikey)
lib/jwt.js                HS256 sign/decode
lib/secret-store.js       เก็บโทเคน rpt_ แบบเข้ารหัสใน m039_secrets
lib/auth.js               login เทียบเวลาคงที่ + rate limiter
connectors/report-pilot.js  ตัวต่อ gateway (clients/shop-metrics/ad-account-metrics)
lib/shop-sync.js          ดึงยอดร้าน → m039_shops / m039_shop_monthly
lib/ads-sync.js           ดึงโฆษณา → m039_ads_monthly / m039_ads_items
lib/gmvmax-sync.js        ดึง GMV Max → m039_gmvmax_monthly
lib/video-sync.js         ดึงเมตริกรายคลิป → m039_video_monthly
lib/affiliate-sync.js     ดึงข้อมูล affiliate → m039_affiliate_monthly / m039_affiliate_creators
lib/cover-archive.js      เก็บรูปปกคลิป → bucket m039-covers
lib/dashboard.js          รวมข้อมูลเป็น DTO ต่อเดือน
routes/tiktok.js          /api/tiktok (connect/status/sync)
routes/dashboard.js       /api/dashboard?month=
webroot/                  index.html (5 แท็บ) + login.html  (NOT "public/" — Vercel reserves that name)
api/index.js              Vercel serverless entry; vercel.json = daily cron
supabase/                 migration + role SQL
scripts/                  mint-m039-jwt, containment-check (ด่านความปลอดภัย)
```
