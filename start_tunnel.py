"""
启动本地服务器 + ngrok 隧道，输出公网访问链接
"""
import threading
import http.server
import os
import sys
import time

PORT = 8080
SERVE_DIR = os.path.dirname(os.path.abspath(__file__))

# 启动本地 HTTP 服务器
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SERVE_DIR, **kwargs)
    def log_message(self, format, *args):
        pass  # 静默日志

def start_server():
    server = http.server.HTTPServer(('127.0.0.1', PORT), Handler)
    server.serve_forever()

t = threading.Thread(target=start_server, daemon=True)
t.start()
time.sleep(1)
print(f"✅ 本地服务器已启动: http://127.0.0.1:{PORT}")

# 启动 ngrok 隧道
try:
    from pyngrok import ngrok, conf
    # 设置 ngrok 二进制路径
    conf.get_default().ngrok_path = '/mnt/openclaw/catdesk/home/.local/bin/ngrok'
    
    tunnel = ngrok.connect(PORT, "http")
    public_url = tunnel.public_url
    # 强制 https
    if public_url.startswith("http://"):
        public_url = "https://" + public_url[7:]
    
    print(f"\n🌐 公网访问链接（手机打开此链接）:")
    print(f"\n   {public_url}\n")
    print("📱 手机安装步骤:")
    print("   iOS Safari: 打开链接 → 底部分享按钮 → 添加到主屏幕")
    print("   Android Chrome: 打开链接 → 右上角菜单 → 添加到主屏幕")
    print("\n⚠️  此链接有效期约2小时（免费版ngrok限制）")
    print("按 Ctrl+C 停止服务\n")
    
    # 保持运行
    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        print("\n已停止服务")
        ngrok.kill()

except Exception as e:
    print(f"❌ ngrok 启动失败: {e}")
    print("请检查网络连接或 ngrok 账号配置")
    sys.exit(1)
