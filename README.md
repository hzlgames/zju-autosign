# ZJU-AutoSign

本项目是一个简单易用的 ZJU 自动打卡聚合管理工具。支持多用户管理、网页端控制、钉钉消息推送等功能。
核心签到脚本直接继承自https://github.com/5dbwat4/ZJU-live-better ，遵循GPL-3.0License，感恩开源

**核心功能：**
- 自动执行每日打卡任务。
- 提供 Web 界面管理用户。
- 支持钉钉机器人告警。
- 数据本地加密存储。
- 多用户多线程并行打卡

---

## 💻 个人 PC 用户 (Windows/Mac) 使用教程

如果你只是想在自己的电脑上运行（需要电脑开机才能打卡），并且**不想使用命令行**，按下面做即可：

### 0. 先解压
- **不要直接在压缩包里运行**，请先完整解压到一个普通文件夹（例如 `D:\zju-autosign\`）。
- 路径尽量不要太深，避免权限/路径过长导致问题。

### 1. 安装 Node.js（只需一次）
- 打开 [Node.js 官网](https://nodejs.org/) 下载 **LTS 版本** 并安装（建议 v18+）。
- 安装时请确保勾选 **Add to PATH**（把 node 加到系统环境变量）。
- 安装完成后如果脚本仍提示找不到 Node.js：**重启电脑** 或 **注销再登录** 一次即可。

### 2. 一键启动（不需要命令行）
- **Windows 用户**：直接双击运行 `start.bat`
- **Mac/Linux 用户**：在终端进入该文件夹后运行 `sh start.sh`

> 首次运行时脚本会自动安装依赖（可能需要 1-3 分钟）。如果网络较慢，会自动切换到国内镜像重试。

### 3. 首次运行的“向导”会做什么？
第一次启动时，控制台会提示你设置 **管理口令**：
- **`CONTROL_TOKEN`**：用于登录管理后台（长度至少 16 位）
- **`APP_SECRET`**：用于加密本地数据（脚本会自动生成）

你不需要手动编辑 `.env`：脚本会自动创建/补全，并且会把 `CONTROL_TOKEN` **自动复制到剪贴板**，方便直接粘贴到后台登录页。如果没有复制则请自己进入.env文件中复制。

### 4. 使用
启动成功后，打开浏览器访问：
[http://localhost:3000/admin.html](http://localhost:3000/admin.html)

输入你刚刚设置/生成的 `CONTROL_TOKEN` 即可进入管理后台添加账号。
（具体教程随缘出，稍微弄一弄应该研究的明白）

---

## 🚀 服务器部署 (Linux VPS) 教程

如果你有云服务器，可以实现 24 小时无人值守运行：

### 1. 传输文件
将解压后的文件上传到服务器目录，例如 `/opt/zju-autosign`。

### 2. 安装依赖
```bash
cd /opt/zju-autosign
npm install
```

### 3. 配置
复制配置文件模板：
```bash
cp .env.example .env
nano .env
```
修改 `APP_SECRET` 和 `CONTROL_TOKEN`。

### 4. 启动
可以直接运行 `npm start`，但建议使用 PM2 进行进程守护（防止报错退出）：
```bash
npm install -g pm2
pm2 start index.js --name zju-autosign
pm2 save
pm2 startup
```

---

## ❓ 常见问题

**Q: 双击 `start.bat` 提示“未检测到 Node.js”，但我明明安装了？**  
A: 一般是 **环境变量 PATH 没生效**。请按顺序尝试：  
- **重启电脑** 或 **注销再登录** 后再双击 `start.bat`  
- 确认 `C:\Program Files\nodejs\` 下存在 `node.exe`（默认安装位置）  
- 重新安装 Node.js LTS，并确保勾选 **Add to PATH**  

**Q: 首次运行安装依赖失败/卡住怎么办？**  
A: 脚本会自动切换国内镜像重试；如果仍失败：  
- 更换网络/关闭代理或 VPN 后重试  
- 临时关闭杀毒软件或“受控文件夹访问”（可能会拦截写入 `node_modules`）  
- 右键 `start.bat` → **以管理员身份运行**  

**Q: 忘记管理口令 `CONTROL_TOKEN` 了怎么办？**  
A: 打开项目目录下的 `.env`，找到 `CONTROL_TOKEN=...` 那一行即可（这是登录后台需要的口令）。  

**Q: 端口 3000 被占用怎么办？**
A: 修改 `.env` 文件中的 `CONTROL_PORT` 为其他端口（如 3001）。

**Q: 如何开启 HTTPS？**
A: 将 SSL 证书（`privkey.pem` 和 `fullchain.pem`）放入项目目录的 `certs/` 文件夹（需新建），并在 `.env` 中取消 HTTPS 相关配置的注释。

**Q: 数据存在哪里？**
A: 所有用户数据都保存在 `data/` 目录下。请定期备份该目录。

---

## 📝 声明
本项目仅供学习交流使用，使用本工具产生的一切后果由使用者自行承担。
遵循 GPL-3.0 开源协议。
