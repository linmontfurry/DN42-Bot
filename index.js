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
const botusername = config.botusername;
const suffixPattern = botusername ? `(?:@${botusername}(?=\\s|$))?` : '';
const bot = new TelegramBot(token, { polling: true });

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
  { command: 'version', description: 'Bot version info' }
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

bot.onText(new RegExp(`^\\/(ping|tcping|trace|route|path|whois|dig)${suffixPattern}( .+)?$`), async (msg, match) => {
  const chatId = msg.chat.id;
  const command = match[1];
  const args = (match[2] || '').trim().split(/\s+/).filter(Boolean);
  const user = { id: msg.from.id, name: msg.from.username || msg.from.first_name };

  logAction('Command', {
    user,
    extra: `Used /${command} ${args.join(' ')}`
  });

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
