import { Router } from 'express';
import { loadDashboard } from '../lib/dashboard.js';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function createDashboardRouter(cfg) {
  const router = Router();
  router.get('/dashboard', async (req, res) => {
    const month = String(req.query.month || '');
    if (!MONTH_RE.test(month)) return res.status(400).json({ ok: false, error: 'month ต้องเป็น YYYY-MM' });
    try { res.json(await loadDashboard({ cfg, month })); }
    catch (e) { console.error('dashboard:', e.message); res.status(500).json({ ok: false, error: 'โหลดข้อมูลไม่สำเร็จ' }); }
  });
  return router;
}
