// ES3 检查：host.jsx 跑在 ExtendScript（ES3）里
// 1) 用 acorn 以 ecmaVersion 3 解析，let / const / 箭头函数 / 模板字符串 / getter 等直接报语法错误
// 2) 遍历语法树，找 ES5 才有的内置方法：forEach、map、filter、数组 indexOf、trim、JSON、Object.keys、bind 等
// 用法：node es3check.js [文件]
"use strict";
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const walk = require("acorn-walk");

const file = process.argv[2] || path.join(__dirname, "../com.windwings.motionhub/jsx/host.jsx");
const src = fs.readFileSync(file, "utf8").replace(/^﻿/, "");

let ast;
try {
    ast = acorn.parse(src, { ecmaVersion: 3, locations: true, allowReserved: true });
} catch (e) {
    console.error("✗ 不是合法的 ES3：" + e.message);
    process.exit(1);
}

// 只在 ES5 才有的数组 / 函数 / 字符串方法
const ES5_METHODS = ["forEach", "map", "filter", "reduce", "reduceRight", "some", "every", "trim", "trimLeft", "trimRight", "bind", "toISOString", "toJSON"];
const ES5_STATIC = { Object: ["keys", "create", "defineProperty", "defineProperties", "getPrototypeOf", "getOwnPropertyNames", "freeze", "seal"], Array: ["isArray"], Date: ["now"] };
// indexOf / lastIndexOf：字符串上是 ES3 就有的，数组上是 ES5。这里列出已确认是字符串的调用（按源码文本）
const STRING_INDEXOF = new Set(["$.os", "p.expression", "B64", "base"]);

const problems = [];
function at(node) { return file.split("/").pop() + ":" + node.loc.start.line; }
function text(node) { return src.slice(node.start, node.end); }

walk.full(ast, function (node) {
    if (node.type === "Identifier" && node.name === "JSON") problems.push(at(node) + "  用到了 JSON（ES3 没有）");
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression" || node.callee.computed) return;
    const prop = node.callee.property.name, obj = node.callee.object;
    if (ES5_METHODS.indexOf(prop) !== -1) problems.push(at(node) + "  ." + prop + "()（ES5 方法）：" + text(node).slice(0, 70));
    if (obj.type === "Identifier" && ES5_STATIC[obj.name] && ES5_STATIC[obj.name].indexOf(prop) !== -1) problems.push(at(node) + "  " + obj.name + "." + prop + "()（ES5）");
    if ((prop === "indexOf" || prop === "lastIndexOf") && !STRING_INDEXOF.has(text(obj))) {
        problems.push(at(node) + "  ." + prop + "() 的接收者不是已确认的字符串：" + text(obj) + "（如果是字符串，加进 STRING_INDEXOF）");
    }
});

// 正则兜底：模板字符串和箭头函数在 ES3 解析时已经会失败，这里再扫一遍注释外的常见写法
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\"'])\/\/.*$/gm, "$1");
[[/\blet\s+[A-Za-z_$]/, "let"], [/\bconst\s+[A-Za-z_$]/, "const"], [/=>/, "箭头函数"]].forEach(function (r) {
    if (r[0].test(stripped)) problems.push("源码里出现了 " + r[1]);
});

if (problems.length) {
    console.error("✗ host.jsx 有 " + problems.length + " 处不符合 ES3：");
    problems.forEach(function (p) { console.error("  " + p); });
    process.exit(1);
}
console.log("✓ ES3 检查通过：" + path.basename(file) + "（" + src.split("\n").length + " 行，acorn ecmaVersion 3 + 内置方法检查）");
