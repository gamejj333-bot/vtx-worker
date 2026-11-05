const LICENSE_PREFIX = "license:";
const HWID_PREFIX = "hwid:";
const ADMINS_KEY = "admins";
const DEFAULT_KEY_PREFIX = "VTX";
const KEY_PREFIX_CONFIG = "config:key_prefix";
const ADMIN_PREFIX_CONFIG = "config:admin_prefix:";
const PROFILE_PREFIX = "user:";
const REFERRAL_PREFIX = "referral:";
const REFERRAL_REWARD_STEP = 10;
const REFERRAL_REWARD_POINTS = 5;
const KEY_POINTS_PER_DAY = 10;
const MAIN_CHANNEL = "https://t.me/VTX_LUA";
const KEY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function textResponse(body, status = 200, contentType = "text/plain; charset=utf-8") {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    },
  });
}
function jsonResponse(data, status = 200) {
  return textResponse(JSON.stringify(data), status, "application/json; charset=utf-8");
}
function luaResponse(status, message, extra = "") {
  const safeMessage = String(message)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\n");
  return textResponse(
    `return { status = "${status}", message = "${safeMessage}"${extra} }`
  );
}
function normalizeKey(value) {
  return String(value || "").trim().toUpperCase();
}
function normalizeHWID(value) {
  return String(value || "").trim();
}
async function readJson(env, key, fallback) {
  const raw = await env.HWID_DB.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function parseDateEndOfDay(dateText) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText || ""));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}
function addDaysUTC(days) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
async function getAdmins(env) {
  const admins = await readJson(env, ADMINS_KEY, {});
  return admins && typeof admins === "object" && !Array.isArray(admins) ? admins : {};
}
async function saveAdmins(env, admins) {
  await env.HWID_DB.put(ADMINS_KEY, JSON.stringify(admins));
}
async function listLicenses(env) {
  const out = [];
  let cursor = undefined;
  do {
    const page = await env.HWID_DB.list({ prefix: LICENSE_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    const entries = await Promise.all((page.keys || []).map(async item => {
      const key = String(item.name || "").slice(LICENSE_PREFIX.length);
      if (!key) return null;
      const license = await readJson(env, item.name, null);
      return license ? { key, license } : null;
    }));
    for (const entry of entries) if (entry) out.push(entry);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}
function licenseIsExpired(license) {
  const expiry = parseDateEndOfDay(license?.expiry);
  return !expiry || Date.now() > expiry.getTime();
}
async function buildDashboard(env, fromId, isMaster) {
  const all = await listLicenses(env);
  const mine = (isMaster ? all : all.filter(x => String(x.license?.created_by || "") === String(fromId)))
    .sort((a, b) => String(b.license?.created_at || "").localeCompare(String(a.license?.created_at || "")));
  let active = 0;
  let revoked = 0;
  let expired = 0;
  let devices = 0;
  for (const item of mine) {
    const lic = item.license || {};
    if (lic.valid === false) revoked++;
    else if (licenseIsExpired(lic)) expired++;
    else active++;
    devices += Number.parseInt(lic.max_devices, 10) || 0;
  }
  return { all, mine, active, revoked, expired, devices };
}
function formatKeyRows(items, limit = 35) {
  const rows = items.slice(0, limit).map((item, index) => {
    const lic = item.license || {};
    const state = lic.valid === false ? "🚫" : licenseIsExpired(lic) ? "⌛" : "✅";
    return `${index + 1}. ${state} ${item.key}\n   📅 ${lic.expiry || "N/A"} | 📱 ${lic.max_devices || 1} | 👤 ${lic.created_by || "?"}`;
  });
  return rows.join("\n\n");
}
async function ensureAdmin(env, telegramUserId) {
  const id = String(telegramUserId || "");
  if (!id) return false;
  if (id === String(env.TELEGRAM_ADMIN_ID || "")) return true;
  const admins = await getAdmins(env);
  return !!admins[id];
}
async function getProfile(env, id) {
  const key = `${PROFILE_PREFIX}${id}`;
  const profile = await readJson(env, key, null);
  if (profile && typeof profile === "object") return profile;
  const fresh = { id: String(id), role: "user", points: 0, referrals: [], rewardedMilestones: 0, joined_at: new Date().toISOString() };
  await env.HWID_DB.put(key, JSON.stringify(fresh));
  return fresh;
}
async function saveProfile(env, id, profile) {
  await env.HWID_DB.put(`${PROFILE_PREFIX}${id}`, JSON.stringify(profile));
}
async function getRole(env, id) {
  const sid = String(id || "");
  if (sid && sid === String(env.TELEGRAM_ADMIN_ID || "")) return "master";
  const admins = await getAdmins(env);
  if (admins[sid]) return "admin";
  const profile = await getProfile(env, sid);
  return profile.role === "admin" ? "admin" : "user";
}
async function isChannelMember(env, userId) {
  const chatId = String(env.MAIN_CHANNEL_ID || env.MAIN_CHANNEL_USERNAME || "").trim();
  if (!chatId) return false;
  try {
    const result = await telegramCall(env, "getChatMember", { chat_id: chatId, user_id: Number(userId) });
    return ["creator", "administrator", "member"].includes(result?.result?.status) ||
      (result?.result?.status === "restricted" && result?.result?.is_member === true);
  } catch { return false; }
}
async function eligibleForReferral(env, id) {
  return true;
}
async function userCount(env) {
  let count = 0, cursor;
  do {
    const page = await env.HWID_DB.list({ prefix: PROFILE_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    count += (page.keys || []).length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return count;
}
async function balanceText(env, id, role) {
  if (role === "master") return "♾️ Unlimited";
  const profile = await getProfile(env, id);
  return `${Number(profile.points || 0)} P`;
}
function randomKeyPart(length = 3) {
  let s = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (const b of bytes) s += KEY_CHARS[b % KEY_CHARS.length];
  return s;
}
function normalizePrefix(value) {
  const prefix = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9]{1,12}$/.test(prefix) ? prefix : null;
}
async function getKeyPrefix(env, adminId) {
  const personal = adminId ? await env.HWID_DB.get(`${ADMIN_PREFIX_CONFIG}${adminId}`) : null;
  if (personal) return String(personal).trim().toUpperCase();
  if (String(adminId || "") === String(env.TELEGRAM_ADMIN_ID || "")) {
    const saved = await env.HWID_DB.get(KEY_PREFIX_CONFIG);
    return String(saved || DEFAULT_KEY_PREFIX).trim().toUpperCase() || DEFAULT_KEY_PREFIX;
  }
  return DEFAULT_KEY_PREFIX;
}
async function generateKey(env, adminId, days) {
  const prefix = await getKeyPrefix(env, adminId);
  const durationCode = `${days}D`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const key = `${prefix}-${durationCode}-${randomKeyPart(3)}-${randomKeyPart(3)}`;
    if (!(await env.HWID_DB.get(`${LICENSE_PREFIX}${key}`))) return key;
  }
  throw new Error("Could not create a unique key; try again or use a different prefix.");
}
async function adminAllowed(env, telegramUserId) {
  return ensureAdmin(env, telegramUserId);
}
async function telegramCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN missing");
  }
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.description || `Telegram API error ${response.status}`);
  }
  return data;
}
function escapeTelegramHTML(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
async function sendTelegram(env, chatId, message, replyMarkup = null) {
  // Telegram limits message text to 4096 characters. Guides can exceed that limit,
  // so split long messages safely and attach the keyboard to the final chunk.
  const source = String(message ?? "");
  const maxChunk = 3000;
  const chunks = [];
  let remaining = source;
  while (remaining.length > maxChunk) {
    let cut = remaining.lastIndexOf("\n", maxChunk);
    if (cut < Math.floor(maxChunk * 0.55)) cut = maxChunk;
    else cut += 1;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  chunks.push(remaining);
  let result;
  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      chat_id: chatId,
      text: `<b>${escapeTelegramHTML(chunks[i])}</b>`,
      parse_mode: "HTML"
    };
    if (i === chunks.length - 1 && replyMarkup) payload.reply_markup = replyMarkup;
    result = await telegramCall(env, "sendMessage", payload);
  }
  return result;
}
function mainKeyboard(role = "user") {
  if (typeof role === "boolean") role = role ? "master" : "admin";
  const rows = [
    [{ text: "🔑 Generate Key", callback_data: "ask:generate" }, { text: "💰 My Balance", callback_data: "cmd:/balance" }],
    [{ text: "🗂 My Keys", callback_data: "cmd:/mykeys" }, { text: "♻️ Reset Device", callback_data: "ask:reset" }],
    [{ text: "👥 Invite Friends", callback_data: "cmd:/referral" }, { text: "🏆 Point Leaderboard", callback_data: "cmd:/leaderboard" }],
    [{ text: "📊 User Counter", callback_data: "cmd:/usercount" }],
  ];
  if (role === "admin" || role === "master") rows.push(
    [{ text: "📈 Dashboard", callback_data: "cmd:/dashboard" }, { text: "ℹ️ Key Info", callback_data: "ask:info" }],
    [{ text: "🚫 Block Key", callback_data: "ask:revoke" }, { text: "🔓 Unblock Key", callback_data: "ask:unblock" }]
  );
  if (role === "master") rows.push(
    [{ text: "👥 Admins", callback_data: "cmd:/admins" }, { text: "🏷 Prefixes", callback_data: "cmd:/prefixes" }],
    [{ text: "➕ Add Admin", callback_data: "ask:addadmin" }, { text: "➖ Remove Admin", callback_data: "ask:deladmin" }],
    [{ text: "💸 Set Points", callback_data: "ask:setpoints" }, { text: "➕ Add Points", callback_data: "ask:addpoints" }],
    [{ text: "🚫 Ban User", callback_data: "ask:banuser" }, { text: "✅ Unban User", callback_data: "ask:unbanuser" }],
    [{ text: "🎨 Set Prefix", callback_data: "ask:setprefix" }, { text: "🔓 Unblock All", callback_data: "cmd:/unblockall" }],
    [{ text: "🛑 Block All Keys", callback_data: "ask:blockallconfirm" }]
  );
  rows.push([{ text: "🔄 Refresh Menu", callback_data: "menu" }, { text: "📘 Button Guide", callback_data: "guide" }]);
  return { inline_keyboard: rows };
}
function webhookAuthorized(request, env) {
  const expected = String(env.TELEGRAM_WEBHOOK_SECRET || "");
  if (!expected) return false;
  const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  return supplied === expected;
}
async function handleTelegram(request, env) {
  if (!webhookAuthorized(request, env)) {
    return textResponse("Forbidden", 403);
  }
  let update;
  try {
    update = await request.json();
  } catch {
    return textResponse("Bad JSON", 400);
  }
  const callback = update?.callback_query;
  const message = update?.message || callback?.message;
  let text = String(message?.text || "").trim();
  const chatId = message?.chat?.id;
  const fromId = update?.message?.from?.id || callback?.from?.id;
  if (callback) {
    await telegramCall(env, "answerCallbackQuery", { callback_query_id: callback.id }).catch(() => null);
  }
  if (!chatId) return jsonResponse({ ok: true });
  const incomingRole = await getRole(env, fromId);
  if (incomingRole !== "master") {
    const incomingProfile = await getProfile(env, String(fromId));
    if (incomingProfile.banned) {
      const reason = String(incomingProfile.ban_reason || "Bot usage has been restricted by the administrator.");
      await sendTelegram(env, chatId,
        "🚫 ACCOUNT BANNED / အကောင့်ပိတ်ပင်ခံထားရသည်\n\n" +
        "Your account has been banned from using VTX KEY SYSTEM. You cannot use bot features while this ban is active.\n\n" +
        "သင့်အကောင့်ကို VTX KEY SYSTEM မှ အသုံးပြုခွင့်ပိတ်ထားပါသည်။ ပိတ်ပင်ထားစဉ် Bot ဝန်ဆောင်မှုများကို အသုံးပြု၍မရပါ။\n\n" +
        `Reason / အကြောင်းပြချက်: ${reason}\n\nPlease contact the bot administrator if you believe this is a mistake.\nမှားယွင်းပိတ်ပင်ခံရသည်ဟု ထင်ပါက Bot Admin ကို ဆက်သွယ်ပါ.`
      );      return jsonResponse({ ok: true });
    }
  }
  if (callback) {
    const data = String(callback.data || "");
    if (data === "menu") {
      const role = await getRole(env, fromId);
      await sendTelegram(env, chatId, "🔥 VTX KEY SYSTEM\nChoose an action below.", mainKeyboard(role));
      return jsonResponse({ ok: true });
    }
    if (data === "guide") {
      await sendTelegram(env, chatId,
        "📘 VTX KEY SYSTEM — BUTTON GUIDE\nChoose your language / ဘာသာစကားရွေးချယ်ပါ။",
        { inline_keyboard: [[{ text: "🇲🇲 မြန်မာဘာသာ", callback_data: "guide:mm" }, { text: "🇬🇧 English", callback_data: "guide:en" }], [{ text: "⬅️ Main Menu", callback_data: "menu" }]] }
      );
      return jsonResponse({ ok: true });
    }
    if (data === "guide:mm" || data === "guide:en") {
      const role = await getRole(env, fromId);
      const mm = data === "guide:mm";
      const guide = mm
        ? `📘 VTX KEY SYSTEM
━━━━━━━━━━━━━━━━━━
🇲🇲 ခလုတ်အသုံးပြုနည်း
━━━━━━━━━━━━━━━━━━
🔑 ၁။ KEY MANAGEMENT
• Generate Key — Key အသစ်ထုတ်ရန်။ ရက်နှင့် Device အရေအတွက်ကို 30 1 ပုံစံဖြင့် ထည့်ပါ။
• My Keys — ကိုယ်ထုတ်ထားသော Key များကို ကြည့်ရန်။ Master သည် Key အားလုံးကို ကြည့်နိုင်သည်။
• Key Info — Key တစ်ခု၏ အချက်အလက်ကို စစ်ဆေးရန်။
• Reset Device — ကိုယ်ပိုင် Key ၏ Device/HWID ချိတ်ဆက်မှုကို ပြန်သတ်မှတ်ရန်။ User/Admin သည် ကိုယ်ပိုင် Key ကိုသာ Reset လုပ်နိုင်သည်။
• Block Key — ခွင့်ပြုချက်ရှိသော Admin/Master က Key ကို ပိတ်ရန်။
• Unblock Key — ပိတ်ထားသော Key ကို ပြန်ဖွင့်ရန်။
💰 ၂။ POINT နှင့် စျေးနှုန်း
• My Balance — လက်ကျန် Point ကို ကြည့်ရန်။ Master သည် Unlimited ဖြစ်သည်။
• Point Leaderboard — လက်ရှိ Point အများဆုံးရှိသော Top 20 User များကို ကြည့်ရန်။ BAN ခံထားရသူများ မပါဝင်ပါ။
• Set Points / Add Points — Point သတ်မှတ်/ထပ်ဖြည့်ရန် (Master သာ)။
📌 KEY စျေးနှုန်း
1 ရက်  = 10 P
3 ရက်  = 30 P
7 ရက်  = 70 P
15 ရက် = 150 P
30 ရက် = 300 P
👥 ၃။ REFERRAL SYSTEM
• Invite Friends — ဖိတ်ခေါ်လင့်ခ်နှင့် Referral အချက်အလက်ကို ကြည့်ရန်။
• သတ်မှတ်ချက်ပြည့်မီသော လူ 10 ယောက် ဖိတ်ခေါ်လျှင် 5 Point ရရှိမည်။
• လူ 10 ယောက် ပြည့်တိုင်း 5 Point ရရှိမည်။ Channel Join လုပ်ရန် မလိုပါ။
• 10 Point ပြည့်လျှင် 1 Day Key ထုတ်နိုင်သည်။
📢 Update များအတွက် Main Channel ကို Join လုပ်ရန် အကြံပြုပါသည်။
https://t.me/VTX_LUA
📊 ၄။ စာရင်းအင်း
• User Counter — Bot ကို စတင်အသုံးပြုထားသူ စုစုပေါင်းကို ကြည့်ရန်။
• Point Leaderboard — Point အများဆုံးရှိသူ Top 20 ကို ကြည့်ရန်။ BAN ခံထားရသူများ မပါဝင်ပါ။
• Dashboard — Key စာရင်းအင်းကို ကြည့်ရန်။ Admin သည် ကိုယ်ပိုင် Key များကိုသာ မြင်နိုင်ပြီး Master သည် Key အားလုံးကို မြင်နိုင်သည်။
🛡️ ၅။ MASTER သာ အသုံးပြုနိုင်သော ခလုတ်များ
• Admins — Admin စာရင်းကြည့်ရန်။
• Add Admin / Remove Admin — Admin ထည့်/ဖယ်ရန်။
• Prefixes / Set Prefix — Key Prefix များကြည့်ရန်နှင့် သတ်မှတ်ရန်။
• Unblock All — ပိတ်ထားသော Key အားလုံးကို ပြန်ဖွင့်ရန်။
• Block All Keys — Key အားလုံးကို ပိတ်ရန်။
• Ban User / Unban User — Telegram ID ဖြင့် User ကို Bot အသုံးပြုခွင့် ပိတ်/ပြန်ဖွင့်ရန်။ BAN ခံထားရသူသည် Bot အသုံးပြုတိုင်း BAN အကြောင်းကြားစာ ရရှိမည်။ Master အကောင့်ကို BAN မလုပ်နိုင်ပါ။
🔄 Refresh Menu — Main Menu ကို ပြန်ဖွင့်ရန်။
⌨️ Guide ကို /guide ဖြင့်လည်း ဖွင့်နိုင်သည်။
━━━━━━━━━━━━━━━━━━
🔐 VTX KEY SYSTEM`
        : `📘 VTX KEY SYSTEM
━━━━━━━━━━━━━━━━━━
🇬🇧 BUTTON GUIDE
━━━━━━━━━━━━━━━━━━
🔑 1. KEY MANAGEMENT
• Generate Key — Create a new key. Enter days and device count, e.g. 30 1.
• My Keys — View keys you generated. Master can view all keys.
• Key Info — Check the details of a key.
• Reset Device — Reset the device/HWID binding for your own key. Users and admins can reset only their own keys.
• Block Key — Block a key (authorized admins only).
• Unblock Key — Re-enable a blocked key.
💰 2. POINTS & PRICING
• My Balance — Check your available points. Master has unlimited balance.
• Point Leaderboard — View the Top 20 users by current points. Banned users are excluded.
• Set Points / Add Points — Set or add points (Master only).
📌 KEY PRICES
1 day  = 10 P
3 days = 30 P
7 days = 70 P
15 days = 150 P
30 days = 300 P
👥 3. REFERRAL SYSTEM
• Invite Friends — View your referral link and reward details.
• Earn 5 points for every 10 invited users. No channel membership required.
• 10 points can be used for a 1-day key.
📢 Join the Main Channel for updates (optional):
https://t.me/VTX_LUA
📊 4. STATISTICS
• User Counter — View the total number of users who have started the bot.
• Point Leaderboard — View the Top 20 users by current points. Banned users are excluded.
• Dashboard — View key statistics. Admins can see only their own keys; Master can see all keys.
🛡️ 5. MASTER-ONLY CONTROLS
• Admins — View the admin list.
• Add Admin / Remove Admin — Add or remove admins.
• Prefixes / Set Prefix — View and assign key prefixes.
• Unblock All — Unblock all keys.
• Block All Keys — Block all keys.
• Ban User / Unban User — Restrict or restore a user's bot access using their Telegram ID. Banned users receive a ban notice whenever they try to use the bot. The Master account cannot be banned.
🔄 Refresh Menu — Reopen the main menu.
⌨️ You can also open this guide with /guide.
━━━━━━━━━━━━━━━━━━
🔐 VTX KEY SYSTEM`;
      await sendTelegram(env, chatId, guide, { inline_keyboard: [[{ text: mm ? "🇬🇧 English Version" : "🇲🇲 မြန်မာဘာသာ", callback_data: mm ? "guide:en" : "guide:mm" }], [{ text: "⬅️ Main Menu", callback_data: "menu" }]] });
      return jsonResponse({ ok: true });
    }
    if (data === "ask:blockallconfirm") {
      const master = String(fromId || "") === String(env.TELEGRAM_ADMIN_ID || "");
      if (!master) {
        await sendTelegram(env, chatId, "⛔ Only Master Admin can block all keys.");
        return jsonResponse({ ok: true });
      }
      await sendTelegram(env, chatId,
        "⚠️ BLOCK ALL KEYS?\n\nThis will disable every license key. You can restore them later with Unblock All.",
        { inline_keyboard: [[{ text: "🛑 Confirm Block All", callback_data: "confirm:blockall" }], [{ text: "✖️ Cancel", callback_data: "cancel" }]] }
      );
      return jsonResponse({ ok: true });
    }
    if (data === "confirm:blockall") text = "/blockall";
    else if (data.startsWith("ask:")) {
      const action = data.slice(4);
      const prompts = {
        generate: "🔑 Enter days and device count, separated by a space. Example: 30 1",
        info: "ℹ️ Send the license key you want to inspect.",
        revoke: "🚫 Send the license key you want to block.",
        unblock: "🔓 Send the license key you want to unblock.",
        reset: "♻️ Send the license key whose device binding should be reset.",
        addadmin: "➕ Send the Telegram numeric ID of the new admin.",
        deladmin: "➖ Send the Telegram numeric ID of the admin to remove.",
        setprefix: "🎨 Send admin ID and prefix, e.g. 123456789 VIP (use me VTX for your own prefix).",
        setpoints: "💰 Send Telegram ID and new point balance, e.g. 123456789 500",
        addpoints: "➕ Send Telegram ID and points to add, e.g. 123456789 100",
        banuser: "🚫 Send the Telegram numeric ID to ban, optionally with a reason. Example: 123456789 Spam / abuse",
        unbanuser: "✅ Send the Telegram numeric ID to unban. Example: 123456789"
      };
      await env.HWID_DB.put(`pending_action:${fromId}`, action, { expirationTtl: 600 });
      await sendTelegram(env, chatId, prompts[action] || "Send the requested value.", { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "cancel" }, { text: "⬅️ Main Menu", callback_data: "menu" }]] });
      return jsonResponse({ ok: true });
    }
    if (data === "cancel") {
      await env.HWID_DB.delete(`pending_action:${fromId}`);
      await sendTelegram(env, chatId, "Cancelled.", mainKeyboard(await getRole(env, fromId)));
      return jsonResponse({ ok: true });
    }
    if (data.startsWith("cmd:")) text = data.slice(4);
    else if (data !== "confirm:blockall") return jsonResponse({ ok: true });
  }
  if (!chatId) return jsonResponse({ ok: true });
  if (!text && update?.message) return jsonResponse({ ok: true });
  if (update?.message?.text && /^\d+\s+\d+$/.test(String(update.message.text).trim())) {
    text = `/generate ${String(update.message.text).trim()}`;
  }
  if (update?.message?.text && fromId) {
    const pending = await env.HWID_DB.get(`pending_action:${fromId}`);
    if (pending) {
      await env.HWID_DB.delete(`pending_action:${fromId}`);
      const value = String(update.message.text || "").trim();
      if (pending === "generate") text = `/generate ${value}`;
      else if (["info", "revoke", "unblock", "reset"].includes(pending)) text = `/${pending} ${value}`;
      else if (["addadmin", "deladmin"].includes(pending)) text = `/${pending} ${value}`;
      else if (pending === "setprefix") text = `/setprefix ${value}`;
      else if (pending === "setpoints") text = `/setpoints ${value}`;
      else if (pending === "addpoints") text = `/addpoints ${value}`;
      else if (pending === "banuser") text = `/banuser ${value}`;
      else if (pending === "unbanuser") text = `/unbanuser ${value}`;
    }
  }
  if (/^\/start(?:@\w+)?(?:\s+ref_\d+)?$/i.test(text)) {
    const sid = String(fromId || "");
    const profile = await getProfile(env, sid);
    const refMatch = text.match(/^\/start(?:@\w+)?\s+ref_(\d+)$/i);
    if (refMatch && refMatch[1] !== sid && !profile.referred_by) {
      profile.referred_by = refMatch[1];
      await saveProfile(env, sid, profile);
      const referrer = await getProfile(env, refMatch[1]);
      referrer.referrals = Array.isArray(referrer.referrals) ? referrer.referrals : [];
      if (!referrer.referrals.includes(sid)) {
        referrer.referrals.push(sid);
        await saveProfile(env, refMatch[1], referrer);
      }
    }
    const role = await getRole(env, sid);
    await sendTelegram(env, chatId,
      "🔥 VTX KEY SYSTEM\n\n" +
      `👤 ID: ${sid}\n🎭 Role: ${role.toUpperCase()}\n💰 Balance: ${await balanceText(env, sid, role)}\n\n` +
      "Welcome! Choose an action below.\n\n📢 Optional: Join our Main Channel for updates.",
      { inline_keyboard: [[{ text: "📢 JOIN MAIN CHANNEL", url: MAIN_CHANNEL }], [{ text: "📘 User Guide / အသုံးပြုနည်း", callback_data: "guide" }]] }
    );
    await sendTelegram(env, chatId, "👇 Main Menu", mainKeyboard(role));
    return jsonResponse({ ok: true });
  }
  if (/^\/guide(?:@\w+)?$/i.test(text)) {
    await sendTelegram(env, chatId,
      "📘 VTX KEY SYSTEM — USER GUIDE\nChoose your language / ဘာသာစကားရွေးချယ်ပါ။",
      { inline_keyboard: [[{ text: "🇲🇲 မြန်မာဘာသာ", callback_data: "guide:mm" }, { text: "🇬🇧 English", callback_data: "guide:en" }], [{ text: "⬅️ Main Menu", callback_data: "menu" }]] }
    );
    return jsonResponse({ ok: true });
  }
  if (/^\/myid(?:@\w+)?$/i.test(text)) {
    await sendTelegram(env, chatId, `🆔 Your Telegram ID: ${fromId}`);
    return jsonResponse({ ok: true });
  }
  if (/^\/help(?:@\w+)?$/i.test(text)) {
    await sendTelegram(
      env,
      chatId,
      "✨ PREMIUM CONTROL PANEL\n\n" +
      "Choose an action using the buttons below.\n\n" +
      "🔑 Generate • ℹ️ Inspect • 🚫 Block • 🔓 Unblock\n" +
      "📊 Dashboard • 🗂 My Keys • ♻️ Reset Device\n\n" +
      "Admins can manage only their own keys. Master can manage all keys, admins, and prefixes.\n" +
      "Key format: PREFIX-ND-XXX-XXX",
      mainKeyboard(await getRole(env, fromId))
    );
    return jsonResponse({ ok: true });
  }
  const role = await getRole(env, fromId);
  const masterId = String(env.TELEGRAM_ADMIN_ID || "");
  const isMaster = role === "master";
  const isAdmin = role === "admin";
  const profile = await getProfile(env, String(fromId));
  let match;
  if (/^\/balance(?:@\w+)?$/i.test(text)) {
    await sendTelegram(env, chatId, `💰 VTX BALANCE\nRole: ${role.toUpperCase()}\nBalance: ${await balanceText(env, fromId, role)}\n\n🔑 Key price: 10 P per day`);
    return jsonResponse({ ok: true });
  }
  if (/^\/usercount(?:@\w+)?$/i.test(text)) {
    const count = await userCount(env);
    await sendTelegram(env, chatId, `📊 VTX USER COUNTER\n👤 Registered users: ${count}`);
    return jsonResponse({ ok: true });
  }
  if (/^\/leaderboard(?:@\w+)?$/i.test(text)) {
    let cursor;
    const users = [];
    do {
      const page = await env.HWID_DB.list({ prefix: PROFILE_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
      const profiles = await Promise.all((page.keys || []).map(item => readJson(env, item.name, null)));
      for (const p of profiles) if (p && !p.banned) users.push(p);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    users.sort((a, b) => Number(b.points || 0) - Number(a.points || 0));
    const top = users.slice(0, 20);
    const rows = top.length ? top.map((p, i) => `${i + 1}. ${i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "👤"} ID ${p.id} — ${Number(p.points || 0)} P`).join("\n") : "No users found.";
    await sendTelegram(env, chatId, `🏆 VTX POINT LEADERBOARD\nTop ${top.length} users by current point balance\n\n${rows}\n\n👥 Active profiles: ${users.length}`,
      { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "cmd:/leaderboard" }, { text: "⬅️ Main Menu", callback_data: "menu" }]] });
    return jsonResponse({ ok: true });
  }
  if (/^\/referral(?:@\w+)?$/i.test(text)) {
    const botName = String(env.TELEGRAM_BOT_USERNAME || "YOUR_BOT").replace(/^@/, "");
    const refList = Array.isArray(profile.referrals) ? profile.referrals : [];
    const milestones = Math.floor(refList.length / REFERRAL_REWARD_STEP);
    if (milestones > Number(profile.rewardedMilestones || 0)) {
      const newlyEarned = (milestones - Number(profile.rewardedMilestones || 0)) * REFERRAL_REWARD_POINTS;
      profile.points = Number(profile.points || 0) + newlyEarned;
      profile.rewardedMilestones = milestones;
      await saveProfile(env, String(fromId), profile);
    }
    await sendTelegram(env, chatId,
      `👥 REFERRAL CENTER / ဖိတ်ခေါ်မှု\n\n🔗 Your link / ဖိတ်ခေါ်လင့်ခ်: https://t.me/${botName}?start=ref_${fromId}\n📨 Invited / ဖိတ်ခေါ်ထားသူ: ${refList.length}\n🎁 Reward / ဆု: 5 P per 10 invites / 10 ယောက်လျှင် 5 P\n🔑 10 P = 1-day key / 10 P = 1 ရက် Key\n💰 Balance / လက်ကျန်: ${await balanceText(env, fromId, role)}\n\n📢 Optional Main Channel / Join လုပ်ရန် အကြံပြုသည်: ${MAIN_CHANNEL}`,
      { inline_keyboard: [[{ text: "📢 JOIN MAIN CHANNEL", url: MAIN_CHANNEL }], [{ text: "⬅️ Main Menu", callback_data: "menu" }]] }
    );
    return jsonResponse({ ok: true });
  }
  if (role === "user" && !/^\/(?:generate|reset|mykeys|myid|help|leaderboard)(?:@\w+)?(?:\s|$)/i.test(text)) {
    await sendTelegram(env, chatId, "⛔ User role can only generate keys, view own keys, and reset devices for own keys. Use the menu below.", mainKeyboard(role));
    return jsonResponse({ ok: true });
  }
  if (/^\/dashboard(?:@\w+)?$/i.test(text)) {
    if (role === "user") { await sendTelegram(env, chatId, "⛔ Dashboard is available to Admin and Master only."); return jsonResponse({ok:true}); }
    const d = await buildDashboard(env, fromId, isMaster);
    const scope = isMaster ? "ALL ADMINS" : "MY KEYS ONLY";
    await sendTelegram(
      env,
      chatId,
      "📊 LICENSE DASHBOARD\n\n" +
      `👤 Scope: ${scope}\n` +
      `🔢 Total generated: ${d.mine.length}\n` +
      `✅ Active: ${d.active}\n` +
      `⌛ Expired: ${d.expired}\n` +
      `🚫 Revoked: ${d.revoked}\n` +
      `📱 Device capacity: ${d.devices}\n` +
      (isMaster ? `👤 Registered users: ${await userCount(env)}\n♾️ Master Balance: Unlimited\n` : `💰 Your balance: ${await balanceText(env, fromId, role)}\n`) +
      "\nUse /mykeys to view the generated keys."
    );
    return jsonResponse({ ok: true });
  }
  if (/^\/mykeys(?:@\w+)?$/i.test(text)) {
    const d = await buildDashboard(env, fromId, isMaster);
    if (!d.mine.length) {
      await sendTelegram(env, chatId, "📭 No generated keys found for your account.");
      return jsonResponse({ ok: true });
    }
    const header = isMaster ? "🔐 ALL GENERATED KEYS" : "🔐 MY GENERATED KEYS";
    const body = formatKeyRows(d.mine);
    const more = d.mine.length > 35 ? `\n\n… and ${d.mine.length - 35} more. Use /mykeys again after deleting old entries.` : "";
    await sendTelegram(env, chatId, `${header}\n\n${body}${more}`);
    return jsonResponse({ ok: true });
  }
  if (isMaster && /^\/admins(?:@\w+)?$/i.test(text)) {
    const admins = await getAdmins(env);
    const ids = Object.keys(admins);
    let out = "👥 ADMINS\n\n";
    out += `👑 Master: ${masterId}\n`;
    if (!ids.length) out += "\nNo extra admins.";
    else {
      for (const id of ids) { const pr = await getProfile(env, id); out += `\n• ${id} — ${Number(pr.points || 0)} P`; }
    }
    await sendTelegram(env, chatId, out);
    return jsonResponse({ ok: true });
  }
  if (isMaster) {
    match = text.match(/^\/banuser(?:@\w+)?\s+(\d+)(?:\s+(.+))?$/i);
    if (match) {
      const target = String(match[1]);
      if (target === masterId) { await sendTelegram(env, chatId, "❌ You cannot ban the Master account."); return jsonResponse({ ok: true }); }
      const targetProfile = await getProfile(env, target);
      targetProfile.banned = true;
      targetProfile.banned_at = new Date().toISOString();
      targetProfile.ban_reason = String(match[2] || "Bot usage restricted by administrator.").slice(0, 300);
      await saveProfile(env, target, targetProfile);
      await sendTelegram(env, chatId, `🚫 USER BANNED\nID: ${target}\nReason: ${targetProfile.ban_reason}\nThey will receive a ban notice whenever they try to use the bot.`);
      return jsonResponse({ ok: true });
    }
    match = text.match(/^\/unbanuser(?:@\w+)?\s+(\d+)$/i);
    if (match) {
      const target = String(match[1]);
      const targetProfile = await getProfile(env, target);
      targetProfile.banned = false;
      delete targetProfile.banned_at;
      delete targetProfile.ban_reason;
      await saveProfile(env, target, targetProfile);
      await sendTelegram(env, chatId, `✅ USER UNBANNED\nID: ${target}\nThe user can use the bot again.`);
      return jsonResponse({ ok: true });
    }
    match = text.match(/^\/setpoints(?:@\w+)?\s+(\d+)\s+(\d+)$/i);
    if (match) {
      const target = match[1], amount = Number(match[2]);
      if (!Number.isSafeInteger(amount) || amount < 0) { await sendTelegram(env, chatId, "❌ Points must be a non-negative whole number."); return jsonResponse({ok:true}); }
      const targetProfile = await getProfile(env, target);
      targetProfile.points = amount;
      await saveProfile(env, target, targetProfile);
      await sendTelegram(env, chatId, `✅ Balance set\nUser: ${target}\nBalance: ${amount} P`);
      return jsonResponse({ok:true});
    }
    match = text.match(/^\/addpoints(?:@\w+)?\s+(\d+)\s+(\d+)$/i);
    if (match) {
      const target = match[1], amount = Number(match[2]);
      if (!Number.isSafeInteger(amount) || amount < 1) { await sendTelegram(env, chatId, "❌ Points must be a positive whole number."); return jsonResponse({ok:true}); }
      const targetProfile = await getProfile(env, target);
      targetProfile.points = Number(targetProfile.points || 0) + amount;
      await saveProfile(env, target, targetProfile);
      await sendTelegram(env, chatId, `✅ Points added\nUser: ${target}\nNew balance: ${targetProfile.points} P`);
      return jsonResponse({ok:true});
    }
    match = text.match(/^\/setprefix(?:@\w+)?\s+(me|\d+)\s+([A-Z0-9]{1,12})$/i);
    if (match) {
      const targetId = String(match[1]).toLowerCase() === "me" ? masterId : String(match[1]);
      const prefix = normalizePrefix(match[2]);
      if (!prefix) {
        await sendTelegram(env, chatId, "❌ Prefix must contain 1-12 letters/numbers only.");
        return jsonResponse({ ok: true });
      }
      if (targetId !== masterId) {
        const admins = await getAdmins(env);
        if (!admins[targetId]) {
          await sendTelegram(env, chatId, "❌ Admin not found. Add the admin first with /addadmin ID.");
          return jsonResponse({ ok: true });
        }
      }
      await env.HWID_DB.put(`${ADMIN_PREFIX_CONFIG}${targetId}`, prefix);
      await sendTelegram(env, chatId, `✅ Prefix assigned\nAdmin ID: ${targetId}\nPrefix: ${prefix}\nNew keys: ${prefix}-XXX\nExisting keys are unchanged.`);
      return jsonResponse({ ok: true });
    }
    if (/^\/setprefix(?:@\w+)?(?:\s*)$/i.test(text)) {
      await sendTelegram(env, chatId, "Usage:\n/setprefix <admin_id> <prefix>\n/setprefix me <prefix>\nExample: /setprefix 123456789 VIP");
      return jsonResponse({ ok: true });
    }
    if (/^\/prefixes(?:@\w+)?$/i.test(text)) {
      const admins = await getAdmins(env);
      let out = "🏷 ADMIN PREFIXES\n\n";
      out += `👑 Master ${masterId}: ${await getKeyPrefix(env, masterId)}\n`;
      for (const id of Object.keys(admins)) {
        out += `👤 ${id}: ${await getKeyPrefix(env, id)}\n`;
      }
      await sendTelegram(env, chatId, out);
      return jsonResponse({ ok: true });
    }
    match = text.match(/^\/addadmin(?:@\w+)?\s+(\d+)$/i);
    if (match) {
      const adminId = String(match[1]);
      if (adminId === masterId) {
        await sendTelegram(env, chatId, "ℹ️ This ID is already the Master Admin.");
        return jsonResponse({ ok: true });
      }
      const admins = await getAdmins(env);
      admins[adminId] = { added_at: new Date().toISOString() };
      await saveAdmins(env, admins);
      await sendTelegram(env, chatId, `✅ Admin added\nID: ${adminId}\nCurrent prefix: ${await getKeyPrefix(env, adminId)}\n\nMaster can assign a personal prefix with:\n/setprefix ${adminId} VIP`);
      return jsonResponse({ ok: true });
    }
    match = text.match(/^\/deladmin(?:@\w+)?\s+(\d+)$/i);
    if (match) {
      const adminId = String(match[1]);
      if (adminId === masterId) {
        await sendTelegram(env, chatId, "❌ Master Admin cannot be removed.");
        return jsonResponse({ ok: true });
      }
      const admins = await getAdmins(env);
      if (!admins[adminId]) {
        await sendTelegram(env, chatId, "❌ Admin not found.");
        return jsonResponse({ ok: true });
      }
      delete admins[adminId];
      await saveAdmins(env, admins);
      await sendTelegram(env, chatId, `✅ Admin removed: ${adminId}`);
      return jsonResponse({ ok: true });
    }
  }
  match = text.match(/^\/generate(?:@\w+)?\s+(\d+)\s+(\d+)$/i);
  if (match) {
    const days = Number(match[1]);
    const devices = Number(match[2]);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      await sendTelegram(env, chatId, "❌ Days must be between 1 and 3650.");
      return jsonResponse({ ok: true });
    }
    if (!Number.isInteger(devices) || devices < 1 || devices > 1000) {
      await sendTelegram(env, chatId, "❌ Devices must be between 1 and 1000.");
      return jsonResponse({ ok: true });
    }
    if (role === "user" && devices !== 1) {
      await sendTelegram(env, chatId, "ℹ️ User keys are limited to 1 device. Send days followed by 1, e.g. 3 1.");
      return jsonResponse({ ok: true });
    }
    const cost = days * KEY_POINTS_PER_DAY;
    if (role !== "master" && Number(profile.points || 0) < cost) {
      await sendTelegram(env, chatId, `❌ Not enough points.\nRequired: ${cost} P\nYour balance: ${Number(profile.points || 0)} P\n\nInvite friends: /referral`);
      return jsonResponse({ ok: true });
    }
    let key;
    try {
      key = await generateKey(env, String(fromId), days);
    } catch (err) {
      await sendTelegram(env, chatId, `❌ Key generation failed: ${err?.message || "Unknown error"}`);
      return jsonResponse({ ok: true });
    }
    const expiry = addDaysUTC(days);
    const license = {
      type: "VIP",
      expiry,
      valid: true,
      max_devices: devices,
      SLOT: String(devices),
      created_at: new Date().toISOString(),
      created_by: String(fromId),
    };
    await env.HWID_DB.put(`${LICENSE_PREFIX}${key}`, JSON.stringify(license));
    await env.HWID_DB.delete(`${HWID_PREFIX}${key}`);
    if (role !== "master") {
      profile.points = Number(profile.points || 0) - cost;
      await saveProfile(env, String(fromId), profile);
    }
    await sendTelegram(
      env,
      chatId,
      "✅ LICENSE GENERATED\n\n" +
      `Key: ${key}\n` +
      `Type: VIP\n` +
      `Expiry: ${expiry}\n` +
      `Devices: ${devices}\n💸 Cost: ${role === "master" ? "Unlimited" : cost + " P"}\n💰 Balance: ${await balanceText(env, fromId, role)}\n\n` +
      "Copy the key into keys.txt."
    );
    return jsonResponse({ ok: true });
  }
  match = text.match(/^\/blockall(?:@\w+)?$/i);
  if (match) {
    if (!isMaster) {
      await sendTelegram(env, chatId, "⛔ Only Master Admin can block all keys.");
      return jsonResponse({ ok: true });
    }
    const all = await listLicenses(env);
    const toBlock = all.filter(item => item.license?.valid !== false);
    await Promise.all(toBlock.map(item => {
      item.license.valid = false;
      return env.HWID_DB.put(`${LICENSE_PREFIX}${item.key}`, JSON.stringify(item.license));
    }));
    await sendTelegram(env, chatId, `🛑 Blocked ${toBlock.length} key(s). All keys can be restored with Unblock All.`);
    return jsonResponse({ ok: true });
  }
  match = text.match(/^\/unblockall(?:@\w+)?$/i);
  if (match) {
    if (!isMaster) {
      await sendTelegram(env, chatId, "⛔ Only Master Admin can unblock all keys.");
      return jsonResponse({ ok: true });
    }
    const all = await listLicenses(env);
    const toUnblock = all.filter(item => item.license?.valid === false);
    await Promise.all(toUnblock.map(item => {
      item.license.valid = true;
      return env.HWID_DB.put(`${LICENSE_PREFIX}${item.key}`, JSON.stringify(item.license));
    }));
    await sendTelegram(env, chatId, `✅ Unblocked ${toUnblock.length} key(s). Expiry dates were not changed; expired keys remain expired.`);
    return jsonResponse({ ok: true });
  }
  match = text.match(/^\/unblock(?:@\w+)?\s+(.+)$/i);
  if (match) {
    const key = normalizeKey(match[1]);
    const license = await readJson(env, `${LICENSE_PREFIX}${key}`, null);
    if (!license) {
      await sendTelegram(env, chatId, "❌ Key Not Found");
      return jsonResponse({ ok: true });
    }
    if (!isMaster && String(license.created_by || "") !== String(fromId)) {
      await sendTelegram(env, chatId, "⛔ You can only unblock keys you generated.");
      return jsonResponse({ ok: true });
    }
    license.valid = true;
    await env.HWID_DB.put(`${LICENSE_PREFIX}${key}`, JSON.stringify(license));
    const expiry = parseDateEndOfDay(license.expiry);
    const expired = !expiry || Date.now() > expiry.getTime();
    await sendTelegram(env, chatId, `✅ Key unblocked:\n${key}${expired ? "\n⚠️ This key is expired; unblocking does not extend its expiry." : ""}`);
    return jsonResponse({ ok: true });
  }
  match = text.match(/^\/info(?:@\w+)?\s+(.+)$/i);
  if (match) {
    const key = normalizeKey(match[1]);
    const license = await readJson(env, `${LICENSE_PREFIX}${key}`, null);
    if (!license) {
      await sendTelegram(env, chatId, "❌ Key Not Found");
      return jsonResponse({ ok: true });
    }
    if (!isMaster && String(license.created_by || "") !== String(fromId)) {
      await sendTelegram(env, chatId, "⛔ You can only view keys you generated.");
      return jsonResponse({ ok: true });
    }
    const hwids = await readJson(env, `${HWID_PREFIX}${key}`, []);
    const used = Array.isArray(hwids) ? new Set(hwids).size : 0;
    const expiry = parseDateEndOfDay(license.expiry);
    const expired = !expiry || Date.now() > expiry.getTime();
    await sendTelegram(
      env,
      chatId,
      "ℹ️ LICENSE INFO\n\n" +
      `Key: ${key}\n` +
      `Type: ${license.type || "UNKNOWN"}\n` +
      `Valid: ${license.valid !== false ? "YES" : "NO"}\n` +
      `Expiry: ${license.expiry || "N/A"}${expired ? " (EXPIRED)" : ""}\n` +
      `Devices: ${used}/${license.max_devices || 1}`
    );
    return jsonResponse({ ok: true });
  }
  match = text.match(/^\/revoke(?:@\w+)?\s+(.+)$/i);
  if (match) {
    const key = normalizeKey(match[1]);
    const license = await readJson(env, `${LICENSE_PREFIX}${key}`, null);
    if (!license) {
      await sendTelegram(env, chatId, "❌ Key Not Found");
      return jsonResponse({ ok: true });
    }
    if (!isMaster && String(license.created_by || "") !== String(fromId)) {
      await sendTelegram(env, chatId, "⛔ You can only block keys you generated.");
      return jsonResponse({ ok: true });
    }
    license.valid = false;
    await env.HWID_DB.put(`${LICENSE_PREFIX}${key}`, JSON.stringify(license));
    await sendTelegram(env, chatId, `🚫 Key revoked:\n${key}`);
    return jsonResponse({ ok: true });
  }
  match = text.match(/^\/reset(?:@\w+)?\s+(.+)$/i);
  if (match) {
    const key = normalizeKey(match[1]);
    const license = await readJson(env, `${LICENSE_PREFIX}${key}`, null);
    if (!license) {
      await sendTelegram(env, chatId, "❌ Key Not Found");
      return jsonResponse({ ok: true });
    }
    if (!isMaster && String(license.created_by || "") !== String(fromId)) {
      await sendTelegram(env, chatId, "⛔ You can only reset keys you generated.");
      return jsonResponse({ ok: true });
    }
    await env.HWID_DB.delete(`${HWID_PREFIX}${key}`);
    await sendTelegram(env, chatId, `♻️ HWID reset:\n${key}`);
    return jsonResponse({ ok: true });
  }
  await sendTelegram(env, chatId, "❓ Unknown command. Use /help");
  return jsonResponse({ ok: true });
}
async function validateLua(request, env) {
  if (!env.HWID_DB) {
    return luaResponse("error", "KV Binding HWID_DB Missing");
  }
  try {
    const contentType = request.headers.get("Content-Type") || "";
    let userKey = "";
    let userHWID = "";
    if (contentType.includes("application/json")) {
      const body = await request.json();
      userKey = normalizeKey(body?.key);
      userHWID = normalizeHWID(body?.hwid);
    } else {
      const body = await request.text();
      const params = new URLSearchParams(body);
      userKey = normalizeKey(params.get("key"));
      userHWID = normalizeHWID(params.get("hwid"));
    }
    if (!userKey || !userHWID) {
      return luaResponse("error", "Missing Params");
    }
    const license = await readJson(env, `${LICENSE_PREFIX}${userKey}`, null);
    if (!license) {
      return luaResponse("error", "Key Not Found");
    }
    if (license.valid === false) {
      return luaResponse("error", "Key Blocked");
    }
    const expiry = parseDateEndOfDay(license.expiry);
    if (!expiry) {
      return luaResponse("error", "Invalid Expiry");
    }
    if (Date.now() > expiry.getTime()) {
      return luaResponse("error", "Key Expired");
    }
    const maxRaw = Number.parseInt(license.max_devices, 10);
    const maxDevices = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 1;
    const hwidKey = `${HWID_PREFIX}${userKey}`;
    let hwidList = await readJson(env, hwidKey, []);
    if (!Array.isArray(hwidList)) hwidList = [];
    hwidList = [...new Set(
      hwidList.map(v => String(v || "").trim()).filter(Boolean)
    )];
    if (!hwidList.includes(userHWID)) {
      if (hwidList.length >= maxDevices) {
        return luaResponse(
          "error",
          `Limit Reached (${maxDevices} Devices Only)`,
          `, limit = ${maxDevices}`
        );
      }
      hwidList.push(userHWID);
      await env.HWID_DB.put(hwidKey, JSON.stringify(hwidList));
    }
    return luaResponse(
      "success",
      "Active",
      `, limit = ${maxDevices}, type = "${String(license.type || "VIP").replace(/"/g, '\\"')}"`
    );
  } catch (err) {
    return luaResponse("error", `Server Error: ${err?.message || "Unknown Error"}`);
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return jsonResponse({
        ok: true,
        service: "VIP License Worker",
        date: todayUTC(),
      });
    }
    if (
      request.method === "POST" &&
      (url.pathname === "/webhook" || url.pathname === "/telegram")
    ) {
      return handleTelegram(request, env);
    }
    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "")) {
      return validateLua(request, env);
    }
    return luaResponse("error", "Invalid Method");
  },
};
