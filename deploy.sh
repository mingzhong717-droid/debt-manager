#!/bin/bash
# ============================================================
# 一键部署脚本 - 每次修改代码后必须运行此脚本
# 用法: bash deploy.sh "本次修改说明"
# ============================================================

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

MSG="${1:-update: 代码更新}"

echo "📦 检查改动..."
git status --short

CHANGED=$(git status --short | wc -l)
if [ "$CHANGED" -eq 0 ]; then
  echo "✅ 没有改动，无需部署"
  exit 0
fi

echo ""
echo "🚀 开始部署到 GitHub Pages..."
git add -A
git commit -m "$MSG"
git push origin main

echo ""
echo "✅ 部署完成！"
echo "🌐 访问地址: https://mingzhong717-droid.github.io/debt-manager/"
echo "⏱  GitHub Pages 约需 1-2 分钟生效"
