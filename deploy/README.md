# 部署脚本

把本应用部署到一台服务器上的自动化脚本。**脚本里不含任何密码或服务器地址**——这些都在运行时提供。

## 两个文件

| 文件 | 运行位置 | 作用 |
|---|---|---|
| `setup.sh` | 你的电脑 | 连上服务器，把 `remote.sh` 传上去并执行 |
| `remote.sh` | 服务器 | 实际部署：备份配置 → 拉代码 → 起容器 → 接入入口反代 → 校验 |

## 用法

先告诉脚本服务器地址（二选一）：

```bash
# 方式 a：写进 deploy/config.local.sh（已被 gitignore，不会提交）
echo 'GANTT_HOST=root@<服务器IP>' > deploy/config.local.sh

# 方式 b：临时传环境变量
export GANTT_HOST=root@<服务器IP>
```

然后执行：

```bash
bash deploy/setup.sh
```

会提示输入服务器密码。整个脚本可以**重复执行**（幂等），失败时会打印日志并回滚。

## 部署架构

脚本假定服务器是这种结构——80/443 由一个容器化的 Caddy 统一对外，各业务跑在同网络的容器里：

```
Internet → Caddy 容器 (:80/:443, 自动 Let's Encrypt)
              ├─ 站点 A → 容器A:端口
              ├─ 站点 B → 容器B:端口
              └─ 本应用 → gantt:3000
                            (node:20-alpine，挂载 /opt/infinite-gantt)
```

脚本会往那个共享 Caddyfile **追加**一个站点块，不碰已有站点。如果你的服务器不是这种结构（比如 Caddy 直接跑在宿主机上），需要改 `remote.sh` 第 3、5、6 步。

可在 `remote.sh` 顶部调整的变量：

```bash
DOMAIN=status.example.com   # 站点域名
APP_DIR=/opt/infinite-gantt # 代码目录
NET=new-api_api_internal    # Caddy 所在的 docker 网络
CADDY_CONTAINER=new-api-caddy  # 对外入口容器名
CADDYFILE=/opt/new-api/Caddyfile  # 宿主机上的 Caddyfile 路径
APP_CONTAINER=gantt         # 本应用容器名
APP_PORT=3000
NODE_IMAGE=node:20-alpine
```

## 前提条件

1. **域名必须已解析到该服务器**，且 Let's Encrypt 能验证通过。如果域名走了 Cloudflare 代理（橙云），Caddy 的 HTTP-01 验证会失败、拿不到证书，HTTPS 会报 525——需要先改成 **DNS only**（灰云），或改用 DNS-01 验证。
2. 服务器能访问 Docker Hub（拉 `node:20-alpine`）和 GitHub（拉代码）。
3. 云厂商安全组放行 80/443。

## 凭据

首次部署会**随机生成**后台密码写进服务器上的 `/opt/infinite-gantt/.env`（权限 600），并打印在部署输出末尾。请立即保存——它不在任何文件里留副本。

重新部署**不会**覆盖已存在的 `.env`，所以密码只生成一次。

想改密码：

```bash
# 在服务器上
vim /opt/infinite-gantt/.env
docker restart gantt
```

## 安全设计

### X-Forwarded-For 必须被覆盖，而不是追加

应用用 `X-Forwarded-For` 首段识别访客 IP，并据此做登录失败封禁。Caddy 反代的默认行为就是覆盖这个头，但脚本仍显式写出意图：

```caddy
reverse_proxy gantt:3000 {
    header_up X-Forwarded-For {remote_host}
    header_up X-Real-IP {remote_host}
}
```

**如果这里是追加而非覆盖**，攻击者自带 `X-Forwarded-For: <任意IP>` 就能：
- 让封禁记到别人头上，从而无限次爆破；
- 或者把你自己的 IP 封掉。

Caddy 可能对此打印一条 `Unnecessary header_up X-Forwarded-For` 警告——那是无害的（它确认了默认行为就是覆盖）。验证方法见下。

### 验证 XFF 没被伪造

```bash
# 带伪造头做一次错误登录，观察计数器是否变化
curl -X POST https://<域名>/api/login \
  -H 'Content-Type: application/json' \
  -H 'X-Forwarded-For: 8.8.8.8' \
  -d '{"user":"x","pass":"y"}'
```

返回的「剩余 N 次机会」应当随**你的真实 IP** 变化，而不是被 `8.8.8.8` 带走。

## 封禁记录的恢复

`server.js` 只在**进程启动时**读一次 `bans.json`，之后封禁状态都在内存里。所以清除封禁必须两步：

```bash
# 在服务器上
echo '{}' > /opt/infinite-gantt/bans.json
docker restart gantt      # 关键：不重启的话内存里的封禁依然生效
```

**注意**：累计输错 4 次会永久封禁该 IP。别在公网端点上反复试错，否则需要按上面步骤解锁。

## 回滚

脚本每次运行都会先备份 Caddyfile。回滚：

```bash
cat /opt/new-api/Caddyfile.bak-<时间戳> > /opt/new-api/Caddyfile
docker exec <CADDY_CONTAINER> caddy reload --config /etc/caddy/Caddyfile
```

**必须用 `cat > ` 原地覆盖，不能用 `cp` 或 `mv`。** Caddyfile 是单文件 bind mount，按 inode 绑定到容器；`cp`/`mv` 会换掉 inode，容器仍指向旧内容，reload 和回滚都会静默失效。

## 日常运维

```bash
docker logs -f gantt              # 应用日志
docker restart gantt              # 重启应用
docker exec -it gantt sh          # 进容器
cd /opt/infinite-gantt && git pull && docker restart gantt   # 更新代码
```
