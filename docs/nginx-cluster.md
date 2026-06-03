# Nginx 负载均衡集群配置

当使用 `ecosystem.cluster.config.cjs` 启动多个 worker 时，需要 Nginx 作为前端负载均衡器，将请求分发到各 worker。

## 架构说明

```
客户端 → Nginx(:3080) → Worker1(:3081)
                       → Worker2(:3082)
                       → Worker3(:3083)
                       → Worker4(:3084)
```

## Nginx 配置

```nginx
upstream claude_api_proxy {
    # 负载均衡策略：least_conn 适合长连接场景
    least_conn;

    server 127.0.0.1:3081;
    server 127.0.0.1:3082;
    server 127.0.0.1:3083;
    server 127.0.0.1:3084;

    # 保持长连接，减少 TCP 握手开销
    keepalive 64;
}

server {
    listen 3080;
    server_name _;

    # 客户端请求体大小限制（适配大模型请求）
    client_max_body_size 10m;

    # 代理超时设置（适配 SSE 流式响应）
    proxy_connect_timeout 60s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;

    # 通用代理配置
    location / {
        proxy_pass http://claude_api_proxy;
        proxy_http_version 1.1;

        # 传递客户端真实 IP
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 长连接支持
        proxy_set_header Connection "";

        # 禁用请求缓冲，确保 SSE 流式响应即时传输
        proxy_buffering off;
        proxy_cache off;

        # SSE 相关头
        proxy_set_header Connection '';
        proxy_set_header Cache-Control 'no-cache';
    }

    # WebSocket 代理配置（Responses API）
    location ~ ^/(copilot|codebuddy|relay)/v1/responses$ {
        proxy_pass http://claude_api_proxy;
        proxy_http_version 1.1;

        # WebSocket 升级
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket 超时
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # 内部通信端点禁止外部访问
    location /internal/ {
        return 403;
    }
}
```

## HTTPS 配置（推荐生产环境使用）

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # ... 其余 location 配置同上 ...
}

# HTTP 重定向到 HTTPS
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}
```

## 负载均衡策略选择

| 策略 | 配置 | 适用场景 |
|------|------|---------|
| `least_conn` | `least_conn;` | 长连接/SSE流式场景（**推荐**） |
| `ip_hash` | `ip_hash;` | 需要会话亲和性（同一客户端始终路由到同一 worker） |
| 轮询（默认） | 无需配置 | 无状态短请求场景 |

## 启动步骤

1. 启动集群：
```bash
pm2 start ecosystem.cluster.config.cjs
```

2. 验证各 worker 正常：
```bash
curl http://127.0.0.1:3081/
curl http://127.0.0.1:3082/
curl http://127.0.0.1:3083/
curl http://127.0.0.1:3084/
```

3. 启动 Nginx：
```bash
nginx -t && nginx -s reload
```

4. 通过负载均衡端口访问：
```bash
curl http://127.0.0.1:3080/
```

## 注意事项

- **内部端点**：`/internal/*` 端点仅限 127.0.0.1 访问，Nginx 应阻止外部请求
- **WebSocket**：必须配置 `Upgrade` 和 `Connection` 头才能正常代理 WS
- **SSE 流式**：必须关闭 `proxy_buffering` 否则流式响应会延迟
- **多进程同步**：`CLUSTER_PORTS` 环境变量已自动配置，worker 间通过内部 HTTP 广播同步状态
