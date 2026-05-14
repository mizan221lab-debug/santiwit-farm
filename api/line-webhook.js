// ════════════════════════════════════════════════════════════
//  SantiwitFarm LINE Webhook — Phase 1
//  Supabase: SantiwitP  |  Vercel serverless
// ════════════════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── LINE config: อ่านจาก Supabase (cache ใน module scope) ──
let LINE_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
let LINE_SECRET = process.env.LINE_CHANNEL_SECRET;
let _configLoaded = false;

async function loadConfig() {
  if (_configLoaded) return;
  const { data } = await sb.from('farm_config').select('key,value');
  if (data) {
    for (const row of data) {
      if (row.key === 'LINE_CHANNEL_ACCESS_TOKEN') LINE_TOKEN  = row.value;
      if (row.key === 'LINE_CHANNEL_SECRET')       LINE_SECRET = row.value;
    }
  }
  _configLoaded = true;
}

// ── helpers ──────────────────────────────────────────────────
const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });

async function lineReply(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  });
}

function verifySignature(body, sig) {
  if (!LINE_SECRET) return true;
  const hash = crypto.createHmac('sha256', LINE_SECRET).update(body).digest('base64');
  return hash === sig;
}

// ── section helpers ───────────────────────────────────────────
async function getSections(activeOnly = true) {
  let q = sb.from('farm_sections').select('*').order('created_at');
  if (activeOnly) q = q.eq('is_active', true);
  const { data } = await q;
  return data || [];
}

async function findSection(txt) {
  const sections = await getSections();
  const lower = txt.toLowerCase();
  return sections.find(s =>
    s.name === txt ||
    s.name.toLowerCase().includes(lower) ||
    lower.includes(s.name.toLowerCase())
  );
}

// ── state (multi-step flow) ───────────────────────────────────
async function getState(userId) {
  const { data } = await sb.from('farm_state').select('*').eq('user_id', userId).single();
  return data;
}
async function setState(userId, flow, step, data = {}) {
  await sb.from('farm_state').upsert({ user_id: userId, flow, step, data, updated_at: new Date().toISOString() });
}
async function clearState(userId) {
  await sb.from('farm_state').delete().eq('user_id', userId);
}

// ── report builders ───────────────────────────────────────────
async function buildDayReport(date) {
  const [{ data: sales }, { data: payments }, { data: expenses }, { data: withdrawals }] = await Promise.all([
    sb.from('farm_sales').select('*, farm_sections(name,emoji)').eq('sale_date', date),
    sb.from('farm_payments').select('*').eq('paid_date', date),
    sb.from('farm_expenses').select('*, farm_sections(name,emoji)').eq('expense_date', date),
    sb.from('farm_withdrawals').select('*').eq('withdraw_date', date),
  ]);
  const salesTotal = (sales || []).reduce((a, b) => a + +b.amount, 0);
  const paidTotal  = (payments || []).reduce((a, b) => a + +b.amount, 0);
  const expTotal   = (expenses || []).reduce((a, b) => a + +b.amount, 0);
  const wdTotal    = (withdrawals || []).reduce((a, b) => a + +b.amount, 0);
  let msg = `📊 ยอดวันที่ ${date}\n━━━━━━━━━━━━━━\n`;
  msg += `💰 ขาย ${(sales||[]).length} รายการ: ฿${fmt(salesTotal)}\n`;
  msg += `💵 รับเงิน ${(payments||[]).length} ครั้ง: ฿${fmt(paidTotal)}\n`;
  msg += `💸 ค่าใช้จ่าย ${(expenses||[]).length} รายการ: ฿${fmt(expTotal)}\n`;
  if (wdTotal > 0) msg += `🏧 เบิกเงิน: ฿${fmt(wdTotal)}\n`;
  msg += `━━━━━━━━━━━━━━\n📈 กำไรสุทธิ: ฿${fmt(paidTotal - expTotal - wdTotal)}`;
  const unpaid = (sales || []).filter(s => !s.paid);
  if (unpaid.length) {
    msg += `\n\n📋 ค้างรับ ${unpaid.length} รายการ:\n`;
    msg += unpaid.slice(0, 5).map(s => `• ${s.farm_sections?.emoji||'🌿'}${s.farm_sections?.name||'-'} ${s.customer} ฿${fmt(s.amount)}`).join('\n');
    if (unpaid.length > 5) msg += `\n... อีก ${unpaid.length - 5} รายการ`;
  }
  return msg;
}

async function buildMonthReport() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const yr = now.getFullYear(), mo = String(now.getMonth() + 1).padStart(2, '0');
  const from = `${yr}-${mo}-01`;
  const to   = `${yr}-${mo}-31`;
  const [{ data: sales }, { data: payments }, { data: expenses }, { data: withdrawals }] = await Promise.all([
    sb.from('farm_sales').select('amount,paid').gte('sale_date', from).lte('sale_date', to),
    sb.from('farm_payments').select('amount').gte('paid_date', from).lte('paid_date', to),
    sb.from('farm_expenses').select('amount').gte('expense_date', from).lte('expense_date', to),
    sb.from('farm_withdrawals').select('amount').gte('withdraw_date', from).lte('withdraw_date', to),
  ]);
  const salesTotal = (sales||[]).reduce((a,b) => a + +b.amount, 0);
  const paidTotal  = (payments||[]).reduce((a,b) => a + +b.amount, 0);
  const expTotal   = (expenses||[]).reduce((a,b) => a + +b.amount, 0);
  const wdTotal    = (withdrawals||[]).reduce((a,b) => a + +b.amount, 0);
  return `📅 ยอดเดือน ${yr}-${mo}\n━━━━━━━━━━━━━━\n💰 ขาย: ฿${fmt(salesTotal)}\n💵 รับเงิน: ฿${fmt(paidTotal)}\n💸 ค่าใช้จ่าย: ฿${fmt(expTotal)}\n🏧 เบิกเงิน: ฿${fmt(wdTotal)}\n━━━━━━━━━━━━━━\n📈 กำไรสุทธิ: ฿${fmt(paidTotal - expTotal - wdTotal)}`;
}

// ── section by section report ─────────────────────────────────
async function buildSectionReport(sectionName) {
  const sec = await findSection(sectionName);
  if (!sec) return `❌ ไม่พบส่วน "${sectionName}"\nพิมพ์ "ส่วน" เพื่อดูรายการ`;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const yr = now.getFullYear(), mo = String(now.getMonth() + 1).padStart(2, '0');
  const from = `${yr}-${mo}-01`, to = `${yr}-${mo}-31`;
  const [{ data: sales }, { data: payments }, { data: expenses }] = await Promise.all([
    sb.from('farm_sales').select('amount,paid,customer,sale_date').eq('section_id', sec.id).gte('sale_date', from).lte('sale_date', to),
    sb.from('farm_payments').select('amount').eq('section_id', sec.id).gte('paid_date', from).lte('paid_date', to),
    sb.from('farm_expenses').select('amount,item,expense_date').eq('section_id', sec.id).gte('expense_date', from).lte('expense_date', to),
  ]);
  const salesTotal = (sales||[]).reduce((a,b) => a + +b.amount, 0);
  const paidTotal  = (payments||[]).reduce((a,b) => a + +b.amount, 0);
  const expTotal   = (expenses||[]).reduce((a,b) => a + +b.amount, 0);
  let msg = `${sec.emoji} ${sec.name} — เดือน ${yr}-${mo}\n━━━━━━━━━━━━━━\n`;
  msg += `💰 ขาย: ฿${fmt(salesTotal)}\n💵 รับเงิน: ฿${fmt(paidTotal)}\n💸 ค่าใช้จ่าย: ฿${fmt(expTotal)}\n`;
  msg += `━━━━━━━━━━━━━━\n📈 กำไรสุทธิ: ฿${fmt(paidTotal - expTotal)}`;
  const unpaid = (sales||[]).filter(s => !s.paid);
  if (unpaid.length) msg += `\n📋 ค้างรับ ${unpaid.length} รายการ: ฿${fmt(unpaid.reduce((a,b)=>a+ +b.amount,0))}`;
  return msg;
}

// ══════════════════════════════════════════════════════════════
//  handleText — router หลัก
// ══════════════════════════════════════════════════════════════
async function handleText(txt, userId, rt) {
  const lower = txt.toLowerCase().trim();

  // ── ยกเลิก multi-step ────────────────────────────────────────
  if (/^(ยกเลิก|cancel|ออก)$/.test(lower)) {
    await clearState(userId);
    return lineReply(rt, '❌ ยกเลิกแล้ว พิมพ์คำสั่งใหม่ได้เลย');
  }

  // ── multi-step flow ──────────────────────────────────────────
  const st = await getState(userId);
  if (st) {
    return handleFlow(st, txt, userId, rt);
  }

  // ─── ส่วน (sections) ───────────────────────────────────────
  if (/^ส่วน$/.test(txt)) {
    const sections = await getSections(false);
    const msg = `🌿 ส่วนในแปลง:\n` + sections.map(s =>
      `${s.is_active ? '✅' : '❌'} ${s.emoji} ${s.name}`
    ).join('\n') + `\n\nเพิ่ม: ส่วน+ [ชื่อ] [emoji]\nปิด: ส่วน- [ชื่อ]`;
    return lineReply(rt, msg);
  }

  const addSecRx = txt.match(/^ส่วน\+\s+(.+?)(?:\s+(\S+))?$/);
  if (addSecRx) {
    const name = addSecRx[1].trim(), emoji = addSecRx[2] || '🌿';
    const { error } = await sb.from('farm_sections').insert({ name, emoji });
    if (error?.code === '23505') return lineReply(rt, `⚠️ มีส่วน "${name}" อยู่แล้ว`);
    return lineReply(rt, `✅ เพิ่มส่วน ${emoji} ${name} แล้ว`);
  }

  const delSecRx = txt.match(/^ส่วน-\s+(.+)$/);
  if (delSecRx) {
    const name = delSecRx[1].trim();
    const { data: sec } = await sb.from('farm_sections').select('id').eq('name', name).single();
    if (!sec) return lineReply(rt, `❌ ไม่พบส่วน "${name}"`);
    await sb.from('farm_sections').update({ is_active: false }).eq('id', sec.id);
    return lineReply(rt, `✅ ปิดส่วน "${name}" แล้ว`);
  }

  const openSecRx = txt.match(/^เปิดส่วน\s+(.+)$/);
  if (openSecRx) {
    const name = openSecRx[1].trim();
    const { data: sec } = await sb.from('farm_sections').select('id').eq('name', name).single();
    if (!sec) return lineReply(rt, `❌ ไม่พบส่วน "${name}"`);
    await sb.from('farm_sections').update({ is_active: true }).eq('id', sec.id);
    return lineReply(rt, `✅ เปิดส่วน "${name}" แล้ว`);
  }

  // ─── ขาย [ส่วน] [ลูกค้า] [ยอด] ────────────────────────────
  const saleRx = txt.match(/^ขาย\s+(\S+)\s+(.+?)\s+([\d.]+)$/);
  if (saleRx) {
    const [, secName, customer, amtStr] = saleRx;
    const sec = await findSection(secName);
    if (!sec) return lineReply(rt, `❌ ไม่พบส่วน "${secName}"\nพิมพ์ "ส่วน" เพื่อดูรายการ`);
    const amount = parseFloat(amtStr);
    const { data } = await sb.from('farm_sales').insert({
      section_id: sec.id, customer, amount, sale_date: today()
    }).select().single();
    return lineReply(rt, `✅ บันทึกการขายแล้ว\n${sec.emoji} ${sec.name} — ${customer}\n💰 ฿${fmt(amount)}\n📋 ยังไม่รับเงิน\n🆔 ${data.id.slice(0,8)}`);
  }

  // ─── รับ [ยอด] หรือ รับ [ลูกค้า] [ยอด] ──────────────────
  const recvRx = txt.match(/^รับ\s+(.+?)\s+([\d.]+)$|^รับ\s+([\d.]+)$/);
  if (recvRx) {
    let customer = null, amount;
    if (recvRx[3]) {
      amount = parseFloat(recvRx[3]);
    } else {
      customer = recvRx[1]; amount = parseFloat(recvRx[2]);
    }
    // หารายการค้างของลูกค้า
    if (customer) {
      const { data: unpaid } = await sb.from('farm_sales')
        .select('*, farm_sections(name,emoji)')
        .eq('paid', false)
        .ilike('customer', `%${customer}%`)
        .order('sale_date', { ascending: true });
      if (unpaid?.length) {
        const sale = unpaid[0];
        await sb.from('farm_sales').update({ paid: true }).eq('id', sale.id);
        await sb.from('farm_payments').insert({ sale_id: sale.id, section_id: sale.section_id, amount, paid_date: today() });
        return lineReply(rt, `✅ รับเงิน ${customer} แล้ว\n${sale.farm_sections?.emoji||'🌿'} ${sale.farm_sections?.name||'-'}\n💵 ฿${fmt(amount)}\n📅 ${sale.sale_date}`);
      }
    }
    // รับเงินทั่วไป
    await sb.from('farm_payments').insert({ amount, paid_date: today(), note: customer || null });
    return lineReply(rt, `✅ รับเงิน ฿${fmt(amount)} แล้ว${customer ? ` (${customer})` : ''}`);
  }

  // ─── ค่า [รายการ] [ยอด] [ส่วน?] ─────────────────────────
  const expRx = txt.match(/^ค่า\s+(.+?)\s+([\d.]+)(?:\s+(\S+))?$/);
  if (expRx) {
    const [, item, amtStr, secName] = expRx;
    const amount = parseFloat(amtStr);
    let section_id = null, secLabel = 'ทั่วไป';
    if (secName) {
      const sec = await findSection(secName);
      if (sec) { section_id = sec.id; secLabel = `${sec.emoji}${sec.name}`; }
    }
    await sb.from('farm_expenses').insert({ item, amount, section_id, expense_date: today() });
    return lineReply(rt, `✅ บันทึกค่าใช้จ่ายแล้ว\n📝 ${item}\n💸 ฿${fmt(amount)}\n🌿 ${secLabel}`);
  }

  // ─── เบิก [ชื่อ] [ยอด] ───────────────────────────────────
  const wdRx = txt.match(/^เบิก\s+(.+?)\s+([\d.]+)$/);
  if (wdRx) {
    const [, name, amtStr] = wdRx;
    const amount = parseFloat(amtStr);
    const { data: sh } = await sb.from('farm_shareholders').select('id,name').ilike('name', `%${name}%`).single();
    await sb.from('farm_withdrawals').insert({
      shareholder_id: sh?.id || null,
      shareholder_name: sh?.name || name,
      amount,
      withdraw_date: today()
    });
    return lineReply(rt, `✅ เบิกเงิน ${sh?.name || name} ฿${fmt(amount)} แล้ว`);
  }

  // ─── ยอดวันนี้ ────────────────────────────────────────────
  if (/^ยอดวันนี้$/.test(txt)) {
    return lineReply(rt, await buildDayReport(today()));
  }
  const dayRx = txt.match(/^รายงาน\s+(\d{4}-\d{2}-\d{2})$/);
  if (dayRx) return lineReply(rt, await buildDayReport(dayRx[1]));

  // ─── ยอดเดือน ─────────────────────────────────────────────
  if (/^ยอดเดือน$/.test(txt)) {
    return lineReply(rt, await buildMonthReport());
  }

  // ─── ยอด [ส่วน] ───────────────────────────────────────────
  const secRepRx = txt.match(/^ยอด\s+(.+)$/);
  if (secRepRx) {
    return lineReply(rt, await buildSectionReport(secRepRx[1]));
  }

  // ─── ยอดค้าง ──────────────────────────────────────────────
  if (/^ยอดค้าง$/.test(txt)) {
    const { data: unpaid } = await sb.from('farm_sales')
      .select('*, farm_sections(name,emoji)')
      .eq('paid', false)
      .order('sale_date', { ascending: true });
    if (!unpaid?.length) return lineReply(rt, '✅ ไม่มียอดค้างชำระ');
    const total = unpaid.reduce((a, b) => a + +b.amount, 0);
    let msg = `📋 ยอดค้าง ${unpaid.length} รายการ\n💰 รวม ฿${fmt(total)}\n━━━━━━━━━━━━━━\n`;
    msg += unpaid.slice(0, 10).map(s =>
      `• ${s.farm_sections?.emoji||'🌿'}${s.farm_sections?.name||'-'} ${s.customer} ฿${fmt(s.amount)} (${s.sale_date})`
    ).join('\n');
    if (unpaid.length > 10) msg += `\n... อีก ${unpaid.length - 10} รายการ`;
    return lineReply(rt, msg);
  }

  // ─── หุ้น ─────────────────────────────────────────────────
  if (/^หุ้น$/.test(txt)) {
    const { data: shs } = await sb.from('farm_shareholders').select('*').order('share_percent', { ascending: false });
    if (!shs?.length) return lineReply(rt, '👥 ยังไม่มีผู้ถือหุ้น\nเพิ่ม: หุ้น+ [ชื่อ] [%] [เงินลงทุน]');
    const total = shs.reduce((a, b) => a + +b.share_percent, 0);
    let msg = `👥 ผู้ถือหุ้น SantiwitFarm\n━━━━━━━━━━━━━━\n`;
    msg += shs.map(s => `• ${s.name}: ${s.share_percent}% (ลงทุน ฿${fmt(s.invested_amount)})`).join('\n');
    msg += `\n━━━━━━━━━━━━━━\nรวม: ${total}%`;
    return lineReply(rt, msg);
  }

  const addShRx = txt.match(/^หุ้น\+\s+(.+?)\s+([\d.]+)(?:\s+([\d.]+))?$/);
  if (addShRx) {
    const [, name, pct, inv] = addShRx;
    const { error } = await sb.from('farm_shareholders').insert({
      name, share_percent: parseFloat(pct), invested_amount: parseFloat(inv || '0')
    });
    if (error?.code === '23505') return lineReply(rt, `⚠️ มีผู้ถือหุ้น "${name}" อยู่แล้ว`);
    return lineReply(rt, `✅ เพิ่มผู้ถือหุ้น ${name} ${pct}% แล้ว`);
  }

  const adjShRx = txt.match(/^ปรับหุ้น\s+(.+?)\s+([\d.]+)$/);
  if (adjShRx) {
    const [, name, pct] = adjShRx;
    const { data: sh } = await sb.from('farm_shareholders').select('id').ilike('name', `%${name}%`).single();
    if (!sh) return lineReply(rt, `❌ ไม่พบผู้ถือหุ้น "${name}"`);
    await sb.from('farm_shareholders').update({ share_percent: parseFloat(pct) }).eq('id', sh.id);
    return lineReply(rt, `✅ ปรับหุ้น ${name} เป็น ${pct}% แล้ว`);
  }

  // ─── ปันผล ────────────────────────────────────────────────
  const divRx = txt.match(/^ปันผล\s+(\d{4})\s+([\d.]+)\s+([\d.]+)$/);
  if (divRx) {
    const [, yearStr, profitStr, divStr] = divRx;
    const year = parseInt(yearStr), total_profit = parseFloat(profitStr), dividend_amount = parseFloat(divStr);
    const { data: div, error } = await sb.from('farm_dividends').insert({ year, total_profit, dividend_amount }).select().single();
    if (error?.code === '23505') return lineReply(rt, `⚠️ มีปันผลปี ${year} แล้ว`);
    const { data: shs } = await sb.from('farm_shareholders').select('*');
    if (shs?.length) {
      const rows = shs.map(s => ({
        dividend_id: div.id,
        shareholder_id: s.id,
        shareholder_name: s.name,
        share_percent: s.share_percent,
        amount: Math.round(dividend_amount * s.share_percent / 100 * 100) / 100
      }));
      await sb.from('farm_dividend_payments').insert(rows);
    }
    const { data: shs2 } = await sb.from('farm_shareholders').select('*');
    let msg = `✅ บันทึกปันผลปี ${year}\n💰 กำไร ฿${fmt(total_profit)}\n🎁 ปันผล ฿${fmt(dividend_amount)}\n━━━━━━━━━━━━━━\n`;
    msg += (shs2 || []).map(s => `• ${s.name}: ฿${fmt(Math.round(dividend_amount * +s.share_percent / 100 * 100)/100)}`).join('\n');
    return lineReply(rt, msg);
  }

  const divViewRx = txt.match(/^ปันผล\s+(\d{4})$/);
  if (divViewRx) {
    const year = parseInt(divViewRx[1]);
    const { data: div } = await sb.from('farm_dividends').select('*').eq('year', year).single();
    if (!div) return lineReply(rt, `❌ ไม่พบปันผลปี ${year}`);
    const { data: dps } = await sb.from('farm_dividend_payments').select('*').eq('dividend_id', div.id);
    let msg = `🎁 ปันผลปี ${year}\n💰 กำไร ฿${fmt(div.total_profit)}\n🎁 ปันผล ฿${fmt(div.dividend_amount)}\n━━━━━━━━━━━━━━\n`;
    msg += (dps || []).map(d => `${d.paid ? '✅' : '⏳'} ${d.shareholder_name}: ฿${fmt(d.amount)}`).join('\n');
    return lineReply(rt, msg);
  }

  const payDivRx = txt.match(/^จ่ายปันผล\s+(.+?)\s+(\d{4})$|^จ่ายปันผล\s+(.+)$/);
  if (payDivRx) {
    const name = payDivRx[1] || payDivRx[3];
    const { data: dp } = await sb.from('farm_dividend_payments')
      .select('*, farm_dividends(year)')
      .ilike('shareholder_name', `%${name}%`)
      .eq('paid', false)
      .order('created_at', { ascending: true })
      .limit(1)
      .single();
    if (!dp) return lineReply(rt, `❌ ไม่พบปันผลค้างของ "${name}"`);
    await sb.from('farm_dividend_payments').update({ paid: true, paid_date: today() }).eq('id', dp.id);
    return lineReply(rt, `✅ จ่ายปันผลปี ${dp.farm_dividends?.year} ให้ ${dp.shareholder_name}\n💰 ฿${fmt(dp.amount)}`);
  }

  // ─── ลบ ───────────────────────────────────────────────────
  const delRx = txt.match(/^ลบ(ขาย|ค่า|เบิก)\s+(\S+)$/);
  if (delRx) {
    const [, type, idPrefix] = delRx;
    const tableMap = { ขาย: 'farm_sales', ค่า: 'farm_expenses', เบิก: 'farm_withdrawals' };
    const table = tableMap[type];
    const { data: rows } = await sb.from(table).select('id').ilike('id', `${idPrefix}%`).limit(1);
    if (!rows?.length) return lineReply(rt, `❌ ไม่พบรายการ #${idPrefix}`);
    await sb.from(table).delete().eq('id', rows[0].id);
    return lineReply(rt, `🗑️ ลบรายการ ${type} #${idPrefix.slice(0,8)} แล้ว`);
  }

  // ─── guided flows ──────────────────────────────────────────
  if (txt === 'เพิ่มส่วน') {
    await setState(userId, 'add_section', 1);
    return lineReply(rt, '🌿 เพิ่มส่วนใหม่\nพิมพ์ชื่อส่วน:');
  }
  if (txt === 'เพิ่มหุ้น') {
    await setState(userId, 'add_shareholder', 1);
    return lineReply(rt, '👥 เพิ่มผู้ถือหุ้น\nพิมพ์ชื่อผู้ถือหุ้น:');
  }

  // ─── help ──────────────────────────────────────────────────
  return lineReply(rt,
    (txt !== 'help' && txt !== 'คำสั่ง' ? `❓ ไม่เข้าใจ "${txt}"\n` : '') +
    `🌾 SantiwitFarm — คำสั่งทั้งหมด\n━━━━━━━━━━━━━━\n` +
    `📦 บันทึก:\n• ขาย [ส่วน] [ลูกค้า] [ยอด]\n• รับ [ยอด] หรือ รับ [ลูกค้า] [ยอด]\n• ค่า [รายการ] [ยอด] [ส่วน?]\n• เบิก [ชื่อ] [ยอด]\n\n` +
    `🌿 ส่วนแปลง:\n• ส่วน — ดูรายการ\n• ส่วน+ [ชื่อ] [emoji] — เพิ่ม\n• ส่วน- [ชื่อ] — ปิด\n• เปิดส่วน [ชื่อ] — เปิดใหม่\n\n` +
    `👥 หุ้น/การเงิน:\n• หุ้น | หุ้น+ [ชื่อ] [%] [เงิน]\n• ปรับหุ้น [ชื่อ] [%ใหม่]\n• ปันผล [ปี] [กำไร] [ยอด]\n• จ่ายปันผล [ชื่อ]\n\n` +
    `📊 รายงาน:\n• ยอดวันนี้ | ยอดเดือน | ยอดค้าง\n• ยอด [ส่วน] — แยกตามส่วน\n• รายงาน YYYY-MM-DD\n\n` +
    `✏️ แก้ไข:\n• ลบขาย/ลบค่า/ลบเบิก [id]\n\n` +
    `💬 เพิ่มส่วน | เพิ่มหุ้น (guided)`
  );
}

// ── guided flow handler ───────────────────────────────────────
async function handleFlow(st, txt, userId, rt) {
  const { flow, step } = st;

  if (flow === 'add_section') {
    if (step === 1) {
      await setState(userId, 'add_section', 2, { name: txt });
      return lineReply(rt, `ชื่อส่วน: ${txt}\nพิมพ์ emoji (เช่น 🌱) หรือ "-" เพื่อใช้ค่าเริ่มต้น:`);
    }
    if (step === 2) {
      const { name } = st.data;
      const emoji = txt === '-' ? '🌿' : txt;
      await sb.from('farm_sections').insert({ name, emoji });
      await clearState(userId);
      return lineReply(rt, `✅ เพิ่มส่วน ${emoji} ${name} แล้ว`);
    }
  }

  if (flow === 'add_shareholder') {
    if (step === 1) {
      await setState(userId, 'add_shareholder', 2, { name: txt });
      return lineReply(rt, `ชื่อ: ${txt}\nพิมพ์สัดส่วนหุ้น (%):`);
    }
    if (step === 2) {
      await setState(userId, 'add_shareholder', 3, { ...st.data, pct: txt });
      return lineReply(rt, `หุ้น: ${txt}%\nพิมพ์เงินลงทุน (฿) หรือ "0":`);
    }
    if (step === 3) {
      const { name, pct } = st.data;
      await sb.from('farm_shareholders').insert({
        name, share_percent: parseFloat(pct), invested_amount: parseFloat(txt)
      });
      await clearState(userId);
      return lineReply(rt, `✅ เพิ่มผู้ถือหุ้น ${name} ${pct}% ฿${fmt(txt)} แล้ว`);
    }
  }

  await clearState(userId);
  return handleText(txt, userId, rt);
}

// ══════════════════════════════════════════════════════════════
//  Vercel handler
// ══════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  await loadConfig();
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'SantiwitFarm LINE Webhook v1' });
  }
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['x-line-signature'];
  const rawBody = JSON.stringify(req.body);
  if (!verifySignature(rawBody, sig)) return res.status(401).end('Invalid signature');

  const events = req.body?.events || [];
  for (const ev of events) {
    const rt = ev.replyToken;
    const userId = ev.source?.userId;
    if (ev.type === 'message' && ev.message?.type === 'text') {
      try {
        await handleText(ev.message.text.trim(), userId, rt);
      } catch (e) {
        console.error(e);
        try { await lineReply(rt, `❌ เกิดข้อผิดพลาด: ${e.message?.slice(0, 80)}`); } catch {}
      }
    }
  }

  return res.status(200).json({ ok: true });
}
