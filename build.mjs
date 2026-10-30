// ビルド: main.jsx を1つのJSにまとめ、index.html を dist/ に出力する(CSSは tailwindcss が dist/app.css に出力)。
// 外部のCDNやスクリプトは使わない(トークンを扱うページなので、読み込むコードは自分のサイトのものだけにする)。
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const API = process.env.POG_API_BASE || "https://api.github.com"; // 通常は変更しない(テスト用の上書き)
const buildId = String(Date.now());

mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["main.jsx"],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["safari15", "chrome100"],
  jsx: "automatic",
  outfile: "dist/app.js",
  legalComments: "none",
  define: {
    "process.env.NODE_ENV": '"production"',
    __API_BASE__: JSON.stringify(API),
  },
  logLevel: "info",
});

let html = readFileSync("index.html", "utf8").replaceAll("__BUILD__", buildId);
if (process.env.POG_CONNECT_EXTRA) html = html.replace("https://api.github.com", "https://api.github.com " + process.env.POG_CONNECT_EXTRA); // テスト用
writeFileSync("dist/index.html", html);
console.log("build ok", buildId);
