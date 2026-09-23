#!/bin/bash
# 在服务器上执行：以 Docker 容器方式部署 infinite-gantt，并接入现有 new-api-caddy 入口
# 可重复执行（幂等）。绝不修改现有站点配置，只追加 status.hcrx.ltd 一段。
set -euo pipefail

DOMAIN=status.hcrx.ltd
APP_DIR=/opt/infinite-gantt
REPO=https://github.com/HCRXchenghong/infinite-gantt.git
NET=new-api_api_internal          # Caddy 所在的网络
CADDY_CONTAINER=new-api-caddy     # 对外 80/443 入口
APP_CONTAINER=gantt
APP_PORT=3000
NODE_IMAGE=node:20-alpine
CADDYFILE=/opt/new-api/Caddyfile
STAMP=$(date +%Y%m%d-%H%M%S)

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$1"; }
die() { printf '\033[1;31mXX %s\033[0m\n' "$1" >&2; exit 1; }

# ---------- 0. 备份 ----------
say "0. 备份现有 Caddyfile"
[ -f "$CADDYFILE" ] || die "$CADDYFILE 不存在，入口配置与预期不符，已中止"
cp -a "$CADDYFILE" "$CADDYFILE.bak-$STAMP"
echo "   备份 -> $CADDYFILE.bak-$STAMP"

# 记下部署前的站点清单，供第 8 步回归验证使用（确保没弄坏别人的服务）。
# 动态从 Caddyfile 提取，不硬编码任何域名。
PRE_SITES=$(grep -oE '^[a-zA-Z0-9._-]+\.[a-zA-Z]+[[:space:]]*\{' "$CADDYFILE" | sed 's/[[:space:]]*{//' | grep -v "^$DOMAIN$" || true)
echo "   现有站点块（部署前）："
echo "$PRE_SITES" | sed '/^$/d;s/^/     - /'

# 记录基线状态码：某些站点本来可能就返回 404/405，
# 回归验证要比对「部署前后是否一致」，而不是简单要求 200。
BASELINE=""
while IFS= read -r s; do
  [ -z "$s" ] && continue
  c=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://$s/" 2>/dev/null || echo ERR)
  BASELINE="$BASELINE$s=$c "
done <<< "$PRE_SITES"
echo "   基线状态码: ${BASELINE:-（无其它站点）}"

# Caddyfile 是 Docker 单文件 bind mount，按 inode 绑定到容器。
# 因此修改必须原地写入（>> 或 cat >），绝不能用 cp/mv 替换文件——
# 那样 inode 会变，容器内仍指向旧内容，reload 与回滚都会静默失效。
restore_caddyfile() { cat "$CADDYFILE.bak-$STAMP" > "$CADDYFILE"; }

# ---------- 1. 准备代码 ----------
say "1. 拉取代码到 $APP_DIR"
command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git; }
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all --prune -q
  git -C "$APP_DIR" reset --hard origin/main -q
else
  rm -rf "$APP_DIR"; git clone -q "$REPO" "$APP_DIR"
fi
echo "   提交: $(git -C "$APP_DIR" log --oneline -1)"

# ---------- 2. 生成 .env ----------
say "2. 配置后台凭据（.env）"
if [ -f "$APP_DIR/.env" ]; then
  echo "   .env 已存在，保留原有账号密码"
else
  NEWPASS=$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | head -c 24)
  printf 'ADMIN_USER=admin\nADMIN_PASS=%s\nPORT=%s\n' "$NEWPASS" "$APP_PORT" > "$APP_DIR/.env"
  echo "   已生成新 .env"
fi
chmod 600 "$APP_DIR/.env"
echo "   ┌─ 后台登录凭据（请立即保存，文件权限 600）"
grep -E '^(ADMIN_USER|ADMIN_PASS)=' "$APP_DIR/.env" | sed 's/^/   │  /'
echo "   └─ 后台地址: https://$DOMAIN/admin-manage"

# ---------- 3. 启动容器 ----------
say "3. 启动应用容器 $APP_CONTAINER"
docker network inspect "$NET" >/dev/null 2>&1 || die "网络 $NET 不存在"
docker pull -q "$NODE_IMAGE" >/dev/null
docker rm -f "$APP_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$APP_CONTAINER" \
  --network "$NET" \
  --restart unless-stopped \
  -v "$APP_DIR":/app -w /app \
  "$NODE_IMAGE" node server.js >/dev/null
echo "   容器状态: $(docker inspect -f '{{.State.Status}}' "$APP_CONTAINER")"

# ---------- 4. 容器内健康检查 ----------
say "4. 健康检查"
sleep 3
CODE=000
for i in 1 2 3 4 5 6 7 8; do
  CODE=$(docker exec "$APP_CONTAINER" wget -q -T 5 -O /dev/null -S "http://127.0.0.1:$APP_PORT/api/data" 2>&1 | awk '/HTTP\//{print $2; exit}') || true
  [ "$CODE" = 200 ] && break
  sleep 2
done
echo "   GET /api/data -> ${CODE:-000}"
if [ "$CODE" != 200 ]; then
  warn "应用未正常响应，容器日志："
  docker logs --tail 30 "$APP_CONTAINER" 2>&1 | sed 's/^/     /'
  die "健康检查失败"
fi
echo "   事件数: $(docker exec "$APP_CONTAINER" wget -qO- "http://127.0.0.1:$APP_PORT/api/data" | grep -o '"id"' | wc -l)"

# ---------- 5. 追加 Caddy 站点 ----------
say "5. 追加 Caddy 站点 $DOMAIN"
if grep -qE "^$DOMAIN \{" "$CADDYFILE"; then
  echo "   站点块已存在，跳过追加"
else
  cat >> "$CADDYFILE" <<SITEEOF

# infinite-gantt 甘特图（部署脚本追加于 $STAMP）
$DOMAIN {
	encode zstd gzip
	reverse_proxy $APP_CONTAINER:$APP_PORT {
		# 覆盖而非追加 XFF：server.js 取首段做登录失败封禁，
		# 若保留客户端自带值，攻击者可伪造 XFF 绕过封禁或封掉任意 IP
		header_up X-Forwarded-For {remote_host}
		header_up X-Real-IP {remote_host}
	}
}
SITEEOF
  echo "   已追加"
fi

# ---------- 6. 校验并热加载 ----------
say "6. 校验 Caddy 配置"
if ! docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  warn "配置校验失败，回滚到备份"
  docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -8 | sed 's/^/     /'
  restore_caddyfile
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
  die "已回滚，现有站点未受影响"
fi
echo "   ✓ 校验通过"
echo "   热加载（不中断现有站点）..."
docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile
echo "   Caddy 容器: $(docker inspect -f '{{.State.Status}}' "$CADDY_CONTAINER")"

# ---------- 7. 证书与端到端验证 ----------
say "7. 等待 Let's Encrypt 证书签发"
for i in $(seq 1 20); do
  H=$(curl -s -m 12 -o /dev/null -w '%{http_code}' "https://$DOMAIN/" 2>/dev/null || echo 000)
  [ "$H" = 200 ] && break
  sleep 3
done
echo "   https://$DOMAIN/ -> ${H:-000}"
echo "   证书信息:"
echo | timeout 15 openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates 2>/dev/null | sed 's/^/     /' || echo "     暂无证书"

say "8. 完整回归验证"
chk() { printf '   %-44s -> %s\n' "$1" "$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$2" 2>/dev/null || echo FAIL)"; }
chk "https://$DOMAIN/              (前端)"    "https://$DOMAIN/"
chk "https://$DOMAIN/admin-manage  (后台)"    "https://$DOMAIN/admin-manage"
chk "https://$DOMAIN/api/data      (公开API)" "https://$DOMAIN/api/data"

echo "   --- 现有站点回归（部署前 -> 部署后，状态码必须一致）---"
REGRESS=0
while IFS= read -r s; do
  [ -z "$s" ] && continue
  now=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://$s/" 2>/dev/null || echo ERR)
  before=$(echo "$BASELINE" | grep -oE "(^| )$s=[^ ]*" | sed "s/.*=//")
  before=${before:-未知}
  if [ "$now" = "$before" ]; then
    printf '     %-38s %s -> %s  一致\n' "$s" "$before" "$now"
  else
    printf '     %-38s %s -> %s  \033[1;31m变化！\033[0m\n' "$s" "$before" "$now"
    REGRESS=1
  fi
done <<< "$PRE_SITES"
[ "$REGRESS" = 0 ] && echo "     ✓ 现有站点全部未受影响" \
  || warn "有站点状态码发生变化，请检查（配置备份：$CADDYFILE.bak-$STAMP）"

echo "   --- 前端不应暴露后台入口 ---"
N=$(curl -s -m 15 "https://$DOMAIN/" | grep -c 'admin-manage' || true)
echo "     首页出现 admin-manage: $N 次（应为 0）"

say "部署完成"
cat <<SUM
   前端      https://$DOMAIN/
   后台      https://$DOMAIN/admin-manage
   代码目录  $APP_DIR
   容器      docker logs -f $APP_CONTAINER
   入口日志  docker logs -f $CADDY_CONTAINER
   配置备份  $CADDYFILE.bak-$STAMP

   回滚方法  cat $CADDYFILE.bak-$STAMP > $CADDYFILE \\
              && docker exec $CADDY_CONTAINER caddy reload --config /etc/caddy/Caddyfile
            （必须用 cat > 原地覆盖，不能用 cp/mv：Caddyfile 是单文件
              bind mount，替换 inode 会让容器继续读旧内容）
SUM
