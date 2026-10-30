/* ============================================================
   sync.js — GitHub非公開リポジトリへの自動同期(依存ライブラリなし)
   ------------------------------------------------------------
   設計の要点(安全性):
   1. 通常の同期は「この端末 → GitHub」の一方向。GitHubからこの端末へ書き込むのは、
      (a) この端末に馬データ等が1件もなく、GitHubにデータがある場合(自動復元)
      (b) 利用者が画面で「GitHubの内容を使う」「履歴から戻す」を選んだ場合
      のどちらかだけ。いずれも、書き込む前に現在の内容を退避する。
   2b. GitHubからの取り込み(自動復元・競合の解決・履歴復元・退避からの復元)は、複数のキーを
      「全部書けるか、全部書かないか」のどちらかにする。IndexedDBの1トランザクションで書ける保存層
      (store.setMany)ならそれを使い、書けない保存層では、書く前の内容を保持して失敗時に自動で元へ戻す。
      元へ戻す処理まで失敗した場合は、同期と自動復元を停止し(phase "halted")、利用者が確認するまで
      何も上書きしない。
   2. 同期に失敗しても(通信・認証・権限・容量・サーバー障害など)、この端末の保存データは
      一切変更しない。失敗は画面に表示し、再試行できる。
   3. GitHubへの書き込みは「1回の操作=1コミット」。参照の更新は force なし(早送りのみ)なので、
      GitHub側の新しい内容を古い内容で上書きすることはできない。競合したら止まって、利用者に選ばせる。
   4. 「何を送るか」は、保存時の印(dirty)ではなく、内容の比較(Git blobのSHA-1)で決める。
      印を失っても、同期の途中で止まっても、次の同期で正しく追いつく。
   5. 公開リポジトリには同期しない(データ流出を防ぐ)。
   6. トークンはこのファイルにも、ビルド結果にも含まれない。利用者が画面で入力し、
      この端末のブラウザ内(IndexedDB)にだけ保存する。表示・ログ・エラー文には出さない。
   ------------------------------------------------------------ */

export const SYNC_CONFIG_KEY = "sync-config-v1";
export const SYNC_STATE_KEY = "sync-state-v1";
export const PRE_PULL_KEY = "bak-v1:pre-sync-pull";
export const HALT_KEY = "sync-halt-v1"; // 書き込みの途中経過・停止の記録(同期の対象外)

const DEFAULT_API = (typeof __API_BASE__ !== "undefined" && __API_BASE__) ? __API_BASE__ : "https://api.github.com";

const SYNCED_RE = [
  /^horses-v1:\d{4}$/,
  /^horses-v1:\d{4}:meta$/,
  /^horses-v1:\d{4}:chunk\d+$/,
  /^marks-v1:\d{4}$/,
  /^categories-v1:\d{4}$/,
];
const SYNCED_EXACT = new Set(["pedigree-v1", "pedigree-conflicts-v1", "current-season-id-v1"]);
const SEASON_KEY = "current-season-id-v1";

// 同期の対象になる保存キーか(自動退避・診断記録・同期設定などは対象外)
export function isSyncedKey(key) {
  return typeof key === "string" && (SYNCED_EXACT.has(key) || SYNCED_RE.some((r) => r.test(key)));
}
export function keyToPath(key) { return `data/${key.replace(/:/g, "__")}.json`; }
export function pathToKey(path) {
  const m = /^data\/(.+)\.json$/.exec(path || "");
  if (!m) return null;
  const key = m[1].replace(/__/g, ":");
  return isSyncedKey(key) ? key : null;
}
// 書き込み順: チャンク → 印・カテゴリ・血統 → メタ → 選択中の年度(途中で止まっても「空」と判定されるように)
function writeRank(key) {
  if (/:chunk\d+$/.test(key)) return 0;
  if (/:meta$/.test(key)) return 2;
  if (key === SEASON_KEY) return 3;
  return 1;
}

export class SyncError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "SyncError";
    this.kind = kind; // network|server|ratelimit|auth|permission|notfound|empty-repo|public-repo|unprocessable|data|local|config|other
  }
}

async function gitBlobSha(str) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new SyncError("other", "この環境ではSHA-1を計算できないため、同期できません(HTTPSで開いてください)");
  const enc = new TextEncoder();
  const body = enc.encode(str);
  const head = enc.encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head, 0);
  all.set(body, head.length);
  const digest = new Uint8Array(await subtle.digest("SHA-1", all));
  let hex = "";
  for (let i = 0; i < digest.length; i++) hex += digest[i].toString(16).padStart(2, "0");
  return hex;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push((async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

const encBranch = (b) => b.split("/").map(encodeURIComponent).join("/");
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]+$/;
const TOKEN_RE = /^[A-Za-z0-9_]{20,}$/;

function newState() { return { v: 1, baseCommit: null, files: {}, dirty: [], lastSyncedAt: null }; }

// 3者比較(この端末の内容 / 最後に同期したときの内容 / いまのGitHubの内容)で、送る・取り込む・競合を決める
export function makePlan(localSha, remote, state) {
  const hasBase = state.baseCommit != null;
  const B = state.files || {};
  const push = [], pull = [], conflicts = [];
  const paths = new Set([...Object.keys(localSha), ...Object.keys(remote)]);
  for (const p of paths) {
    const L = localSha[p], R = remote[p], b = hasBase ? B[p] : undefined;
    if (L === R) continue;
    if (L !== undefined && R === undefined) { push.push(p); continue; }
    if (L === undefined && R !== undefined) {
      if (hasBase && b !== undefined && R === b) continue; // この端末で消した(削除はGitHubへ反映しない/復活もさせない)
      pull.push(p);
      continue;
    }
    if (!hasBase) conflicts.push(p);
    else if (L === b) pull.push(p);
    else if (R === b) push.push(p);
    else conflicts.push(p);
  }
  return { push, pull, conflicts };
}

export function createSyncEngine(opts) {
  const store = opts.store; // { getStrict(key)->{found,value}, set(key,value), delete(key), listKeys()->string[] }
  const apiBase = (opts.apiBase || DEFAULT_API).replace(/\/$/, "");
  const doFetch = opts.fetch || ((u, i) => globalThis.fetch(u, i));
  const setT = opts.setTimeout || ((f, ms) => setTimeout(f, ms));
  const clearT = opts.clearTimeout || ((t) => clearTimeout(t));
  const now = opts.now || (() => Date.now());
  const onApplied = opts.onApplied || (() => {});
  const log = opts.log || (() => {});
  const debounceMs = opts.debounceMs != null ? opts.debounceMs : 60000;
  const maxWaitMs = opts.maxWaitMs != null ? opts.maxWaitMs : 300000;
  const retrySteps = opts.retrySteps || [60000, 120000, 300000, 600000];
  const startDelayMs = opts.startDelayMs != null ? opts.startDelayMs : 1500;
  const requestTimeoutMs = opts.requestTimeoutMs != null ? opts.requestTimeoutMs : 30000;

  let config = null;
  let state = newState();
  let started = false;
  let applying = false;
  let halted = null;   // 取り込みの失敗を元に戻せなかったとき {at,message,keys}。利用者が確認するまで同期を止める
  let blocked = false; // 利用者の操作(再入力・手動同期)が必要なあいだ、自動実行を止める
  let timer = null;
  let firstDirtyAt = null;
  let retryIdx = 0;
  let chain = Promise.resolve();
  const listeners = new Set();
  let status = {
    phase: "disabled", message: "", lastSyncedAt: null, pending: 0, repo: null, branch: null,
    expiresAt: null, repoSizeKB: null, conflict: null, hasSnapshot: false,
  };

  const scrub = (msg) => {
    let s = String(msg == null ? "" : msg);
    if (config && config.token) s = s.split(config.token).join("***");
    return s;
  };
  function setStatus(patch) {
    status = Object.assign({}, status, patch, {
      pending: state.dirty.length,
      repo: config ? config.repo : null,
      branch: config ? config.branch : null,
      lastSyncedAt: state.lastSyncedAt || null,
    });
    for (const fn of listeners) { try { fn(status); } catch (e) { /* 表示側の失敗は無視 */ } }
  }
  function exclusive(fn) {
    const p = chain.then(() => fn());
    chain = p.then(() => {}, () => {});
    return p;
  }
  function clearTimer() { if (timer != null) { clearT(timer); timer = null; } }
  async function saveState() {
    try { await store.set(SYNC_STATE_KEY, JSON.stringify(state)); }
    catch (e) { log("sync-state保存失敗", scrub(e && e.message)); } // 状態を失っても、次回は内容比較で追いつく
  }

  /* ---------------- GitHub API ---------------- */
  async function api(method, path, o) {
    o = o || {};
    let url = apiBase + path;
    if (method === "GET") url += (path.includes("?") ? "&" : "?") + "_=" + now(); // ブラウザの60秒キャッシュ対策
    const headers = { Authorization: "Bearer " + config.token, Accept: o.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json" };
    let body;
    if (o.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(o.body); }
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const to = ctl ? setT(() => ctl.abort(), o.timeoutMs || requestTimeoutMs) : null;
    let res;
    try {
      res = await doFetch(url, { method, headers, body, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: ctl ? ctl.signal : undefined });
    } catch (e) {
      throw new SyncError("network", "GitHubに接続できません(通信状態を確認してください)");
    } finally {
      if (to != null) clearT(to);
    }
    const exp = res.headers && res.headers.get && res.headers.get("github-authentication-token-expiration");
    if (exp) {
      const t = Date.parse(exp.replace(" UTC", "Z").replace(" ", "T"));
      if (!isNaN(t)) status = Object.assign({}, status, { expiresAt: t });
    }
    if (res.ok) {
      if (o.raw) return await res.text();
      if (res.status === 204) return null;
      return await res.json();
    }
    let msg = "";
    try { const j = await res.json(); msg = (j && j.message) || ""; } catch (e) { /* 本文なし */ }
    const st = res.status;
    if (st === 401) throw new SyncError("auth", "GitHubのトークンが無効か、期限が切れています。新しいトークンを入力してください");
    if (st === 403 || st === 429) {
      const rem = res.headers.get("x-ratelimit-remaining");
      if (st === 429 || rem === "0" || res.headers.get("retry-after") || /rate limit/i.test(msg)) {
        throw new SyncError("ratelimit", "GitHubの利用回数の上限に達しました。しばらくしてから自動で再試行します");
      }
      throw new SyncError("permission", "GitHubの権限が足りません。トークンの対象リポジトリと「Contents: Read and write」を確認してください");
    }
    if (st === 404) throw new SyncError("notfound", "リポジトリまたはブランチが見つかりません。名前と、トークンの対象リポジトリを確認してください");
    if (st === 409 && /empty/i.test(msg)) throw new SyncError("empty-repo", "リポジトリが空です。READMEを付けて作り直すか、ファイルを1つ追加してください");
    if (st === 422) throw new SyncError("unprocessable", "GitHubが更新を受け付けませんでした");
    if (st >= 500) throw new SyncError("server", "GitHubのサーバーが一時的に応答しません。自動で再試行します");
    throw new SyncError("other", `GitHubとの通信でエラーが発生しました(${st})`);
  }
  const R = () => `/repos/${config.repo}`;

  async function getRepoInfo() {
    const info = await api("GET", R());
    if (info.private !== true) throw new SyncError("public-repo", "このリポジトリは公開されています。馬データが誰でも見られてしまうため、同期しません。非公開(Private)のリポジトリを使ってください");
    return info;
  }
  async function getHead() {
    const ref = await api("GET", `${R()}/git/ref/heads/${encBranch(config.branch)}`);
    const commit = await api("GET", `${R()}/git/commits/${ref.object.sha}`);
    return { commit: ref.object.sha, tree: commit.tree.sha };
  }
  async function getIndex(treeSha) {
    const t = await api("GET", `${R()}/git/trees/${treeSha}?recursive=1`);
    if (t.truncated) throw new SyncError("data", "GitHub上のファイルが多すぎて一覧を取得できません");
    const idx = {};
    for (const e of t.tree || []) {
      if (e.type === "blob" && pathToKey(e.path)) idx[e.path] = e.sha;
    }
    return idx;
  }

  /* ---------------- この端末の保存データ ---------------- */
  async function readLocal() {
    let keys;
    try { keys = await store.listKeys(); }
    catch (e) { throw new SyncError("local", "この端末の保存データを読み込めません(同期を中止しました。データは変更していません)"); }
    const values = {}, sha = {};
    for (const key of keys.filter(isSyncedKey).sort()) {
      let r;
      try { r = await store.getStrict(key); }
      catch (e) { throw new SyncError("local", "この端末の保存データを読み込めません(同期を中止しました。データは変更していません)"); }
      if (!r.found) continue;
      if (typeof r.value !== "string") throw new SyncError("local", "保存データの形式が想定と異なるため、同期を中止しました");
      values[key] = r.value;
      sha[keyToPath(key)] = await gitBlobSha(r.value);
    }
    return { values, sha };
  }
  const localIsEmpty = (local) => Object.keys(local.values).every((k) => k === SEASON_KEY);

  /* ---------------- 複数キーの書き込み(全部書く/全部書かない) ---------------- */
  // before: 書き込む前のこの端末の内容({キー: 文字列}、なかったキーは含まれない)
  // 失敗時は before に戻す。空の端末だった場合は、書きかけのキーを消して空に戻す。
  async function rollbackTo(before, keys) {
    const failed = [];
    for (const k of keys) {
      try {
        const r = await store.getStrict(k);
        if (Object.prototype.hasOwnProperty.call(before, k)) {
          if (!r.found || r.value !== before[k]) {
            await store.set(k, before[k]);
            const v = await store.getStrict(k);
            if (!v.found || v.value !== before[k]) failed.push(k);
          }
        } else if (r.found) {
          await store.delete(k);
          const v = await store.getStrict(k);
          if (v.found) failed.push(k);
        }
      } catch (e) { failed.push(k); }
    }
    return { ok: failed.length === 0, failed };
  }
  async function haltSync(keys, failedKeys) {
    const message = "取り込みの途中で保存に失敗し、元の状態に戻す処理にも失敗しました。この端末のデータが一部だけ新しくなっている可能性があります。同期と自動復元を止めました。内容を確認するまで、GitHubへの送信も取り込みも行いません";
    halted = { at: now(), message, keys: keys.slice(), failed: failedKeys.slice() };
    blocked = true;
    clearTimer();
    try { await store.set(HALT_KEY, JSON.stringify({ v: 1, phase: "halted", at: halted.at, message, keys: halted.keys, failed: halted.failed })); }
    catch (e) { log("停止の記録を保存できませんでした"); }
    setStatus({ phase: "halted", message, halt: { at: halted.at, keys: halted.keys, failed: halted.failed } });
    return new SyncError("halted", message);
  }
  async function writeBatch(entries, before) {
    const keys = Object.keys(entries).sort((a, b) => writeRank(a) - writeRank(b));
    if (keys.length === 0) return;
    const atomic = typeof store.setMany === "function";
    let journaled = false;
    if (!atomic) {
      // 1件ずつ書く保存層: 書く前に「書き込み中」の記録を残す(途中でアプリが終了した場合、次回起動で検知する)
      try { await store.set(HALT_KEY, JSON.stringify({ v: 1, phase: "applying", at: now(), keys })); journaled = true; }
      catch (e) { throw new SyncError("local", "書き込み前の記録を保存できなかったため、取り込みを中止しました(データは変更していません)"); }
    }
    applying = true;
    try {
      try {
        if (atomic) await store.setMany(entries);
        else for (const k of keys) await store.set(k, entries[k]);
      } catch (werr) {
        const rb = await rollbackTo(before, keys);
        if (!rb.ok) throw await haltSync(keys, rb.failed);
        if (journaled) { try { await store.delete(HALT_KEY); } catch (e) { /* 記録が残るだけ */ } }
        throw new SyncError("local", "取り込みの途中で保存に失敗したため、元の状態に戻しました(データは変更されていません)");
      }
    } finally {
      applying = false;
    }
    if (journaled) { try { await store.delete(HALT_KEY); } catch (e) { log("書き込み記録の削除に失敗"); } }
  }

  /* ---------------- 取り込み(GitHub → この端末) ---------------- */
  // 取得 → 検証 → 退避 → 書き込み の順。検証や退避に失敗した場合は、この端末に何も書かない。
  async function applyRemote(indexToFetch, paths, local, adopt, reason) {
    const fetched = {};
    await mapLimit(paths, 4, async (p) => {
      const key = pathToKey(p);
      if (!key) return;
      const text = await api("GET", `${R()}/git/blobs/${indexToFetch[p]}`, { raw: true, timeoutMs: 60000 });
      if ((await gitBlobSha(text)) !== indexToFetch[p]) throw new SyncError("data", "GitHubから取得したデータが壊れています(取り込みを中止しました。データは変更していません)");
      try { JSON.parse(text); } catch (e) { throw new SyncError("data", "GitHub上のデータの形式が正しくありません(取り込みを中止しました。データは変更していません)"); }
      fetched[key] = text;
    });
    // 馬データの一貫性: メタが示すチャンクがすべてGitHub上にそろっていること
    for (const key of Object.keys(fetched)) {
      const m = /^(horses-v1:\d{4}):meta$/.exec(key);
      if (!m) continue;
      const meta = JSON.parse(fetched[key]);
      const n = meta && typeof meta.chunkCount === "number" ? meta.chunkCount : 0;
      for (let i = 0; i < n; i++) {
        if (!indexToFetch[keyToPath(`${m[1]}:chunk${i}`)]) {
          throw new SyncError("data", "GitHub上の馬データが不完全です(チャンクが足りません)。取り込みを中止しました。データは変更していません");
        }
      }
    }
    // 現在の内容を退避(退避できなければ中止)
    const localKeys = Object.keys(local.values);
    if (localKeys.length > 0) {
      const snap = { v: 1, savedAt: now(), reason, entries: local.values };
      try { await store.set(PRE_PULL_KEY, JSON.stringify(snap)); }
      catch (e) { throw new SyncError("local", "現在の内容を退避できなかったため、取り込みを中止しました(データは変更していません)"); }
    }
    const keys = Object.keys(fetched).sort((a, b) => writeRank(a) - writeRank(b));
    await writeBatch(fetched, local.values);
    state.baseCommit = adopt.commit;
    state.files = Object.assign({}, adopt.files);
    state.dirty = [];
    state.lastSyncedAt = now();
    await saveState();
    try { await onApplied(reason, keys); } catch (e) { log("onApplied失敗", scrub(e && e.message)); }
  }

  /* ---------------- 送信(この端末 → GitHub) ---------------- */
  async function pushPaths(head, remote, paths, local) {
    const entries = await mapLimit(paths, 4, async (p) => {
      const key = pathToKey(p);
      const r = await api("POST", `${R()}/git/blobs`, { body: { content: local.values[key], encoding: "utf-8" } });
      // GitHubが受け取った内容のSHAが、こちらで計算した値と同じか確認する(通信やサーバー側での文字化け・欠落を、コミットする前に検出)
      if (r.sha !== local.sha[p]) throw new SyncError("data", "GitHubに送ったデータが一致しませんでした(文字化けや欠落の可能性)。送信を中止しました。この端末のデータは変更していません");
      return { path: p, mode: "100644", type: "blob", sha: r.sha };
    });
    const tree = await api("POST", `${R()}/git/trees`, { body: { base_tree: head.tree, tree: entries } });
    const msg = `sync ${new Date(now()).toISOString()} (${paths.length} files)`;
    const commit = await api("POST", `${R()}/git/commits`, { body: { message: msg, tree: tree.sha, parents: [head.commit] } });
    try {
      await api("PATCH", `${R()}/git/refs/heads/${encBranch(config.branch)}`, { body: { sha: commit.sha, force: false } });
    } catch (e) {
      if (e instanceof SyncError && e.kind === "unprocessable") return null; // その間にGitHub側が進んだ(競合の可能性)
      throw e;
    }
    const files = Object.assign({}, remote);
    for (const en of entries) files[en.path] = en.sha;
    state.baseCommit = commit.sha;
    state.files = files;
    state.lastSyncedAt = now();
    await saveState();
    return commit.sha;
  }

  /* ---------------- 1回の同期 ---------------- */
  // forced: null | "remote"(競合をGitHubの内容で解決) | "local"(競合をこの端末の内容で解決)
  async function cycle(reason, forced) {
    const info = await getRepoInfo();
    status = Object.assign({}, status, { repoSizeKB: typeof info.size === "number" ? info.size : null });
    const head = await getHead();
    const remote = await getIndex(head.tree);
    const local = await readLocal();
    if (forced === "local") { state.baseCommit = head.commit; state.files = Object.assign({}, remote); }
    const plan = makePlan(local.sha, remote, state);
    const remoteCount = Object.keys(remote).length;

    if (forced === "remote") {
      await applyRemote(remote, plan.pull.concat(plan.conflicts), local, { commit: head.commit, files: remote }, "resolve-remote");
      return "restored";
    }
    // この端末に馬データ等が1件もなく、GitHubにある → 自動復元
    if (localIsEmpty(local) && remoteCount > 0) {
      await applyRemote(remote, Object.keys(remote), local, { commit: head.commit, files: remote }, "auto-restore");
      return "restored";
    }
    if (plan.conflicts.length > 0 || plan.pull.length > 0) {
      setStatus({
        phase: "conflict",
        message: plan.conflicts.length > 0
          ? "この端末とGitHubの両方で内容が変わっています。どちらを使うか選んでください(選ぶまで、どちらも変更しません)"
          : "GitHubに、この端末にない新しい内容があります。取り込むか、この端末の内容を優先するか選んでください",
        conflict: { kind: plan.conflicts.length > 0 ? "both" : "remote-newer", conflicts: plan.conflicts.map(pathToKey), pull: plan.pull.map(pathToKey), push: plan.push.map(pathToKey) },
      });
      return "conflict";
    }
    if (plan.push.length > 0) {
      const sha = await pushPaths(head, remote, plan.push, local);
      return sha ? "done" : "race";
    }
    // 差分なし: 基準だけ最新にそろえる(READMEの編集などでコミットが進んでいても、誤って競合にしない)
    state.baseCommit = head.commit;
    state.files = Object.assign({}, remote);
    state.lastSyncedAt = now();
    await saveState();
    return "done";
  }

  async function syncInner(reason, forced) {
    if (!started || !config || halted) return status;
    clearTimer();
    firstDirtyAt = null;
    setStatus({ phase: "syncing", message: "", conflict: null });
    const startDirty = state.dirty.slice();
    state.dirty = [];
    try {
      let out = "race";
      for (let attempt = 0; attempt < 3 && out === "race"; attempt++) out = await cycle(reason, attempt === 0 ? forced : null);
      if (out === "race") throw new SyncError("server", "GitHubの更新が続いたため、同期を後で再試行します");
      if (out === "conflict") {
        state.dirty = Array.from(new Set(startDirty.concat(state.dirty)));
        blocked = true;
        setStatus({ phase: "conflict" });
        return status;
      }
      blocked = false;
      retryIdx = 0;
      setStatus({ phase: "idle", message: "", conflict: null, hasSnapshot: await hasSnapshot() });
      if (state.dirty.length > 0) schedule();
      return status;
    } catch (e) {
      state.dirty = Array.from(new Set(startDirty.concat(state.dirty)));
      const kind = (e && e.kind) || "other";
      const msg = e instanceof SyncError ? scrub(e.message) : "同期中に予期しないエラーが発生しました(データは変更していません)";
      if (!(e instanceof SyncError)) log("想定外のエラー", scrub(e && e.message));
      if (kind === "halted") {
        blocked = true;
        setStatus({ phase: "halted", message: msg });
      } else if (kind === "network" || kind === "server" || kind === "ratelimit") {
        setStatus({ phase: "offline", message: msg });
        scheduleRetry();
      } else {
        blocked = true;
        setStatus({ phase: kind === "auth" || kind === "permission" ? "auth" : "error", message: msg });
      }
      setStatus({ hasSnapshot: await hasSnapshot().catch(() => false) });
      return status;
    }
  }
  const sync = (reason, forced) => exclusive(() => syncInner(reason, forced));

  async function hasSnapshot() {
    try { return (await store.getStrict(PRE_PULL_KEY)).found; } catch (e) { return false; }
  }

  /* ---------------- 自動実行の予約 ---------------- */
  function schedule() {
    if (!started || !config || blocked) return;
    const t = now();
    if (firstDirtyAt == null) firstDirtyAt = t;
    const wait = Math.max(0, Math.min(debounceMs, firstDirtyAt + maxWaitMs - t));
    clearTimer();
    timer = setT(() => { timer = null; return sync("auto"); }, wait);
  }
  function scheduleRetry() {
    if (!started || !config) return;
    const wait = retrySteps[Math.min(retryIdx, retrySteps.length - 1)];
    retryIdx++;
    clearTimer();
    timer = setT(() => { timer = null; return sync("retry"); }, wait);
  }

  /* ---------------- 公開API ---------------- */
  async function load() {
    const c = await store.getStrict(SYNC_CONFIG_KEY);
    config = null;
    if (c.found) {
      try {
        const j = JSON.parse(c.value);
        if (j && typeof j.token === "string" && REPO_RE.test(j.repo || "") && BRANCH_RE.test(j.branch || "")) config = { repo: j.repo, branch: j.branch, token: j.token };
      } catch (e) { config = null; }
    }
    const s = await store.getStrict(SYNC_STATE_KEY);
    state = newState();
    if (s.found) {
      try {
        const j = JSON.parse(s.value);
        if (j && j.v === 1 && typeof j.files === "object" && j.files) {
          state = { v: 1, baseCommit: j.baseCommit || null, files: j.files, dirty: Array.isArray(j.dirty) ? j.dirty.filter(isSyncedKey) : [], lastSyncedAt: j.lastSyncedAt || null };
        }
      } catch (e) { state = newState(); }
    }
  }

  return {
    // アプリの読み込みが正常に終わったあとに呼ぶ。読み込みに失敗している間は呼ばない(stopする)。
    async start() {
      try { await load(); }
      catch (e) {
        started = false;
        setStatus({ phase: "error", message: "同期の設定を読み込めません(同期は行いません。データは変更していません)" });
        return status;
      }
      started = true;
      blocked = false;
      retryIdx = 0;
      try {
        const h = await store.getStrict(HALT_KEY);
        if (h.found) {
          let j = null; try { j = JSON.parse(h.value); } catch (e) { j = null; }
          const interrupted = j && j.phase === "applying";
          halted = {
            at: (j && j.at) || null,
            message: interrupted
              ? "前回の取り込みの途中でアプリが終了した可能性があります。この端末のデータが一部だけ新しくなっている可能性があるため、同期と自動復元を止めました。内容を確認するまで、GitHubへの送信も取り込みも行いません"
              : ((j && j.message) || "取り込みの失敗を元に戻せなかったため、同期を止めています"),
            keys: (j && j.keys) || [], failed: (j && j.failed) || [],
          };
        }
      } catch (e) {
        halted = { at: null, message: "同期の停止状態を読み込めません。安全のため同期と自動復元を止めました", keys: [], failed: [] };
      }
      if (halted) {
        blocked = true;
        setStatus({ phase: "halted", message: halted.message, halt: { at: halted.at, keys: halted.keys, failed: halted.failed }, hasSnapshot: await hasSnapshot() });
        return status;
      }
      setStatus({ phase: config ? "idle" : "disabled", message: "", conflict: null, hasSnapshot: await hasSnapshot() });
      if (config) { clearTimer(); timer = setT(() => { timer = null; return sync("startup"); }, startDelayMs); }
      return status;
    },
    stop() {
      started = false;
      clearTimer();
      setStatus({ phase: config ? "stopped" : "disabled", message: "" });
    },
    // 保存層から、保存に成功したキーを通知してもらう(取り込み中の書き込みは無視する)
    noteWrite(key) {
      if (!started || applying || !config || halted || !isSyncedKey(key)) return;
      if (!state.dirty.includes(key)) state.dirty.push(key);
      setStatus({});
      if (!blocked) schedule();
    },
    // 画面に戻ったとき・通信が復帰したとき
    kick() {
      if (!started || !config || blocked || halted) return;
      if (status.phase === "syncing") return;
      clearTimer();
      timer = setT(() => { timer = null; return sync("kick"); }, 500);
    },
    // ページを閉じる/隠すとき: 未送信の変更があれば、すぐ送る(間に合わないこともある。次回起動で追いつく)
    flush() {
      if (!started || !config || blocked || halted || state.dirty.length === 0) return;
      sync("flush");
    },
    syncNow() { if (halted) return Promise.resolve(status); blocked = false; retryIdx = 0; return sync("manual"); },
    async configure(input) {
      const repo = String((input && input.repo) || "").trim();
      const branch = String((input && input.branch) || "main").trim() || "main";
      const token = String((input && input.token) || "").trim();
      if (halted) throw new SyncError("halted", "取り込みの失敗を元に戻せなかったため、確認が終わるまで接続の変更はできません");
      if (!REPO_RE.test(repo)) throw new SyncError("config", "リポジトリ名は「ユーザー名/リポジトリ名」の形で入力してください");
      if (!BRANCH_RE.test(branch)) throw new SyncError("config", "ブランチ名が正しくありません");
      if (!TOKEN_RE.test(token)) throw new SyncError("config", "トークンが正しい形式ではありません(余分な空白や改行が入っていないか確認してください)");
      return exclusive(async () => {
        const prev = config;
        config = { repo, branch, token };
        try {
          await getRepoInfo();
          await getHead();
        } catch (e) {
          config = prev;
          if (e instanceof SyncError) throw new SyncError(e.kind, scrub(e.message));
          throw new SyncError("other", "接続の確認に失敗しました");
        }
        try { await store.set(SYNC_CONFIG_KEY, JSON.stringify(config)); }
        catch (e) { config = prev; throw new SyncError("local", "同期の設定をこの端末に保存できませんでした"); }
        if (!prev || prev.repo !== repo || prev.branch !== branch) { state = newState(); await saveState(); }
        started = true;
        blocked = false;
        retryIdx = 0;
        setStatus({ phase: "idle", message: "", conflict: null });
        return true;
      }).then(async () => { await sync("configure"); return status; });
    },
    // 同期をやめる(この端末の馬データ・GitHub上のデータには触れない。トークンと同期の記録だけを消す)
    async disconnect() {
      return exclusive(async () => {
        clearTimer();
        await store.delete(SYNC_CONFIG_KEY);
        await store.delete(SYNC_STATE_KEY);
        config = null;
        state = newState();
        blocked = false;
        setStatus({ phase: "disabled", message: "", conflict: null, expiresAt: null, repoSizeKB: null });
      });
    },
    resolveConflict(choice) {
      if (choice !== "remote" && choice !== "local") return Promise.resolve(status);
      if (halted) return Promise.resolve(status);
      blocked = false;
      return sync("resolve", choice);
    },
    async listHistory(limit) {
      return exclusive(async () => {
        if (!config) throw new SyncError("config", "同期が設定されていません");
        const list = await api("GET", `${R()}/commits?sha=${encodeURIComponent(config.branch)}&per_page=${limit || 30}`);
        return (list || []).map((c) => ({ sha: c.sha, date: c.commit && c.commit.committer && c.commit.committer.date, message: ((c.commit && c.commit.message) || "").split("\n")[0] }));
      });
    },
    // 履歴の時点の内容に戻す。現在の内容は先に退避する。戻した内容は、次の同期で「新しいコミット」として積まれる(履歴は消えない)。
    restoreFromCommit(sha) {
      return exclusive(async () => {
        if (halted) throw new SyncError("halted", status.message);
        if (!started || !config) throw new SyncError("config", "同期が設定されていません");
        if (!/^[0-9a-f]{7,40}$/.test(sha || "")) throw new SyncError("config", "コミットの指定が正しくありません");
        setStatus({ phase: "syncing", message: "" });
        try {
          await getRepoInfo();
          const target = await api("GET", `${R()}/git/commits/${sha}`);
          const targetIdx = await getIndex(target.tree.sha);
          if (Object.keys(targetIdx).length === 0) throw new SyncError("data", "その時点にはデータがありません");
          const head = await getHead();
          const headIdx = await getIndex(head.tree);
          const local = await readLocal();
          await applyRemote(targetIdx, Object.keys(targetIdx), local, { commit: head.commit, files: headIdx }, "history-restore");
          blocked = false;
          setStatus({ phase: "idle", message: "", conflict: null, hasSnapshot: await hasSnapshot() });
          schedule();
        } catch (e) {
          const msg = e instanceof SyncError ? scrub(e.message) : "履歴からの復元に失敗しました(データは変更していません)";
          if (!(e && e.kind === "halted")) setStatus({ phase: e && (e.kind === "network" || e.kind === "server" || e.kind === "ratelimit") ? "offline" : "error", message: msg });
          throw new SyncError((e && e.kind) || "other", msg);
        }
        return status;
      });
    },
    // 取り込み・履歴復元の直前に退避した、この端末の内容に戻す
    restorePreSnapshot() {
      return exclusive(async () => {
        if (halted) throw new SyncError("halted", status.message);
        const r = await store.getStrict(PRE_PULL_KEY);
        if (!r.found) throw new SyncError("data", "戻せる退避がありません");
        let snap;
        try { snap = JSON.parse(r.value); } catch (e) { throw new SyncError("data", "退避の内容を読めません(データは変更していません)"); }
        const entries = {};
        for (const k of Object.keys((snap && snap.entries) || {})) if (isSyncedKey(k) && typeof snap.entries[k] === "string") entries[k] = snap.entries[k];
        const keys = Object.keys(entries).sort((a, b) => writeRank(a) - writeRank(b));
        const current = await readLocal();
        await writeBatch(entries, current.values);
        blocked = false;
        try { await onApplied("pre-snapshot-restore", keys); } catch (e) { log("onApplied失敗", scrub(e && e.message)); }
        setStatus({ phase: config ? "idle" : "disabled" });
        if (config) schedule();
        return keys.length;
      });
    },
    // 停止中の状態を、利用者が確認したあとで解除する(自動では解除しない)。解除後も、すぐには何も上書きしない。
    // 次の同期は「内容の比較」で行われ、差があれば競合として利用者に選ばせる。
    acknowledgeHalt() {
      return exclusive(async () => {
        if (!halted) return status;
        try { await store.delete(HALT_KEY); }
        catch (e) { throw new SyncError("local", "停止の記録を消せませんでした。もう一度お試しください"); }
        halted = null;
        blocked = false;
        setStatus({ phase: config ? "idle" : "disabled", message: "", halt: null, conflict: null, hasSnapshot: await hasSnapshot() });
        return status;
      });
    },
    getStatus() { return status; },
    getConfigPublic() { return config ? { repo: config.repo, branch: config.branch } : null; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
