#!/bin/bash
# 跑全部验收测试：ES3 检查、host 单元测试、迁移测试、磁盘数据安全测试、4 面板共用磁盘模拟、4 种后台状态下的点击测试（含网络测试和 Studio）
cd "$(dirname "$0")"
set -o pipefail   # 「node xxx | tee」时，以 node 的结果为准（否则测试没通过也会被当成通过）
[ -d node_modules ] || npm install --silent
mkdir -p out
st=0
node es3check.js | tee out/es3check.txt || st=1
node hosttest.js | tee out/hosttest.txt || st=1
node migrationtest.js | tee out/migrationtest.txt || st=1
node disktest.js | tee out/disktest.txt || st=1
# 4 个面板同时启动、共用一块磁盘、随机写失败（没开 / 开着写入权限各跑 2 次）
{ node sharedsim.js 2 0 0.25 7 && node sharedsim.js 2 1 0.25 9; } | tee out/sharedsim.txt || st=1
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
