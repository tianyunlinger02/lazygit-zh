#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' '未找到 Node.js，请安装 Node.js 22 或更新版本并加入 PATH。' >&2
    exit 127
fi
if [ ! -f "$SCRIPT_DIR/dist/cli.js" ]; then
    printf '%s\n' '源码还未构建。请在 AutoGit 源码目录先运行 npm ci 和 npm run build。' >&2
    exit 1
fi
# Keep the caller project directory; use the same first-run location flow as autogit.
exec node "$SCRIPT_DIR/dist/cli.js" "$@"
