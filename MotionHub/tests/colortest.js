// 配色测试：高饱和颜色只占很小一块、大面积亮色填充基本没有（用户要求：高饱和颜色 ≤ 5%）
// 4 个面板的默认布局 × 2 个宽度 × 2 种主题色（品牌橙、用户用过的浅桃色），截图后逐像素统计：
//   · 高饱和像素（HSV 饱和度 ≥ 0.5 且明度 ≥ 0.5）占面板面积的比例 ≤ 5%
//   · 亮色大块填充（背景亮度高于 0.18 的按钮 / 胶囊 / 方块，按 DOM 面积算）≤ 1%
// 截图存到 tests/out/shots/，方便对比前后
"use strict";
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const EXT = process.env.MH_EXT || path.join(__dirname, "../com.windwings.motionhub");
const OUT = path.join(__dirname, "out/shots" + (process.env.MH_SHOTS_TAG ? "-" + process.env.MH_SHOTS_TAG : ""));
const VIVID_MAX = 5, BRIGHT_MAX = 1;
let failures = 0;
function check(name, cond, detail) {
    console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond ? "" : "：" + (detail || "")));
    if (!cond) failures++;
}

function fakeHost(name, args) {
    const ok = (data, msg) => ({ ok: true, msg: msg || "", data: data || {} });
    switch (name) {
        case "init": return ok({ libPath: "/lib", version: "x", ae: "24.3.0", canWrite: true, os: "mac" });
        case "ctx": return ok({ comp: "合成 1", layers: 2, keys: 4, exprProps: 1, precomps: 0, projComps: 0, lib: "/lib" });
        case "scan": return ok({ items: [
            { path: "/lib/动画/弹跳.jsx", key: "/动画/弹跳.jsx", name: "弹跳", file: "弹跳.jsx", cat: "动画", ext: "jsx", desc: "", author: "", type: "脚本" },
            { path: "/lib/工具/整理.jsx", key: "/工具/整理.jsx", name: "整理项目", file: "整理.jsx", cat: "工具", ext: "jsx", desc: "", author: "", type: "脚本" }
        ], categories: ["动画", "工具"], libPath: "/lib" });
        case "loadConfig": return ok({ text: null });
        case "loadSnippets": return ok({ text: null, libPath: "/lib" });
        case "listEffects": return ok({ effects: [] });
        default: return ok({});
    }
}

// 在页面里统计：截图画到 canvas 上数像素；DOM 里量亮色填充的面积
async function measure(page, png) {
    return page.evaluate(async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width; c.height = img.height;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let vivid = 0;
        for (let i = 0; i < d.length; i += 4) {
            const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
            const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
            const s = mx === 0 ? 0 : (mx - mn) / mx;
            if (s >= 0.5 && mx >= 0.5) vivid++;
        }
        const total = d.length / 4;
        // 亮色填充：按钮、胶囊、方块、组件卡片的背景
        const lum = (str) => {
            const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(str);
            if (!m || (m[4] !== undefined && +m[4] < 0.5)) return 0;
            return [m[1], m[2], m[3]].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); })
                .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
        };
        const page = document.querySelector("#pages").getBoundingClientRect();
        let bright = 0, brightEls = [];
        document.querySelectorAll("#page-panel button, #page-panel .widget, #page-panel .cell").forEach(el => {
            const bg = getComputedStyle(el).backgroundColor;
            if (lum(bg) > 0.18) {
                const r = el.getBoundingClientRect();
                const w = Math.max(0, Math.min(r.right, page.right) - Math.max(r.left, page.left)), h = Math.max(0, Math.min(r.bottom, page.bottom) - Math.max(r.top, page.top));
                if (w * h > 0) { bright += w * h; brightEls.push((el.textContent || el.className).trim().slice(0, 12)); }
            }
        });
        return { vividPct: vivid / total * 100, brightPct: bright / (page.width * page.height) * 100, brightEls: brightEls.slice(0, 8) };
    }, png.toString("base64"));
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch();
    const results = [];
    for (const accent of ["#FF5900", "#FFD8BE"]) {
        for (const width of [320, 400]) {
            for (let n = 1; n <= 4; n++) {
                const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
                await page.exposeFunction("__mhHost", (name, a) => JSON.stringify(fakeHost(name, JSON.parse(a || "{}"))));
                await page.addInitScript(([n, accent]) => {
                    try { localStorage.clear(); } catch (e) {}
                    window.__adobe_cep__ = {
                        getExtensionId: () => "com.windwings.motionhub.panel" + n, getSystemPath: () => "", registerKeyEventsInterest() {},
                        evalScript(code, cb) {
                            if (code === "typeof MH") return setTimeout(() => cb("object"), 1);
                            const m = /^MH\.call\("([^"]+)",([\s\S]*)\)$/.exec(code);
                            if (!m) return setTimeout(() => cb("undefined"), 1);
                            window.__mhHost(m[1], m[2]).then(r => setTimeout(() => cb(r), 1));
                        }
                    };
                    window.__accent = accent;
                }, [n, accent]);
                await page.goto("file://" + EXT + "/index.html");
                await page.waitForTimeout(500);
                // 换主题色：和用户在设置页点色块一样
                if (accent !== "#FF5900") await page.evaluate((hex) => window.MHDebug.accent(hex), accent);
                await page.waitForTimeout(150);
                await page.mouse.move(1, 1);
                const shot = await page.locator("#pages").screenshot();
                const file = path.join(OUT, "panel" + n + "-" + width + "-" + accent.slice(1) + ".png");
                fs.writeFileSync(file, shot);
                const m = await measure(page, shot);
                results.push({ n, width, accent, m });
                await page.close();
            }
        }
    }
    await browser.close();
    console.log("配色（高饱和像素 ≤ " + VIVID_MAX + "%，亮色大块填充 ≤ " + BRIGHT_MAX + "%）：");
    results.forEach(({ n, width, accent, m }) => {
        const tag = "面板 " + n + " · " + width + "px · " + accent;
        check(tag + "：高饱和 " + m.vividPct.toFixed(2) + "%，亮色填充 " + m.brightPct.toFixed(2) + "%", m.vividPct <= VIVID_MAX && m.brightPct <= BRIGHT_MAX, JSON.stringify(m.brightEls));
    });
    console.log(failures ? "✗ 配色测试：" + failures + " 项没通过（截图在 " + OUT + "）" : "✓ 配色测试全部通过（截图在 " + OUT + "）");
    process.exit(failures ? 1 : 0);
})();
