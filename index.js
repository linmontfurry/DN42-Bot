const path = require('path');
const { default: fetch } = require('node-fetch-cjs');
const fs = require('fs');
const yaml = require('js-yaml');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const exec = require('child_process').exec;
const chalk = require('chalk');

function formatTime() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function logAction(action, data = {}) {
  const time = chalk.gray(`[${formatTime()}]`);
  const tag = chalk.cyanBright(`[${action}]`);
  const user = data.user ? chalk.yellow(`${data.user.name}(${data.user.id})`) : chalk.dim('Unknown User');
  const ip = data.ip ? chalk.magenta(`IP: ${data.ip}`) : '';
  const extra = data.extra ? chalk.white(data.extra) : '';
  console.log(`${time} ${tag} ${user} ${ip} ${extra}`);
}

function loadConfig(file = './config.yaml') {
  try {
    const configPath = path.resolve(__dirname, file);
    const text = fs.readFileSync(configPath, 'utf8');
    return yaml.load(text);
  } catch (err) {
    console.error('Failed to load config.yaml:', err.message);
    process.exit(1);
  }
}

const localCommands = require('./commands');
const config = loadConfig();
const defaultid = config.default;
const SERVERS = config.servers;
const token = config.token;
const flapnum = config.flapalerted.flapednum;
const botusername = config.botusername;
const suffixPattern = botusername ? `(?:@${botusername}(?=\\s|$))?` : '';
const bot = new TelegramBot(token, { polling: true });
let lastAlertTime = 0;

const commandHandlers = {
  ping: true,
  tcping: true,
  trace: true,
  route: true,
  path: true,
  whois: true,
  dig: true,
  pub_whois: true,
  nslookup: true
};

let botVersion = 'unknown';
try {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));
  botVersion = pkg.version || 'unknown';
} catch {}

function getGitCommitHash() {
  return new Promise((resolve) => {
    exec('git rev-parse --short HEAD', { cwd: __dirname }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim());
    });
  });
}

async function monitorFlap() {
  const flapCfg = config.flapalerted;
  if (!flapCfg) return;

  const proto = flapCfg.https ? 'https' : 'http';
  const baseUrl = `${proto}://${flapCfg.url}`;
  const noticeId = flapCfg.notice;

  try {
    const res = await fetch(`${baseUrl}/flaps/metrics/json`);
    const data = await res.json();
    const changes = parseFloat(data.AverageRouteChanges90);

    if (changes >= flapnum && Date.now() - lastAlertTime > 5 * 60 * 1000) {
      lastAlertTime = Date.now();
      const alertMessage = `⚠️ *Route Flapping!*\n\n` +
        `${flapCfg.name} Monitored a large number of Average Route Changes\n` +
        `Average Route Changes (90s): *${changes}*`;

      await bot.sendMessage(noticeId, alertMessage, { parse_mode: 'Markdown' });
      logAction('FlapAlert', { extra: `Noticed ${noticeId}` });
    }
  } catch (err) {
    console.error("Flap monitoring failed:", err.message);
  }
}

bot.setMyCommands([
  { command: 'start', description: 'Nya!' },
  { command: 'help', description: 'Show command usage' },
  { command: 'ping', description: 'Ping IP/domain' },
  { command: 'tcping', description: 'TCP Ping' },
  { command: 'trace', description: 'Traceroute' },
  { command: 'route', description: 'Show route info' },
  { command: 'path', description: 'Show AS path' },
  { command: 'whois', description: 'Whois lookup' },
  { command: 'dig', description: 'DNS query' },
  { command: 'peer', description: 'Get Peering info' },
  { command: 'pub_whois', description: 'ClearNet Whois lookup' },
  { command: 'nslookup', description: 'Nslookup DNS query' },
  { command: 'version', description: 'Bot version info' },
  { command: 'activeflaps', description: 'Get Active ip cidr' },
  { command: 'historyflaps', description: 'Get flapping update history' },
  { command: 'flap', description: 'Get AS Average Route Changes' }
], { scope: { type: 'default' } }).then(() => {
  console.log("✅ Commands registered with Telegram.");
}).catch(err => {
  console.error("❌ Failed to register commands:", err.message);
});

const groupCommandSupport = new Map();

bot.on('message', (msg) => {
  const chatId = msg.chat.id;

  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    if (!groupCommandSupport.has(chatId)) {
      groupCommandSupport.set(chatId, { lastCheck: 0, supportBareCommand: false });
    }

    if (/^\/(ping|tcping|trace|route|path|whois|dig|start|help|peer|version|nslookup|pub_whois)(\s|$)/.test(msg.text)) {
      const state = groupCommandSupport.get(chatId);
      state.supportBareCommand = true;
    }
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [chatId, info] of groupCommandSupport.entries()) {
    if (now - info.lastCheck > 5 * 60 * 1000) {
      info.lastCheck = now;
      info.supportBareCommand = false;
    }
  }
  monitorFlap()
}, 60 * 1000);

function generateServerButtons(command, args, currentServer, page = 0) {
  const servers = Object.values(SERVERS);
  const pageSize = 3;
  const totalPages = Math.ceil(servers.length / pageSize);
  const pageStart = page * pageSize;
  const pageServers = servers.slice(pageStart, pageStart + pageSize);

  const argStr = Buffer.from(JSON.stringify(args)).toString('base64');

  const serverButtons = pageServers.map(server => [{
    text: `${server.id === currentServer ? '✅ ' : ''}${server.name}`,
    callback_data: `select|${command}|${server.id}|${page}|${argStr}`
  }]);

  const paginationButtons = [{
    text: page > 0 ? '⬅️' : ' ',
    callback_data: page > 0 ? `page|${command}|${pageServers[0]?.id || currentServer}|${page - 1}|${argStr}` : 'ignore'
  }, {
    text: `Page ${page + 1}/${totalPages}`,
    callback_data: 'ignore'
  }, {
    text: page < totalPages - 1 ? '➡️' : ' ',
    callback_data: page < totalPages - 1 ? `page|${command}|${pageServers[0]?.id || currentServer}|${page + 1}|${argStr}` : 'ignore'
  }];

  return {
    reply_markup: {
      inline_keyboard: [
        ...serverButtons,
        paginationButtons
      ]
    }
  };
}

function getServerIdByPage(page = 0) {
  const servers = Object.values(SERVERS);
  const pageSize = 3;
  const pageStart = page * pageSize;
  const pageServers = servers.slice(pageStart, pageStart + pageSize);
  return pageServers.length > 0 ? pageServers[0].id : null;
}

function formatDuration(seconds) {
  const days = Math.floor(seconds / (3600 * 24));
  seconds %= 3600 * 24;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}


async function runCommandOnServer(serverId, command, args, user = null) {
  if (serverId === defaultid) {
    logAction('LocalExec', {
      user,
      extra: `Command: ${command} Args: ${args.join(' ')}`
    });
    return localCommands[command](...args);
  }

  const server = SERVERS[serverId];
  if (!server) throw new Error(`Server with id "${serverId}" not found`);
  if (!server.url) throw new Error(`Server url for "${serverId}" not defined`);

  const secret = server.secret;
  let body = { command, args };
  if (secret && typeof secret === 'string' && secret.length > 0) {
    const timestamp = Date.now();
    const hmac = crypto.createHmac('sha256', secret);
    const data = command + JSON.stringify(args) + timestamp;
    hmac.update(data);
    const signature = hmac.digest('hex');
    body = { ...body, timestamp, signature, serverId };
  } else {
    body.serverId = serverId;
  }

  const res = await fetch(server.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 200) return await res.text();
  else throw new Error(await res.text());
}

bot.onText(new RegExp(`^\\/version${suffixPattern}$`), async (msg) => {
  const chatId = msg.chat.id;
  const nodeVersion = process.version;
  const gitHash = await getGitCommitHash();

  logAction('Command', {
    user: { id: msg.from.id, name: msg.from.username || msg.from.first_name },
    extra: `Used /version`
  });

  let text = `Bot Version: ${botVersion}\n`;
  text += `Node.js Version: ${nodeVersion}\n`;
  text += gitHash ? `Git Commit: \`${gitHash}\`` : `Git Commit: Not available`;

  bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_to_message_id: msg.message_id
  });
});

bot.onText(new RegExp(`^\\/(start|help|peer)${suffixPattern}$`), async (msg, match) => {
  const command = match[1];
  const chatId = msg.chat.id;
  const user = { id: msg.from.id, name: msg.from.username || msg.from.first_name };

  logAction('Command', {
    user,
    extra: `Used /${command}`
  });

  if (command === 'start') {
    return bot.sendMessage(chatId, 'Nya!', {
      parse_mode: 'Markdown',
      reply_to_message_id: msg.message_id
    });
  }

  if (command === 'help') {
    return bot.sendMessage(chatId, `Nya~!!
\Here is **Command usage:**
\`/start\` Nya!
\`/help\` Show available commands  
\`/ping [ip/domain]\` Ping 
\`/tcping [ip/domain]\` TCPing
\`/trace [ip/domain]\` Traceroute  
\`/route [ip]\` Show route  
\`/path [ip]\` Show AS path  
\`/whois [something]\` Whois
\`/pub_whois [someting]\` Public ClearNet Whois
\`/nslookup [domain]\` Nslookup Test
\`/dig [domain] {type}\` Resolve domain
\`/flap\` Get AS Average Route Changes
\`/activeflaps\` Get Active Flapping Routes
\`/historyflaps [cidr]\` Get flapping update history
\`/peer\` Let's Make a Peer?`, {
      parse_mode: 'Markdown',
      reply_to_message_id: msg.message_id
    });
  }

  if (command === 'peer') {
    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, "❌ Please use this command in a private chat.", {
        reply_to_message_id: msg.message_id
      });
    }

    return bot.sendMessage(chatId,
      `If you want to peer with me\n` +
      `You can contact me on Telegram!\n\n` +
      `But unfortunately, due to Node.js-related limitations and\n` +
      `uncontrollability, I cannot build an auto-peer system/command\n` +
      `to help us quickly process peer requests.\n\n` +
      `If you want to know some information, please go to:\n` +
      `\`https://t.me/lmfur/20\`\n\n` +
      `Always happy to peer with you!\n\n` +
      `Telegram: @bvhsh\n` +
      `Email: \`admin@furry.blue\``,
      {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
      }
    );
  }
});

bot.onText(new RegExp(`^\\/activeflaps${suffixPattern}$`), async (msg) => {
  const chatId = msg.chat.id;
  const user = { id: msg.from.id, name: msg.from.username || msg.from.first_name };

  logAction('Command', {
    user,
    extra: `Used /activeflaps`
  });

  const flapCfg = config.flapalerted;
  if (!flapCfg) {
    return bot.sendMessage(chatId, `❌ flapalerted config lost`, {
      reply_to_message_id: msg.message_id
    });
  }

  const proto = flapCfg.https ? 'https' : 'http';
  const baseUrl = `${proto}://${flapCfg.url}`;

  try {
    const [verRes, flapList, roaJson] = await Promise.all([
      fetch(`${baseUrl}/capabilities`).then(r => r.json()),
      fetch(`${baseUrl}/flaps/active/compact`).then(r => r.json()),
      fetch('https://dn42.burble.com/roa/dn42_roa_46.json').then(r => r.json())
    ]);

    const version = verRes.Version || 'Unknown';
    if (!Array.isArray(flapList)) throw new Error("Invalid flap list format");
    if (!Array.isArray(roaJson.roas)) throw new Error("Invalid ROA data");

    const roaMap = new Map();
    roaJson.roas.forEach(roa => {
      roaMap.set(roa.prefix, roa.asn);
    });

    function normalizePrefix(pfx) {
      if (pfx.includes(':')) {
        return pfx.replace(/^((?:[a-f0-9]{1,4}:){3}).*$/, '$1::/48');
      }
      return pfx;
    }

    const now = Math.floor(Date.now() / 1000);
    const topFlaps = flapList
      .sort((a, b) => b.TotalCount - a.TotalCount)
      .slice(0, 10);

    const lines = topFlaps.map(f => {
      const prefix = f.Prefix;
      const normPrefix = normalizePrefix(prefix);
      const asn = roaMap.get(prefix) || roaMap.get(normPrefix) || '❓Unknown';

      const duration = f.LastSeen && f.FirstSeen ? (f.LastSeen - f.FirstSeen) : 0;
      const lastSeenAgo = now - (f.LastSeen || now);

      const durationStr = formatDuration(duration);
      const agoStr = formatDuration(lastSeenAgo);

      const encodedPrefix = encodeURIComponent(prefix);
      const analyzeUrl = `${proto}://${flapCfg.url}/analyze/?prefix=${encodedPrefix}`;
      return `• [${prefix}](${analyzeUrl})  (ASN: \`${asn}\`, Count: ${f.TotalCount}  Duration: ${durationStr}, Last Seen: ${agoStr} ago)`;;
    });

    const message = `*Top 10 Active Route Flaps*\n\n` +
      `${flapCfg.name} (${version})\n\n` +
      lines.join('\n');

    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_to_message_id: msg.message_id
    });

  } catch (err) {
    bot.sendMessage(chatId, `❌ Get Active Flap Data Failed: ${err.message}`, {
      reply_to_message_id: msg.message_id
    });
  }
});

bot.onText(new RegExp(`^\\/(ping|tcping|trace|route|path|whois|dig)${suffixPattern}( .+)?$`), async (msg, match) => {
  const chatId = msg.chat.id;
  const command = match[1];
  const args = (match[2] || '').trim().split(/\s+/).filter(Boolean);
  const user = { id: msg.from.id, name: msg.from.username || msg.from.first_name };

  logAction('Command', {
    user,
    extra: `Used /${command} ${args.join(' ')}`
  });

  if (args.length === 0) {
    return bot.sendMessage(chatId, `❌ Usage: /${command} <target>\nExample: /${command} ip/cidr/domain`, {
      reply_to_message_id: msg.message_id
    });
  }

  bot.sendChatAction(chatId, 'typing');

  try {
    const output = await runCommandOnServer(defaultid, command, args, user);
    const limitedOutput = output.slice(0, 4000);
    bot.sendMessage(chatId, `\`\`\`${defaultid}\n${limitedOutput}\n\`\`\``, {
      parse_mode: 'Markdown',
      reply_to_message_id: msg.message_id,
      ...(["whois", "dig"].includes(command) ? {} : generateServerButtons(command, args, defaultid, 0))
    });
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.toString().split("\n")[0]}`, {
      reply_to_message_id: msg.message_id
    });
  }
});

bot.onText(new RegExp(`^\\/(pub_whois|nslookup)${suffixPattern}( .+)?$`), async (msg, match) => {
  const chatId = msg.chat.id;
  const command = match[1];
  const args = (match[2] || '').trim().split(/\s+/).filter(Boolean);
  const user = { id: msg.from.id, name: msg.from.username || msg.from.first_name };

  logAction('Command', {
    user,
    extra: `Used /${command} ${args.join(' ')}`
  });

  bot.sendChatAction(chatId, 'typing');

  if (args.length === 0) {
    return bot.sendMessage(chatId, `❌ Usage: /${command} <target>\nExample: /${command} domain`, {
      reply_to_message_id: msg.message_id
    });
  }

  try {
    const output = await runCommandOnServer(defaultid, command, args, user);
    const limitedOutput = output.slice(0, 4000);
    bot.sendMessage(chatId, `\`\`\`${defaultid}\n${limitedOutput}\n\`\`\``, {
      parse_mode: 'Markdown',
      reply_to_message_id: msg.message_id
    });
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.toString().split("\n")[0]}`, {
      reply_to_message_id: msg.message_id
    });
  }
});

bot.onText(new RegExp(`^\\/flap${suffixPattern}$`), async (msg) => {
  const chatId = msg.chat.id;
  const user = { id: msg.from.id, name: msg.from.username || msg.from.first_name };

  logAction('Command', {
    user,
    extra: `Used /flap`
  });

  const flapCfg = config.flapalerted;
  if (!flapCfg) {
    return bot.sendMessage(chatId, `❌ flapalerted config lost`, {
      reply_to_message_id: msg.message_id
    });
  }

  const proto = flapCfg.https ? 'https' : 'http';
  const baseUrl = `${proto}://${flapCfg.url}`;

  try {
    const [verRes, flapRes] = await Promise.all([
      fetch(`${baseUrl}/capabilities`).then(r => r.json()),
      fetch(`${baseUrl}/flaps/metrics/json`).then(r => r.json())
    ]);

    const version = verRes.Version || 'Unknown';
    const {
      ActiveFlapCount,
      ActiveFlapTotalPathChangeCount,
      AverageRouteChanges90,
      Sessions
    } = flapRes;

    const message = `*FlapAlerted Live Data*\n\n` +
      `${flapCfg.name} (${version})\n` +
      `Active Flap Count: ${ActiveFlapCount}\n` +
      `Active Flap Total Path Change Count: ${ActiveFlapTotalPathChangeCount}\n` +
      `Average Route Changes: ${AverageRouteChanges90}\n` +
      `Connected BGP Feeds: ${Sessions}`;

    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_to_message_id: msg.message_id
    });

  } catch (err) {
    bot.sendMessage(chatId, `❌ Get Data Failed:${err.message}`, {
      reply_to_message_id: msg.message_id
    });
  }
});

bot.onText(new RegExp(`^\\/historyflaps${suffixPattern}(?:\\s+(.+))?$`), async (msg, match) => {
  const chatId = msg.chat.id;
  const cidr = (match[1] || '').trim();
  const user = { id: msg.from.id, name: msg.from.username || msg.from.first_name };

  logAction('Command', {
    user,
    extra: `Used /historyflaps ${cidr || '(no argument)'}`
  });

  if (!cidr) {
    return bot.sendMessage(chatId,
      `❌ Usage: \`/historyflaps <CIDR>\`\nExample: \`/historyflaps fdcc:abcd:cafe::/48\``, {
      parse_mode: 'Markdown',
      reply_to_message_id: msg.message_id
    });
  }

  const flapCfg = config.flapalerted;
  if (!flapCfg) {
    return bot.sendMessage(chatId, `❌ flapalerted config lost`, {
      reply_to_message_id: msg.message_id
    });
  }

  const proto = flapCfg.https ? 'https' : 'http';
  const baseUrl = `${proto}://${flapCfg.url}`;
  const encodedCIDR = encodeURIComponent(cidr);

  try {
    const res = await fetch(`${baseUrl}/flaps/active/history?cidr=${encodedCIDR}`);
    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) {
      return bot.sendMessage(chatId, `❌ No flap history found for \`${cidr}\``, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const firstSeen = now - data.length * 10;
    const firstSeenStr = new Date(firstSeen * 1000).toISOString().replace('T', ' ').replace('Z', '');
    const nowStr = new Date(now * 1000).toISOString().replace('T', ' ').replace('Z', '');
    const preview = data.slice(-25).join(',');

    const message = `*Here is the 1000s update history for* \`${cidr}\`\n\n` +
      `First Seen: ${firstSeenStr}\n` +
      `Query Time: ${nowStr}\n\n` +
      `\`\`\`${preview}\`\`\``;

    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_to_message_id: msg.message_id
    });

  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to fetch history: ${err.message}`, {
      reply_to_message_id: msg.message_id
    });
  }
});

bot.on("callback_query", async (cbq) => {
  if (cbq.data === 'ignore') return bot.answerCallbackQuery(cbq.id);
  const chatId = cbq.message.chat.id;
  const messageId = cbq.message.message_id;
  const user = { id: cbq.from.id, name: cbq.from.username || cbq.from.first_name };

  const [type, command, server, pageStr, argBase64] = cbq.data.split('|');
  if (!commandHandlers[command]) return;

  logAction('Button', {
    user,
    extra: `Clicked ${type.toUpperCase()} on /${command} with server=${server}`
  });

  const page = parseInt(pageStr, 10) || 0;
  const args = JSON.parse(Buffer.from(argBase64, 'base64').toString());

  let serverId = server;
  if (type === 'page') {
    const firstServerId = getServerIdByPage(page);
    if (firstServerId) serverId = firstServerId;
  }

  let text = '';
  let options = {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown'
  };

  try {
    const output = await runCommandOnServer(serverId, command, args, user);
    const limitedOutput = output.slice(0, 4000);
    text = `\`\`\`${serverId}\n${limitedOutput}\n\`\`\``;
    if (!['whois', 'dig'].includes(command)) {
      options = { ...options, ...generateServerButtons(command, args, serverId, page) };
    }
  } catch (err) {
    text = `\`\`\`${serverId}\n❌ ${err.message.split("\n")[0]}\n\`\`\``;
    options = { ...options, ...generateServerButtons(command, args, serverId, page) };
  }

  await bot.editMessageText(text, options).catch(() => {});
  bot.answerCallbackQuery(cbq.id);
});

bot.on("polling_error", (e) => console.error("Polling error:", e));
process.on("uncaughtException", console.error);
