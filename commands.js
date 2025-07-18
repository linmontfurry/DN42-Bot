const { exec } = require('child_process');
const whois = require('whois');
const crypto = require('crypto');

// ========== 参数解析 ==========
function parseArgs() {
  const args = process.argv.slice(2);
  const result = { port: 65534, keys: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-p' && args[i + 1]) {
      result.port = Number(args[i + 1]);
      i++;
    } else if (args[i] === '--keys' && args[i + 1]) {
      result.keys = args[i + 1];
      i++;
    }
  }
  return result;
}

const { port, keys } = parseArgs();

// ========== 命令执行 ==========
function sanitizeArgs(args) {
  const safePattern = /^[a-zA-Z0-9._: "\/-]+$/;
  return args.split('').filter(arg => safePattern.test(arg)).join('');
}

function execCommand(oCmd) {
  const cmd = sanitizeArgs(oCmd);
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return stdout ? resolve(stdout) : reject(stderr || err.message);
      resolve(stdout || stderr);
    });
  });
}

// ========== 路由软件自动检测 ==========
let routingSoftware = null;
(async () => {
  try {
    await execCommand('vtysh -c "show version"');
    routingSoftware = 'frr';
  } catch {
    try {
      await execCommand('birdc show status');
      routingSoftware = 'bird';
    } catch {
      routingSoftware = null;
    }
  }
})();

function buildRouteCommand(target, type, options = {}) {
  if (routingSoftware === 'frr') {
    const proto = target.includes(':') ? 'ipv6' : 'ip';
    const portPart = options.port ? `-P ${options.port}` : '';
    return `sudo vtysh ${portPart} -c "show ${proto} ${type} ${target}"`;
  } else if (routingSoftware === 'bird') {
    const cmd = `birdc show route for ${target} all`;
    return options.port ? `BIRDC=birdc -s ${options.port} ${cmd}` : cmd;
  } else {
    throw new Error('No routing software detected.');
  }
}

// ========== 提取 AS_PATH ==========
async function extractASPaths(target, port) {
  const cmd = buildRouteCommand(target, 'bgp', { port });
  const raw = await execCommand(cmd);
  const lines = raw.split('\n');
  const asPaths = new Set();
  for (const line of lines) {
    const match = line.match(/BGP\.as_path:\s+(.*)/);
    if (match) asPaths.add(match[1].trim());
  }
  return [...asPaths].join('\n') || raw;
}

// ========== 签名验证 ==========
function verifySignature(body) {
  const { command, args, timestamp, signature, serverId } = body;
  if (!command || !args || !timestamp || !signature || !serverId) return false;
  if (!keys) return false;

  const now = Date.now();
  if (Math.abs(now - timestamp) > 5 * 60 * 1000) return false;

  const hmac = crypto.createHmac('sha256', keys);
  const data = command + JSON.stringify(args) + timestamp;
  hmac.update(data);
  const digest = hmac.digest('hex');

  return digest === signature;
}

// ========== 命令定义 ==========
const commandMap = {
  ping: (target) => execCommand(`ping -i 0.01 -c 4 -W 1 ${target}`),
  tcping: (host, port) => execCommand(`tcping ${host} ${port} -c 4`),
  trace: (target) => execCommand(`traceroute -w 0.5 -N 100 ${target}`),
  route: (target, port) => execCommand(buildRouteCommand(target, 'route', { port })),
  path: (target, port) => extractASPaths(target, port),
  whois: (query) => new Promise((resolve, reject) => {
    whois.lookup(query, { server: 'whois.lantian.dn42' }, (err, data) => {
      if (err) return reject(err.message);
      resolve(data);
    });
  }),
  dig: (domain, type = 'A') => execCommand(`dig ${domain} ${type}`),
  checkpeers: (name = '') => {
    const cmd = `birdc show protocols ${name}`;
    return execCommand(cmd);
  },
  pub_whois: (query) => new Promise((resolve, reject) => {
  whois.lookup(query, (err, data) => {
      if (err) return reject(err.message);
      resolve(data);
    });
  }),
  nslookup: (domain, type = 'A') => execCommand(`nslookup ${domain} ${type}`),
  verifySignature
};

// ========== API 启动 ==========
if (require.main === module) {
  const express = require('express');
  const app = express();

  app.use(express.json());

  app.post('/api/run', async (req, res) => {
    const { command, args, serverId } = req.body;
    if (!serverId) return res.status(400).send('Missing serverId');
    if (!verifySignature(req.body)) return res.status(403).send('Forbidden: Invalid signature or timestamp');

    try {
      const handler = commandMap[command];
      if (!handler) return res.status(400).send('Invalid command');
      const result = await handler(...args);
      res.type('text/plain').send(result);
    } catch (e) {
      res.status(500).send(e.toString());
    }
  });

  app.listen(port, () => {
    console.log(`[Runner] Listening on port ${port}`);
    if (keys) console.log(`[Runner] Signature mode enabled with key: ${keys}`);
    else console.log(`[Runner] Signature mode disabled`);
  });
}

// ========== 导出 ==========
module.exports = commandMap;
