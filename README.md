# DN42-Bot

🛰️ 一个多功能简易的 Telegram BGP Bot，适用于 公网/DN42 网络场景下的自动测试、网络监控与运维交互。

## 特性

- 支持 BGP 网络测试命令（如 ping, tcping, whois, dig 等）
- 支持多后端并支持分页切换与隐藏后端配置
- 支持 `/checkflap` 实时查看 Flap 状态并自动高 Flap 通知 (1.0.7-dev1)
- 支持 `/pub_whois` 和 `/nslookup` 等公网网络查询命令
- 基于 Node.js + Telegram Bot API 构建，部署简单，轻量快速

## 命令示例

| 命令 | 说明 |
|------|------|
| `/start` | *发出了神秘的怪叫声* |
| `/help` | 查看 Bot 可用命令 |
| `/ping example.com` | 测试 ping |
| `/tcping example.com 443` | TCP 端口探测 |
| `/trace example.com` | Trace 数据包通向 |
| `/path 1.1.1.1` | 查看 BGP Path |
| `/route 1.1.1.1` | 查看 BGP 路由 |
| `/whois 1.1.1.1` | 面向DN42网内的 Whois |
| `/pub_whois 1.1.1.1` | 公网 Whois |
| `/nslookup example.com` | Nslookup DNS 查询 |
| `/dig example.com` | Dig DNS 查询 |
| `/flap` | 实时 Flap 监控 (1.0.7-dev1) |

## 配置说明

### 主端
需要创建 `config.yaml` 配置，包括服务器后端、隐藏控制、flap 监控后端等信息，可前往本项目的 `config.yaml.example` 查看相关信息

需要安装下列nodejs依赖才可运行本bot

Bot 端单独运行依赖

```
npm install node-fetch-cjs js-yaml node-telegram-bot-api chalk
```

运行 Bot

```
node index.js
```

### 后端
后端 Commands 单独运行依赖

```
npm install whois crypto
```

Bot 的部署阶段必须要与 `commands.js` 一起部署（默认后端参数调用离不开）

但是在其他机器上可单独部署 `commands.js` 作为后端使用

默认情况下直接运行 `commands.js` 没有密码，端口将会自动监听`0.0.0.0:65534`端口

`commands.js` 可用参数args有

```
--keys <str> 密码
--port <portnum> 端口
```

通过 `node commands.js --keys <str> --port <portnum>` 可直接启动后端

后端http页面可进行反代操作来避免当地网络拦截，因此若要直接安装部署的后端，请辨别config.yaml是否需要在末尾url处加入`/api/run`方便调用

## 鸣谢

本项目部分功能使用/参考并基于以下开源项目开发修改：

- [`DN42-LG-Bot by charlie-moomoo`](https://github.com/charlie-moomoo/DN42-LG-Bot) - Provide basic calling template.
- [`node-fetch-cjs`](https://www.npmjs.com/package/node-fetch-cjs) - Fetch API for CommonJS environments
- [`js-yaml`](https://www.npmjs.com/package/js-yaml) - YAML configuration file parser
- [`node-telegram-bot-api`](https://www.npmjs.com/package/node-telegram-bot-api) - Telegram Bot SDK
- [`chalk`](https://www.npmjs.com/package/chalk) - Colorful terminal output
- [`whois`](https://www.npmjs.com/package/whois) - WHOIS client
- [`Lan Tian Whois`](whois.lantian.dn42) - Dn42 Version Of WHOIS Query Provider

感谢这些项目/依赖/api提供的数据处理与代码结构构建灵感。
