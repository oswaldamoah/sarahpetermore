// Links YOUR WhatsApp to SarahPetermore, the same way WhatsApp Web does — free, no business account.
//
//   npm run whatsapp                 → shows a QR code: WhatsApp on your phone → Linked devices → Link a device
//   npm run whatsapp -- --relink     → forget the current link and show a new code
//   npm run whatsapp -- --code 233505690386   → gives an 8-character code instead of a QR
//
// Keep this window open: while it runs, orders arrive in your "Message yourself" chat and customers get AI replies.
// In any group (or chat), type "/alerts here" to also post every new order there ("/alerts off" to stop).
// Settings (in web/.env, all optional):
//   WA_AI_MODE=customers   customers (default): replies only to people asking about products/orders, or who already ordered
//                          everyone: replies to every private chat · off: alerts only, never replies
//   WA_NOTIFY_SELF=true    send alerts to your own "Message yourself" chat (default true)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Load web/.env before anything reads process.env
try {
  for (const line of readFileSync(join(here, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { console.log('No web/.env found — using the environment as is.'); }

const args = process.argv.slice(2);
const pairNumber = args.includes('--code') ? (args[args.indexOf('--code') + 1] ?? '').replace(/\D/g, '').replace(/^0(?=\d{9}$)/, '233') : '';
if (args.includes('--relink')) rmSync(join(here, '.auth'), { recursive: true, force: true });
const aiMode = (['off', 'customers', 'everyone'].includes(process.env.WA_AI_MODE ?? '') ? process.env.WA_AI_MODE : 'customers') as 'off' | 'customers' | 'everyone';
const notifySelf = process.env.WA_NOTIFY_SELF !== 'false';

const baileys = await import('@whiskeysockets/baileys');
const makeWASocket = (baileys.default ?? (baileys as any).makeWASocket) as typeof baileys.makeWASocket;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser, isJidGroup, isJidBroadcast } = baileys;
const pino = (await import('pino')).default;
const qrTerminal = (await import('qrcode-terminal')).default;
const QR = (await import('qrcode')).default;
const { q } = await import('../api/_lib/db.js');
const { createCore } = await import('./core.js');

const AUTH = join(here, '.auth');
const stamp = () => new Date().toLocaleTimeString();
const log = (m: string) => console.log(`[${stamp()}] ${m}`);

let sock: ReturnType<typeof makeWASocket> | null = null;
let me: string | null = null;
let meLid: string | null = null;
let connected = false;

async function status(extra: Record<string, unknown> = {}) {
  const value = { connected, number: me?.split('@')[0] ?? null, ai_mode: aiMode, notify_self: notifySelf, updated_at: new Date().toISOString(), ...extra };
  await q(`insert into system_settings(key, value, is_public, updated_at) values ('whatsapp_link', $1::jsonb, false, now())
           on conflict (key) do update set value = excluded.value, updated_at = now()`, [JSON.stringify(value)]).catch(() => null);
}

const core = createCore({
  send: async (jid, text) => (await sock!.sendMessage(jid, { text }))?.key?.id ?? undefined,
  resolve: async (num) => {
    const [r] = (await sock!.onWhatsApp(`${num}@s.whatsapp.net`)) ?? [];
    return r?.exists ? jidNormalizedUser(r.jid) : null;
  },
  typing: async (jid, on) => { await sock!.sendPresenceUpdate(on ? 'composing' : 'paused', jid); },
  read: async (key) => { await sock!.readMessages([key as any]); },
  remove: async (jid, key) => { await sock!.sendMessage(jid, { delete: key as any }); },
}, { me: () => me, aiMode, notifySelf, stateFile: join(here, 'chats.json'), log });

let slowTimer: NodeJS.Timeout | undefined;
async function start() {
  log('Connecting to WhatsApp…');
  clearTimeout(slowTimer);
  slowTimer = setTimeout(() => { if (!connected) log('Still connecting. Check your internet connection; this window keeps trying.'); }, 30_000);
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined as any }));
  sock = makeWASocket({
    auth: state, version, logger: pino({ level: 'silent' }) as any,
    browser: ['SarahPetermore', 'Chrome', '1.0'],
    markOnlineOnConnect: false,    // your phone keeps getting notifications as normal
    syncFullHistory: false,
  });
  sock.ev.on('creds.update', saveCreds);

  if (pairNumber && !state.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock!.requestPairingCode(pairNumber);
        log(`Your link code: ${code.match(/.{1,4}/g)?.join('-')}`);
        log('On your phone: WhatsApp → Settings → Linked devices → Link a device → "Link with phone number instead", then type the code.');
      } catch (e) { log(`Could not get a code: ${(e as Error).message}`); }
    }, 2500);
  }

  sock.ev.on('connection.update', async (u) => {
    if (u.qr && !pairNumber) {
      clearTimeout(slowTimer);
      console.clear();
      log('Scan this with WhatsApp on your phone: Settings → Linked devices → Link a device');
      qrTerminal.generate(u.qr, { small: true });
      await QR.toFile(join(here, 'scan-me.png'), u.qr, { width: 420 }).catch(() => null);
      log(`If the code above looks broken, open ${join(here, 'scan-me.png')} and scan that instead.`);
    }
    if (u.connection === 'open') {
      connected = true;
      me = jidNormalizedUser(sock!.user!.id);
      meLid = (sock!.user as any)?.lid ? jidNormalizedUser((sock!.user as any).lid) : null;
      log(`✅ Linked as +${me.split('@')[0]}. Orders will arrive in your "Message yourself" chat. AI replies: ${aiMode}.`);
      log('Leave this window open. Close it (Ctrl + C) to stop.');
      await status();
    }
    if (u.connection === 'close') {
      connected = false;
      const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
      await status({ last_error: code ?? null });
      if (code === DisconnectReason.loggedOut) {
        // The old link is no longer valid: clear it and show a fresh code automatically
        log('That link has ended. Clearing it and showing a new code to scan…');
        rmSync(AUTH, { recursive: true, force: true });
        setTimeout(() => { void start(); }, 2000);
        return;
      }
      log('Connection dropped — reconnecting…');
      setTimeout(() => { void start(); }, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      const jid = m.key.remoteJid;
      if (!jid || !m.message || isJidBroadcast(jid) || jid.endsWith('@newsletter')) continue;
      const group = !!isJidGroup(jid);
      if (group && !m.key.fromMe) continue; // in groups we only listen for your own "/alerts here" command
      const msg = m.message as any;
      const text = String(msg.conversation ?? msg.extendedTextMessage?.text ?? msg.imageMessage?.caption ?? '').trim();
      const norm = jidNormalizedUser(jid);
      const alt = (m.key as any).remoteJidAlt as string | undefined;
      const phoneJid = norm.endsWith('@s.whatsapp.net') ? norm : alt?.endsWith('@s.whatsapp.net') ? alt : null;
      core.onMessage({
        jid, id: m.key.id ?? '', fromMe: !!m.key.fromMe, text, key: m.key,
        isSelf: norm === me || (!!meLid && norm === meLid), isGroup: group,
        phone: phoneJid ? `+${phoneJid.split('@')[0]}` : null,
      }).catch((e) => log(`reply failed: ${(e as Error).message}`));
    }
  });
}

// Alerts: check for new orders every 8 seconds; heartbeat for the admin page every minute
setInterval(() => { if (connected) core.alertsTick().catch((e) => log(`alerts: ${(e as Error).message}`)); }, 8_000);
setInterval(() => { if (connected) void status(); }, 60_000);
process.on('SIGINT', async () => { connected = false; await status(); log('Stopped.'); process.exit(0); });
mkdirSync(here, { recursive: true });
writeFileSync(join(here, '.gitignore'), '.auth/\nscan-me.png\nchats.json\n');
await start();
