#!/bin/bash
echo "=========================================="
echo "      ZJU AutoSign 启动脚本"
echo "=========================================="
echo ""

if ! command -v node &> /dev/null; then
    echo "[ERROR] 未检测到 Node.js，请先安装 Node.js (推荐 v18+)。"
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "[INFO] 首次运行，正在安装依赖..."
    npm install
    if [ $? -ne 0 ]; then
        echo "[ERROR] 依赖安装失败，请检查网络或配置。"
        exit 1
    fi
fi

if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        echo "[INFO] 检测到缺少 .env 配置文件，正在从模板创建..."
        cp .env.example .env
        echo "[WARN] 已自动创建 .env 文件，请务必使用文本编辑器打开它并修改 APP_SECRET 和 CONTROL_TOKEN！"
    fi
fi

echo "[INFO] 正在启动服务..."
echo "[TIP]  启动成功后，请在浏览器访问: http://localhost:3000/how-it-works.html"
echo ""

npm start