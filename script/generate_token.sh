#!/bin/bash

# 1. 生成一个随机的 Base64 字符串（取 32 位长度）
RANDOM_STR=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)

# 2. 拼接前缀
JWT_SECRET="dev_${RANDOM_STR}"

# 3. 检查当前目录下是否存在 .dev.vars 文件
FILE=".dev.vars"

if [ -f "$FILE" ]; then
    # 如果文件存在，先删除旧的 JWT_SECRET（如果有的话），然后追加新的
    sed -i '' '/^JWT_SECRET=/d' "$FILE" 2>/dev/null || sed -i '/^JWT_SECRET=/d' "$FILE"
    echo "JWT_SECRET=$JWT_SECRET" >> "$FILE"
    echo "✅ 已更新 $FILE 中的 JWT_SECRET"
else
    # 如果文件不存在，直接创建并写入
    echo "JWT_SECRET=$JWT_SECRET" > "$FILE"
    echo "✅ 已创建 $FILE 并写入 JWT_SECRET"
fi

echo "🔑 你的新密钥是: $JWT_SECRET"