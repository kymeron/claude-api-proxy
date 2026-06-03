/**
 * HTTP 服务器核心逻辑
 * 支持 WebSocket 升级，将 WS 连接路由到对应的 Responses API WS 处理器
 * @module server
 */

import http from 'http';
import {URL} from 'url';
import {WebSocketServer} from 'ws';
import logger from './utils/logger.js';
import {routeCopilotRequest, handleCopilotResponsesWS} from './routes/copilot.js';
import {routeCopilotFrontend} from './routes/copilot-frontend.js';
import {routeCodebuddyRequest, handleCodebuddyResponsesWS} from './routes/codebuddy.js';
import {routeCodebuddyFrontend} from './routes/codebuddy-frontend.js';
import {routeRelayRequest, handleRelayResponsesWS} from './routes/relay.js';
import {routeRelayFrontend} from './routes/relay-frontend.js';
import {
    serveLoginPage,
    getPublicKeyEndpoint,
    handleLoginRequest,
    handleLogoutRequest,
    requireAdminAuth,
    requireGatewayAuth
} from './services/gateway/admin-auth.js';
import {isGatewayAuthEnabled, verifyGatewayToken, reloadGatewayToken} from './services/gateway/auth.js';
import {copilotState} from './services/copilot/state.js';
import {copilotStore} from './services/copilot/copilot-store.js';
import {credentialStore} from './services/codebuddy/credential-store.js';
import {relayStore} from './services/relay/relay-store.js';

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
    res.writeHead(status, {'Content-Type': 'text/plain'});
    res.end(message);
}

/**
 * 渲染 404 页面（HTML 给浏览器，JSON 给 API 客户端）
 */
function send404(req, res) {
    const accept = String(req.headers['accept'] || '');
    const wantsHtml = accept.includes('text/html');
    if (!wantsHtml) {
        res.writeHead(404, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'Not found', path: req.url}));
        return;
    }
    const safePath = String(req.url || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 - Claude API Proxy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #e6edf3; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { max-width: 520px; width: 100%; padding: 48px 24px; text-align: center; }
    .code { font-size: 6rem; font-weight: 800; color: #58a6ff; line-height: 1; letter-spacing: -2px; }
    h1 { font-size: 1.5rem; font-weight: 700; margin: 16px 0 8px; color: #f0f6fc; }
    .desc { color: #8b949e; margin-bottom: 8px; font-size: 0.95rem; }
    .path { display: inline-block; margin: 16px 0 32px; padding: 6px 12px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; color: #79c0ff; font-family: 'SFMono-Regular', Consolas, monospace; font-size: 0.85rem; word-break: break-all; max-width: 100%; }
    .home-btn { display: inline-block; padding: 10px 20px; background: #238636; border: 1px solid #2ea043; border-radius: 8px; color: #ffffff; text-decoration: none; font-size: 0.9rem; font-weight: 500; transition: background 0.2s; }
    .home-btn:hover { background: #2ea043; }
  </style>
</head>
<body>
  <div class="container">
    <div class="code">404</div>
    <h1>页面不存在</h1>
    <p class="desc">您访问的路径不在已注册的路由中</p>
    <div class="path">${safePath}</div>
    <div>
      <a class="home-btn" href="/">返回首页</a>
    </div>
  </div>
</body>
</html>`;
    res.writeHead(404, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(html);
}

/**
 * WS 鉴权：检查网关令牌
 * WS 握手时支持以下方式传递令牌：
 * 1. Authorization: Bearer <token> header（随 upgrade 请求发送）
 * 2. api_key URL 参数：?api_key=<token>
 */
function requireGatewayAuthWS(req) {
    if (!isGatewayAuthEnabled()) {
        req._gatewayAuthenticated = true;
        return true;
    }

    // 从 URL 参数获取
    const url = new URL(req.url, `http://${req.headers.host}`);
    const apiKeyParam = url.searchParams.get('api_key');
    if (apiKeyParam && verifyGatewayToken(apiKeyParam)) {
        req._gatewayAuthenticated = true;
        return true;
    }

    // 从 Authorization header 获取
    const auth = req.headers['authorization'];
    if (auth) {
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
        if (verifyGatewayToken(token)) {
            req._gatewayAuthenticated = true;
            return true;
        }
    }

    return false;
}

/**
 * 处理从其他 worker 接收的广播事件
 * @param {object} data - {type: string, sourcePort: number, ...}
 */
function handleBroadcastEvent(data) {
    const {type} = data;
    logger.debug(`Broadcast received: ${type} from worker port ${data.sourcePort}`);

    switch (type) {
        // Gateway
        case 'gateway-token-regenerated':
            reloadGatewayToken();
            break;

        // Copilot
        case 'copilot-auth-cleared':
            copilotState.reload();
            break;
        case 'copilot-proxy-updated':
            copilotStore.reload();
            break;

        // CodeBuddy
        case 'codebuddy-credentials-changed':
            credentialStore.reload();
            break;
        case 'codebuddy-state-changed':
            credentialStore.getTokenManager().loadState();
            break;

        // Relay
        case 'relay-upstreams-changed':
            relayStore.getUpstreamManager()._loadUpstreams();
            break;
        case 'relay-settings-changed':
            relayStore.getUpstreamManager()._loadSettings();
            break;

        // Stats
        case 'stats-flush':
            copilotStore.flushApiCallCounts();
            credentialStore.flushApiCallCounts();
            relayStore.flushApiCallCounts();
            break;
        case 'stats-reset':
            if (data.service === 'copilot') copilotStore.resetCustomStats();
            else if (data.service === 'codebuddy') credentialStore.resetCustomStats();
            else if (data.service === 'relay') relayStore.resetCustomStats();
            else {
                copilotStore.resetCustomStats();
                credentialStore.resetCustomStats();
                relayStore.resetCustomStats();
            }
            break;

        default:
            logger.warn(`Unknown broadcast event type: ${type}`);
    }
}

export function createServer() {
    const server = http.createServer(async (req, res) => {
        // 只打印已知路由的请求日志，忽略遥测等无关请求
        const isKnown =
            req.url.startsWith('/login') ||
            req.url.startsWith('/logout') ||
            req.url.startsWith('/copilotFE') ||
            req.url.startsWith('/copilot/') ||
            req.url.startsWith('/copilot/anthropic/v1/') ||
            req.url.startsWith('/codebuddyFE') ||
            req.url.startsWith('/codebuddy/v1/') ||
            req.url.startsWith('/codebuddy/anthropic/v1/') ||
            req.url.startsWith('/relayFE') ||
            req.url.startsWith('/relay/v1/') ||
            req.url.startsWith('/relay/anthropic/v1/');
        if (isKnown) {
            logger.info(`${req.method} ${req.url}`);
        }

        // ============ 鉴权路由 ============

        // POST /login — 处理登录请求
        if (req.method === 'POST' && req.url === '/login') {
            try {
                await handleLoginRequest(req, res);
                return;
            } catch (err) {
                logger.error('Login error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // GET /login — 登录页面
        if (req.method === 'GET' && req.url.startsWith('/login')) {
            try {
                if (req.url === '/login/public-key') {
                    getPublicKeyEndpoint(req, res);
                } else {
                    serveLoginPage(req, res);
                }
                return;
            } catch (err) {
                logger.error('Login page error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // GET/POST /logout — 登出
        if (req.url === '/logout') {
            try {
                handleLogoutRequest(req, res);
                return;
            } catch (err) {
                logger.error('Logout error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // ============ 管理后台路由（需要管理员认证） ============

        // Copilot 前端管理界面（必须在 /copilot 通用路由之前）
        if (req.url.startsWith('/copilotFE')) {
            if (!requireAdminAuth(req, res)) return;
            try {
                await routeCopilotFrontend(req, res);
                return;
            } catch (err) {
                logger.error('Copilot frontend error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // CodeBuddy 前端管理界面
        if (req.url.startsWith('/codebuddyFE')) {
            if (!requireAdminAuth(req, res)) return;
            try {
                await routeCodebuddyFrontend(req, res);
                return;
            } catch (err) {
                logger.error('CodeBuddy frontend error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // Relay 前端管理界面
        if (req.url.startsWith('/relayFE')) {
            if (!requireAdminAuth(req, res)) return;
            try {
                await routeRelayFrontend(req, res);
                return;
            } catch (err) {
                logger.error('Relay frontend error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // ============ 内部通信端点（集群广播 + 统计聚合） ============

        if (req.url.startsWith('/internal/')) {
            // 仅允许本地访问
            const remoteAddr = req.socket.remoteAddress || '';
            if (!remoteAddr.includes('127.0.0.1') && !remoteAddr.includes('::1') && remoteAddr !== '::ffff:127.0.0.1') {
                res.writeHead(403, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({error: 'Forbidden'}));
                return;
            }

            // POST /internal/broadcast — 接收广播事件
            if (req.method === 'POST' && req.url === '/internal/broadcast') {
                try {
                    const chunks = [];
                    req.on('data', chunk => chunks.push(chunk));
                    req.on('end', () => {
                        try {
                            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                            handleBroadcastEvent(data);
                            res.writeHead(200, {'Content-Type': 'application/json'});
                            res.end(JSON.stringify({ok: true}));
                        } catch (err) {
                            res.writeHead(400, {'Content-Type': 'application/json'});
                            res.end(JSON.stringify({error: err.message}));
                        }
                    });
                    return;
                } catch (err) {
                    res.writeHead(500, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({error: err.message}));
                    return;
                }
            }

            // GET /internal/stats/{service} — 返回当前 worker 的统计数据
            const statsMatch = req.url.match(/^\/internal\/stats\/([a-z]+)$/);
            if (req.method === 'GET' && statsMatch) {
                const service = statsMatch[1];
                let stats = null;
                switch (service) {
                    case 'copilot':
                        stats = copilotStore.getUsageStats();
                        break;
                    case 'codebuddy':
                        stats = credentialStore.getUsageStats();
                        break;
                    case 'relay':
                        stats = relayStore.getUsageStats();
                        break;
                    default:
                        res.writeHead(404, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({error: 'Unknown service'}));
                        return;
                }
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify(stats));
                return;
            }

            // GET /internal/stats/daily/{service}?month=YYYY-MM — 返回当前 worker 的每日统计
            const dailyMatch = req.url.match(/^\/internal\/stats\/daily\/([a-z]+)$/);
            if (req.method === 'GET' && dailyMatch) {
                const service = dailyMatch[1];
                const urlObj = new URL(req.url, `http://${req.headers.host}`);
                const month = urlObj.searchParams.get('month') || '';
                let dailyData = null;
                switch (service) {
                    case 'copilot':
                        dailyData = copilotStore.getDailyUsageBuffer();
                        break;
                    case 'codebuddy':
                        dailyData = credentialStore.getDailyUsageBuffer();
                        break;
                    case 'relay':
                        dailyData = relayStore.getDailyUsageBuffer();
                        break;
                    default:
                        res.writeHead(404, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({error: 'Unknown service'}));
                        return;
                }
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify(dailyData));
                return;
            }

            res.writeHead(404, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({error: 'Not found'}));
            return;
        }

        // ============ API 路由（需要网关令牌认证） ============

        // Copilot 路由
        if (req.url.startsWith('/copilot')) {
            if (!requireGatewayAuth(req, res)) return;
            try {
                await routeCopilotRequest(req, res);
                return;
            } catch (err) {
                logger.error('Copilot route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // CodeBuddy 路由
        if (req.url.startsWith('/codebuddy')) {
            if (!requireGatewayAuth(req, res)) return;
            try {
                await routeCodebuddyRequest(req, res);
                return;
            } catch (err) {
                logger.error('CodeBuddy route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // Relay 路由
        if (req.url.startsWith('/relay')) {
            if (!requireGatewayAuth(req, res)) return;
            try {
                await routeRelayRequest(req, res);
                return;
            } catch (err) {
                logger.error('Relay route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // ============ 根路径（需要管理员认证） ============

        if (req.method === 'GET' && req.url === '/') {
            if (!requireAdminAuth(req, res)) return;
            const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude API Proxy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #e6edf3; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { max-width: 640px; width: 100%; padding: 48px 24px; }
    h1 { font-size: 2rem; font-weight: 700; margin-bottom: 8px; color: #f0f6fc; }
    .subtitle { color: #8b949e; margin-bottom: 40px; font-size: 0.95rem; }
    .cards { display: flex; flex-direction: column; gap: 16px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 20px 24px; text-decoration: none; color: inherit; display: flex; align-items: center; justify-content: space-between; transition: border-color 0.2s, background 0.2s; }
    .card:hover { border-color: #58a6ff; background: #1c2230; }
    .card-info { display: flex; flex-direction: column; gap: 4px; }
    .card-title { font-size: 1rem; font-weight: 600; color: #f0f6fc; }
    .card-desc { font-size: 0.85rem; color: #8b949e; }
    .card-arrow { color: #58a6ff; font-size: 1.2rem; }
    .badge { display: inline-block; font-size: 0.72rem; padding: 2px 8px; border-radius: 20px; margin-top: 4px; background: #21262d; color: #79c0ff; border: 1px solid #388bfd44; }
    .logout-btn { display: inline-block; margin-top: 24px; padding: 8px 16px; background: #21262d; border: 1px solid #30363d; border-radius: 8px; color: #8b949e; text-decoration: none; font-size: 0.85rem; transition: border-color 0.2s; }
    .logout-btn:hover { border-color: #f85149; color: #f85149; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Claude API Proxy</h1>
    <p class="subtitle">统一管理 Copilot、CodeBuddy、Relay 三个代理服务</p>
    <div class="cards">
      <a class="card" href="/copilotFE">
        <div class="card-info">
          <span class="card-title">GitHub Copilot</span>
          <span class="card-desc">Copilot 账号管理与 API 代理</span>
          <span class="badge">/copilotFE &nbsp;·&nbsp; /copilot</span>
        </div>
        <span class="card-arrow">→</span>
      </a>
      <a class="card" href="/codebuddyFE">
        <div class="card-info">
          <span class="card-title">CodeBuddy</span>
          <span class="card-desc">CodeBuddy 账号管理与 API 代理</span>
          <span class="badge">/codebuddyFE &nbsp;·&nbsp; /codebuddy</span>
        </div>
        <span class="card-arrow">→</span>
      </a>
      <a class="card" href="/relayFE">
        <div class="card-info">
          <span class="card-title">Relay</span>
          <span class="card-desc">上游 LLM 中继代理</span>
          <span class="badge">/relayFE &nbsp;·&nbsp; /relay</span>
        </div>
        <span class="card-arrow">→</span>
      </a>
    </div>
    <a class="logout-btn" href="/logout">登出</a>
  </div>
</body>
</html>`;
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(html);
            return;
        }

        send404(req, res);
    });

    // ============ WebSocket 升级处理 ============

    const wss = new WebSocketServer({noServer: true});

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        logger.info(`WS upgrade: ${pathname}`);

        // WS 鉴权
        if (!requireGatewayAuthWS(req)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        // WS 和 HTTP 使用同一个 URL，通过 upgrade 事件区分
        // POST /xxx/v1/responses → HTTP handler（上面已处理）
        // WS Upgrade /xxx/v1/responses → WS handler（下面处理）
        if (pathname === '/copilot/v1/responses') {
            wss.handleUpgrade(req, socket, head, (ws) => {
                handleCopilotResponsesWS(ws, req);
            });
        } else if (pathname === '/relay/v1/responses') {
            wss.handleUpgrade(req, socket, head, (ws) => {
                handleRelayResponsesWS(ws, req);
            });
        } else if (pathname === '/codebuddy/v1/responses') {
            wss.handleUpgrade(req, socket, head, (ws) => {
                handleCodebuddyResponsesWS(ws, req);
            });
        } else {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
        }
    });

    return server;
}
