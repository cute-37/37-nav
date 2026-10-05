# 部署

四种装法，任选一种。Linux 服务器推荐前两种。

| 方式 | 适合 | 系统 |
| --- | --- | --- |
| [Docker](#docker) | 不想在服务器上装 Node.js，或已经在用 Docker | Linux / Windows / macOS |
| [系统服务](#系统服务) | 直接跑在系统上，用系统自带的方式开机自启 | Linux（systemd）/ macOS（launchd）/ Windows（计划任务） |
| [pm2](#pm2) | 已经在用 pm2 管理 Node 程序 | Linux / Windows / macOS |
| [直接运行](#直接运行) | 临时试用、开发 | 任意 |

不管哪种方式，装好后都是：浏览器打开 `http://服务器地址:3080`，第一次进入时设置管理密码。**先设好密码再把端口对外开放**——没设密码之前，谁先打开页面谁就能设。

除 Docker 外都需要 Node.js 22.13 或更高版本。下面的命令都在项目目录里执行；从 [Releases](https://github.com/cute-37/37-nav/releases) 下载的 `full` 包已经带好依赖，可以跳过 `npm ci` 这一步。

## Docker

```bash
docker compose up -d
```

这会在本机构建镜像。服务器不方便联网构建的话，可以到 [Releases](https://github.com/cute-37/37-nav/releases) 下载打包好的镜像文件（`amd64` 是普通的 x86 服务器，`arm64` 是 ARM 服务器和树莓派），然后：

```bash
docker load -i 37-nav-1.0.0-docker-amd64.tar.gz
docker run -d --name nav --restart unless-stopped -p 3080:3080 -v nav-data:/data 37-nav:1.0.0
```

- **换端口**：改 `docker-compose.yml` 里 `ports` 左边的数字，例如 `"8080:3080"`，然后重新执行上面的命令。容器内的端口固定为 3080，所以网页 设置 → 服务器 里的端口是锁定的。
- **数据**：在名为 `nav-data` 的卷里。备份：

```bash
docker run --rm -v nav-data:/data -v "$PWD":/backup alpine tar czf /backup/nav-backup.tar.gz -C /data .
```

- **更新**：拉取新代码后执行 `docker compose up -d --build`。
- **重置密码**：`docker compose exec nav npm run reset-password`
- **IP 白名单**：在 Windows 和 macOS 的 Docker Desktop 上，容器看到的访问者 IP 都是 Docker 的网关地址，白名单分不清谁是谁，不要使用。Linux 上直接映射端口时一般能拿到真实 IP，启用前请在 设置 → 服务器 里核对「服务端识别到的 IP」。

## 系统服务

在项目目录里执行对应系统的脚本，它会检查 Node.js 版本、安装依赖、注册服务并启动。

**Linux**（systemd，需要 sudo）：

```bash
bash deploy/install-linux.sh
```

**macOS**（launchd，登录后启动）：

```bash
bash deploy/install-macos.sh
```

**Windows**（计划任务，登录后启动；在 PowerShell 里执行）：

```powershell
powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1
```

卸载：Linux 和 macOS 在命令后面加 `uninstall`，Windows 加 `-Uninstall`。卸载只移除服务，不删除 `data/` 目录。

macOS 和 Windows 的脚本注册的是「登录后启动」，机器重启后要有人登录才会运行。作为不登录也要运行的服务器，请用 Docker 或 pm2。

## pm2

```bash
npm ci --omit=dev
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
```

开机自启：Linux 和 macOS 执行 `pm2 startup` 并按它的提示操作；Windows 需要另装 `pm2-windows-startup`（`npm install -g pm2-windows-startup`，然后 `pm2-startup install`）。

## 直接运行

```bash
npm ci --omit=dev
npm start
```

关掉终端服务就停了，只适合试用。

## 装好之后

### 端口等设置

端口、监听地址、反向代理、对外地址、登录有效期都在网页的 设置 → 服务器 里改，保存后立即生效。也可以用环境变量 `PORT`、`HOST`、`TRUST_PROXY` 指定，这时网页里对应的项会锁定。

### 反向代理和 HTTPS

要用域名和 HTTPS 访问，一般在前面放一个反向代理。这时请做三件事：

1. 设置 → 服务器 里把「监听地址」改成 `127.0.0.1`，不让外部绕过代理直接访问。
2. 「反向代理」填 `1`（代理和本服务在同一台机器上也可以填 `loopback`）。不填的话 IP 白名单会把所有人都认成代理服务器。
3. 「对外地址」填你的域名，例如 `https://nav.example.com`。

Caddy（自动申请证书）：

```
nav.example.com {
    reverse_proxy 127.0.0.1:3080
}
```

Nginx：

```nginx
server {
    listen 443 ssl;
    server_name nav.example.com;
    # ssl_certificate / ssl_certificate_key 按你的证书填写

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 忘记管理密码

在服务器上、项目目录里执行，不需要停服务：

```bash
npm run reset-password
```

已保存的网址和账号信息不受影响，所有已登录的设备需要重新输入密码。

### 备份

备份整个 `data/` 目录（Docker 见上面的命令）。里面的 `secret.key` 丢了，已保存的账号信息就无法解密；它和 `nav.db` 一起泄露则等同明文，请限制这个目录的访问权限。

### 改错设置打不开了

用环境变量临时覆盖启动，进去改回来之后再去掉：

```bash
PORT=3080 HOST=0.0.0.0 npm start
```
