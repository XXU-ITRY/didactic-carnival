/**
 * ══════════════════════════════════════════════════════════════════
 *  PRPoxy — ربات استخراج کانفیگ از کانال‌های تلگرام
 * ══════════════════════════════════════════════════════════════════
 *
 *  🎯 این فایل روی Cloudflare Workers اجرا می‌شه.
 *  🤖 دو ربات رو همزمان مدیریت می‌کنه:
 *      • تلگرام  (از طریق webhook)
 *      • سروش    (از طریق webhook یا polling)
 *  🎨 UI هر دو ربات دقیقاً یکسانه.
 *
 *  📥 کاربر لینک کانال می‌ده
 *  ⚙️ Worker صفحه رو به HTML می‌خونه و کانفیگ‌ها رو استخراج می‌کنه
 *  📤 مستقیم به همون کاربر برمی‌گردونه (بدون ذخیره)
 *
 *  🔐 فقط ۲ توکن لازمه:
 *      - TELEGRAM_BOT_TOKEN
 *      - SOROUSH_BOT_TOKEN
 *
 *  💾 هیچ کانفیگی ذخیره نمی‌شه.
 *     فقط «لیست URL منابع» برای هر chat در KV نگه‌داری می‌شه.
 * ══════════════════════════════════════════════════════════════════
 */

// ==================================================================
//  🎯 بخش ۱ — الگوهای استخراج (Regex)
// ==================================================================
//  برای افزودن پروتکل جدید، فقط یه آیتم به این آرایه اضافه کن.
//  مثال: 'reality' رو هم اضافه کن اگه بخوای.
// ==================================================================

const CONFIG_REGEX =
  /(?:vmess|vless|trojan|ssr|ss|hysteria2?|hy2|tuic|wireguard|wg|socks5?|socks|http):\/\/[^\s"'<>`]+/gi;

const TG_PROXY_REGEX = /tg:\/\/proxy\?[^\s"'<>`]+/gi;
const TG_SOCKS_REGEX = /https?:\/\/t\.me\/(?:socks|proxy)\?[^\s"'<>`]+/gi;

// پسوندهای فایل که به‌عنوان «دانلود» شناسایی می‌شن
const FILE_LINK_REGEX =
  /https?:\/\/[^\s"'<>`]+\.(?:ovpn|conf|json|txt|yaml|yml|xml|ini|zip|rar|7z|pem|key|crt|mobileconfig)(?:\?[^\s"'<>`]*)?/gi;

// ==================================================================
//  🧰 بخش ۲ — ابزارهای پایه (کمک‌کننده)
// ==================================================================

// HTML رو به متن ساده تبدیل می‌کنه
function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

// آیا این خط خودش یه کانفیگه؟
// (برای جداکردن «متن رمز» از «کانفیگ»)
function isConfigLine(line) {
  return (
    /^(?:vmess|vless|trojan|ssr|ss|hysteria2?|hy2|tuic|wireguard|wg|socks5?|socks|http):\/\//i.test(
      line
    ) ||
    /tg:\/\/proxy\?/i.test(line) ||
    /t\.me\/(?:socks|proxy)\?/i.test(line)
  );
}

// استخراج همه کانفیگ‌ها و فایل‌ها از یک متن
function extractAll(text) {
  const configs = new Set();
  const files = new Set();
  let m;

  // کانفیگ‌ها
  for (const re of [CONFIG_REGEX, TG_PROXY_REGEX, TG_SOCKS_REGEX]) {
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) configs.add(m[0].trim());
  }

  // فایل‌ها
  FILE_LINK_REGEX.lastIndex = 0;
  while ((m = FILE_LINK_REGEX.exec(text)) !== null) files.add(m[0].trim());

  return { configs: [...configs], files: [...files] };
}

// شکستن متن طولانی به قطعات ۴۰۰۰ کاراکتری (سقف تلگرام/سروش)
function chunkText(text, size = 4000) {
  const out = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if ((buf + line + '\n').length > size) {
      if (buf) out.push(buf);
      buf = line.slice(0, size) + '\n';
    } else {
      buf += line + '\n';
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ==================================================================
//  🌐 بخش ۳ — استخراج از صفحه کانال (HTML Scraper)
// ==================================================================

// پارس کردن ساختار t.me/s/<channel>
function parseMessages(html) {
  const chunks = html.split(/tgme_widget_message_wrap/).slice(1);
  const out = [];

  for (const chunk of chunks) {
    const dateMatch = chunk.match(/datetime="([^"]+)"/);
    const postMatch = chunk.match(/data-post="([^"]+)"/);
    const textMatch = chunk.match(
      /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/
    );

    const text = htmlToText(textMatch ? textMatch[1] : '').trim();

    const docNames = [];
    const docRe = /tgme_widget_message_document_title[^>]*>([^<]+)</g;
    let dm;
    while ((dm = docRe.exec(chunk)) !== null) docNames.push(dm[1].trim());

    if (!text && !docNames.length) continue;

    out.push({
      date: dateMatch ? dateMatch[1] : '',
      link: postMatch ? `https://t.me/${postMatch[1]}` : '',
      text,
      docNames,
    });
  }
  return out;
}

// تبدیل URL ورودی به URL قابل‌خواندن t.me/s/
function normalizeChannelUrl(raw) {
  let url = (raw || '').trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  // t.me/xxx  →  t.me/s/xxx
  if (/^https?:\/\/t\.me\//i.test(url) && !/\/s\//.test(url)) {
    const m = url.match(/t\.me\/([^\/\?\s#]+)/i);
    if (m) url = `https://t.me/s/${m[1]}`;
  }
  return url;
}

// استخراج کامل یک منبع
async function scrape(rawUrl) {
  const url = normalizeChannelUrl(rawUrl);

  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9,fa;q=0.8',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const messages = /tgme_widget_message_wrap/.test(html)
    ? parseMessages(html)
    : [{ date: '', link: '', text: htmlToText(html).trim(), docNames: [] }];

  const seen = new Set();
  const entries = [];

  for (const msg of messages) {
    const { configs, files } = extractAll(msg.text);
    const fresh = configs.filter((c) => !seen.has(c));
    fresh.forEach((c) => seen.add(c));

    // «متن رمز» = خطوطی که کانفیگ نیستن
    const caption = msg.text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !isConfigLine(l))
      .join('\n')
      .slice(0, 800);

    if (fresh.length || files.length || msg.docNames.length) {
      entries.push({
        date: msg.date,
        link: msg.link,
        caption,
        configs: fresh,
        files,
        docNames: msg.docNames,
      });
    }
  }

  return { url, entries };
}

// رندر خروجی یک منبع (به‌صورت متن)
function renderOne(result) {
  if (!result.entries.length) return '❌ چیزی پیدا نشد.';

  const lines = [`🌐 ${result.url}`];
  let total = 0;

  for (const e of result.entries) {
    lines.push('━━━━━━━━━━━━━');
    if (e.date) lines.push('📅 ' + e.date.slice(0, 19).replace('T', ' '));
    if (e.link) lines.push('🔗 ' + e.link);
    if (e.caption) lines.push('📝 ' + e.caption);
    for (const c of e.configs) {
      lines.push(c);
      total++;
    }
    for (const f of e.files) lines.push('📎 ' + f);
    for (const d of e.docNames) lines.push('📁 ' + d);
  }

  return `📦 ${total} کانفیگ · ${result.entries.length} پیام\n\n` + lines.join('\n');
}

// رندر خروجی همه منابع (موازی)
async function fetchAll(sources) {
  const results = await Promise.all(
    sources.map(async (url) => {
      try {
        return { ok: true, result: await scrape(url) };
      } catch (e) {
        return { ok: false, url, error: e.message };
      }
    })
  );

  const configs = new Set();
  const files = new Set();
  const blocks = [];
  let failed = 0;

  for (const r of results) {
    if (!r.ok) {
      failed++;
      blocks.push(`❌ ${r.url}\n   ${r.error}`);
      continue;
    }

    const lines = [`🌐 ${r.result.url}`];
    for (const e of r.result.entries) {
      if (e.date) lines.push('📅 ' + e.date.slice(0, 19).replace('T', ' '));
      if (e.caption) lines.push('📝 ' + e.caption);
      for (const c of e.configs) {
        if (!configs.has(c)) {
          configs.add(c);
          lines.push(c);
        }
      }
      for (const f of e.files) {
        if (!files.has(f)) {
          files.add(f);
          lines.push('📎 ' + f);
        }
      }
      for (const d of e.docNames) lines.push('📁 ' + d);
    }
    blocks.push(lines.join('\n'));
  }

  const header = `📦 ${configs.size} کانفیگ یکتا از ${sources.length - failed}/${
    sources.length
  } منبع`;
  return header + '\n\n' + blocks.join('\n\n');
}

// ==================================================================
//  💾 بخش ۴ — ذخیره‌سازی در KV
//  (فقط لیست منابع — هیچ کانفیگی ذخیره نمی‌شه)
// ==================================================================

async function getSources(env, chatId) {
  if (!env.KV) return [];
  const raw = await env.KV.get(`sources:${chatId}`);
  return raw ? JSON.parse(raw) : [];
}
async function setSources(env, chatId, arr) {
  if (!env.KV) return;
  await env.KV.put(`sources:${chatId}`, JSON.stringify(arr));
}

// وضعیت فعلی کاربر (مثلاً منتظر URL)
async function getState(env, chatId) {
  if (!env.KV) return null;
  return await env.KV.get(`state:${chatId}`);
}
async function setState(env, chatId, st) {
  if (!env.KV) return;
  if (st === null) await env.KV.delete(`state:${chatId}`);
  else await env.KV.put(`state:${chatId}`, st);
}

// ==================================================================
//  🌉 بخش ۵ — آداپترهای پلتفرم (تلگرام / سروش)
//  هر دو از ساختار Bot API استفاده می‌کنن — فقط URL فرق داره.
// ==================================================================

async function tgApi(env, method, body) {
  const r = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  return r.json();
}

async function srApi(env, method, body) {
  // آدرس API سروش — اگه متفاوت بود، اینجا رو عوض کن
  const base = (env.SOROUSH_API_BASE || 'https://api.splus.ir').replace(/\/+$/, '');
  const r = await fetch(`${base}/bot${env.SOROUSH_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

// انتخاب API بر اساس پلتفرم
function api(platform, env, method, body) {
  return platform === 'tg' ? tgApi(env, method, body) : srApi(env, method, body);
}

// ارسال پیام (خودکار تکه‌تکه می‌کنه اگه طولانی باشه)
async function send(platform, env, chatId, text, extra = {}) {
  for (const part of chunkText(text)) {
    await api(platform, env, 'sendMessage', {
      chat_id: chatId,
      text: part,
      disable_web_page_preview: true,
      ...extra,
    });
  }
}

// ویرایش پیام (برای منوها)
async function editMenu(platform, env, chatId, messageId, text, kb) {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
  };
  if (kb !== undefined) body.reply_markup = kb;
  return api(platform, env, 'editMessageText', body);
}

// پاسخ سریع به callback (برای رفع loading دکمه)
async function answerCb(platform, env, id, text) {
  return api(platform, env, 'answerCallbackQuery', {
    callback_query_id: id,
    text: text || '',
  });
}

// ==================================================================
//  🎨 بخش ۶ — کیبوردها و منوها
// ==================================================================
//  برای اضافه کردن دکمه جدید، فقط اینجا تغییر بده.
// ==================================================================

// منوی اصلی
function kbMain() {
  return {
    inline_keyboard: [
      [{ text: '➕ افزودن منبع', callback_data: 'add_source' }],
      [{ text: '📥 دریافت فایل', callback_data: 'fetch_menu' }],
      [{ text: '⚙️ تنظیمات', callback_data: 'settings' }],
    ],
  };
}

// دکمهٔ بازگشت
function kbBack(target = 'menu') {
  return { inline_keyboard: [[{ text: '🔙 بازگشت', callback_data: target }]] };
}

// لیست منابع با دکمه‌های عملیات
function kbSources(sources) {
  const rows = [];

  sources.forEach((url, i) => {
    const short = url.replace(/^https?:\/\//, '').slice(0, 28);
    rows.push([
      { text: `📥 ${short}`, callback_data: `fetch:${i}` },
      { text: '🗑', callback_data: `del:${i}` },
    ]);
  });

  // دکمه آخر: دریافت از همه
  if (sources.length > 0) {
    rows.push([{ text: '📥 دریافت از همه منابع', callback_data: 'fetch_all' }]);
  }

  rows.push([{ text: '➕ افزودن منبع', callback_data: 'add_source' }]);
  rows.push([{ text: '🔙 بازگشت', callback_data: 'menu' }]);

  return { inline_keyboard: rows };
}

// ==================================================================
//  🧭 بخش ۷ — منطق منو و callback
// ==================================================================

// نمایش منوی اصلی
async function showMenu(platform, env, chatId, messageId, greeting = false) {
  const text =
    (greeting ? '👋 خوش آمدی به PRPoxy\n\n' : '') +
    '🔧 منوی اصلی:\n' +
    '· افزودن منبع (کانال تلگرام)\n' +
    '· دریافت کانفیگ از یک یا همه منابع\n' +
    '· مدیریت لیست منابع';

  if (messageId) return editMenu(platform, env, chatId, messageId, text, kbMain());
  return send(platform, env, chatId, text, { reply_markup: kbMain() });
}

// نمایش لیست منابع
async function showSources(platform, env, chatId, messageId) {
  const sources = await getSources(env, chatId);

  if (!sources.length) {
    return editMenu(
      platform,
      env,
      chatId,
      messageId,
      '📭 هیچ منبعی ثبت نشده.\n\nاز «➕ افزودن منبع» استفاده کن.',
      kbBack('menu')
    );
  }

  return editMenu(
    platform,
    env,
    chatId,
    messageId,
    `📋 منابع شما (${sources.length}):\n\n` +
      sources.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    kbSources(sources)
  );
}

// پردازش دکمه‌های inline
async function onCallback(platform, env, cq) {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const data = cq.data || '';

  await answerCb(platform, env, cq.id);

  // 🔙 بازگشت به منو
  if (data === 'menu') {
    await setState(env, chatId, null);
    return showMenu(platform, env, chatId, messageId);
  }

  // ➕ افزودن منبع
  if (data === 'add_source') {
    await setState(env, chatId, 'awaiting_source');
    return editMenu(
      platform,
      env,
      chatId,
      messageId,
      '🔗 لینک کانال رو بفرست:\n\n' +
        'مثال:\nhttps://t.me/s/v2ray_configs\n\n' +
        'یا فقط اسم کانال: v2ray_configs',
      kbBack('menu')
    );
  }

  // 📥 ورود به صفحه منابع
  if (data === 'fetch_menu') {
    return showSources(platform, env, chatId, messageId);
  }

  // 🗑 حذف منبع
  if (data.startsWith('del:')) {
    const idx = parseInt(data.split(':')[1], 10);
    const sources = await getSources(env, chatId);
    if (idx >= 0 && idx < sources.length) {
      sources.splice(idx, 1);
      await setSources(env, chatId, sources);
    }
    if (!sources.length) {
      return editMenu(platform, env, chatId, messageId, '📭 لیست خالی شد.', kbMain());
    }
    return showSources(platform, env, chatId, messageId);
  }

  // 📥 دریافت از یک منبع
  if (data.startsWith('fetch:')) {
    const idx = parseInt(data.split(':')[1], 10);
    const sources = await getSources(env, chatId);
    const url = sources[idx];
    if (!url) return answerCb(platform, env, cq.id, 'منبع پیدا نشد');

    await editMenu(
      platform,
      env,
      chatId,
      messageId,
      `⏳ در حال دریافت از:\n${url}`,
      kbBack('fetch_menu')
    );
    try {
      const result = await scrape(url);
      await send(platform, env, chatId, renderOne(result));
    } catch (e) {
      await send(platform, env, chatId, '❌ خطا: ' + e.message);
    }
    return;
  }

  // 📥 دریافت موازی از همه منابع
  if (data === 'fetch_all') {
    const sources = await getSources(env, chatId);
    if (!sources.length) {
      return editMenu(
        platform,
        env,
        chatId,
        messageId,
        '📭 هیچ منبعی نداری.',
        kbBack('menu')
      );
    }

    await editMenu(
      platform,
      env,
      chatId,
      messageId,
      `⏳ در حال دریافت موازی از ${sources.length} منبع...`,
      kbBack('fetch_menu')
    );
    try {
      const out = await fetchAll(sources);
      await send(platform, env, chatId, out);
    } catch (e) {
      await send(platform, env, chatId, '❌ خطا: ' + e.message);
    }
    return;
  }

  // ⚙️ تنظیمات
  if (data === 'settings') {
    const sources = await getSources(env, chatId);
    const info =
      '⚙️ تنظیمات\n\n' +
      `📊 منابع ثبت‌شده: ${sources.length}\n` +
      '💾 کانفیگ‌ها ذخیره نمی‌شن (فقط منابع)\n' +
      '🚀 دریافت موازی: فعال\n' +
      '🔁 حذف تکراری‌ها: فعال\n\n' +
      'برای مدیریت منابع به «📥 دریافت فایل» برگرد.';
    return editMenu(platform, env, chatId, messageId, info, kbBack('menu'));
  }

  return answerCb(platform, env, cq.id, 'ناشناخته');
}

// ==================================================================
//  💬 بخش ۸ — پردازش پیام‌های متنی
// ==================================================================

async function onMessage(platform, env, msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;

  const state = await getState(env, chatId);

  // کاربر در حال فرستادن URL منبع
  if (state === 'awaiting_source') {
    await setState(env, chatId, null);

    let url = text;
    if (!/^https?:\/\//i.test(url)) {
      if (/^[a-zA-Z0-9_]{3,}$/.test(url)) url = `https://t.me/s/${url}`;
      else return send(platform, env, chatId, '❌ لینک معتبر نیست.');
    }
    url = normalizeChannelUrl(url);

    const sources = await getSources(env, chatId);
    if (!sources.includes(url)) sources.push(url);
    await setSources(env, chatId, sources);

    return send(
      platform,
      env,
      chatId,
      `✅ اضافه شد:\n${url}\n\nمجموع: ${sources.length} منبع`,
      { reply_markup: kbMain() }
    );
  }

  const cmd = text.split(/\s+/)[0].toLowerCase();

  // /start
  if (cmd === '/start' || cmd === '/menu' || cmd === '/help') {
    return showMenu(platform, env, chatId, null, cmd === '/start');
  }

  // /sources
  if (cmd === '/sources') {
    const sources = await getSources(env, chatId);
    if (!sources.length) return send(platform, env, chatId, '📭 منبعی نداری.');
    return send(
      platform,
      env,
      chatId,
      `📋 منابع (${sources.length}):\n\n` +
        sources.map((s, i) => `${i + 1}. ${s}`).join('\n'),
      { reply_markup: kbSources(sources) }
    );
  }

  // /fetch <url>
  if (cmd === '/fetch') {
    const url = text.slice('/fetch'.length).trim();
    if (!url) return send(platform, env, chatId, '❌ مثال:\n/fetch https://t.me/s/xxx');

    await send(platform, env, chatId, '⏳ در حال دریافت...');
    try {
      const r = await scrape(url);
      return send(platform, env, chatId, renderOne(r));
    } catch (e) {
      return send(platform, env, chatId, '❌ ' + e.message);
    }
  }

  // /fetchall
  if (cmd === '/fetchall') {
    const sources = await getSources(env, chatId);
    if (!sources.length) return send(platform, env, chatId, '📭 اول منبع اضافه کن.');

    await send(platform, env, chatId, `⏳ دریافت موازی از ${sources.length} منبع...`);
    try {
      const out = await fetchAll(sources);
      return send(platform, env, chatId, out);
    } catch (e) {
      return send(platform, env, chatId, '❌ ' + e.message);
    }
  }

  return send(platform, env, chatId, '❓ ناشناخته. /help');
}

// ==================================================================
//  🚦 بخش ۹ — روتر آپدیت‌ها
// ==================================================================

async function routeUpdate(platform, env, update) {
  if (update.callback_query) return onCallback(platform, env, update.callback_query);
  if (update.message) return onMessage(platform, env, update.message);
}

// ==================================================================
//  🌍 بخش ۱۰ — نقاط ورود Worker
// ==================================================================

export default {
  // ─── HTTP handler (webhook ها) ──────────────────────────────────
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // صفحه اصلی
    if (url.pathname === '/' && req.method === 'GET') {
      return new Response(
        'PRPoxy ✅\n\nEndpoints:\n- /tg       (Telegram webhook)\n- /soroush  (Soroush webhook)\n- /setup    (register webhooks)',
        { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }

    // /setup — ثبت webhook ها
    if (url.pathname === '/setup') {
      const out = {};

      if (env.TELEGRAM_BOT_TOKEN) {
        out.telegram = await tgApi(env, 'setWebhook', {
          url: `${url.origin}/tg`,
          drop_pending_updates: true,
        });
      }

      // سروش فقط اگه webhook فعال باشه (پیش‌فرض: polling)
      if (env.SOROUSH_BOT_TOKEN && env.SOROUSH_USE_WEBHOOK === 'true') {
        try {
          out.soroush = await srApi(env, 'setWebhook', {
            url: `${url.origin}/soroush`,
          });
        } catch (e) {
          out.soroush = { error: e.message };
        }
      }

      return new Response(JSON.stringify(out, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // webhook تلگرام
    if (url.pathname === '/tg' && req.method === 'POST') {
      try {
        const u = await req.json();
        ctx.waitUntil(routeUpdate('tg', env, u));
      } catch (e) {
        console.error('tg webhook', e);
      }
      return new Response('ok');
    }

    // webhook سروش
    if (url.pathname === '/soroush' && req.method === 'POST') {
      try {
        const u = await req.json();
        ctx.waitUntil(routeUpdate('soroush', env, u));
      } catch (e) {
        console.error('soroush webhook', e);
      }
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  },

  // ─── Cron handler (polling سروش هر ۱ دقیقه) ────────────────────
  // برای مواقعی که سروش نمی‌تونه webhook به CF بفرسته.
  // اگه SOROUSH_USE_WEBHOOK=true باشه، این بخش غیرفعال می‌شه.
  async scheduled(_event, env, ctx) {
    if (!env.SOROUSH_BOT_TOKEN) return;
    if (env.SOROUSH_USE_WEBHOOK === 'true') return;

    try {
      let offset = 0;
      if (env.KV) {
        offset = parseInt((await env.KV.get('sr_offset')) || '0', 10) || 0;
      }

      const res = await srApi(env, 'getUpdates', {
        offset,
        timeout: 0,
        limit: 100,
      });

      if (res.ok && Array.isArray(res.result) && res.result.length) {
        let maxId = offset;
        for (const u of res.result) {
          if (u.update_id >= maxId) maxId = u.update_id + 1;
          ctx.waitUntil(routeUpdate('soroush', env, u));
        }
        if (env.KV) await env.KV.put('sr_offset', String(maxId));
      }
    } catch (e) {
      console.error('cron soroush polling', e);
    }
  },
};