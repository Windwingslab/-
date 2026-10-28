#!/bin/bash
# 跑全部验收测试：ES3 检查、host 单元测试、4 种后台状态下的点击测试（含网络测试和 Studio）
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --silent
mkdir -p out
st=0
node es3check.js | tee out/es3check.txt || st=1
node hosttest.js | tee out/hosttest.txt || st=1
for mode in normal backend-down backend-dead no-write; do
    echo "== 点击测试 · $mode =="
    case $mode in
        normal) env node clicktest.js ;;
        backend-down) MH_BACKEND_DOWN=1 node clicktest.js ;;
        backend-dead) MH_BACKEND_DEAD=1 node clicktest.js ;;
        no-write) MH_NO_WRITE=1 node clicktest.js ;;
    esac > out/clicktest-$mode.txt 2>&1 || st=1
    tail -1 out/clicktest-$mode.txt
done
exit $st
