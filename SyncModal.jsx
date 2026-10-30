import React, { useState, useEffect } from "react";
import { X, Cloud, RefreshCw, AlertTriangle, Check } from "lucide-react";

/* ============================================================
   GitHub同期の設定・状態・復元の画面
   ------------------------------------------------------------
   トークンは、この画面の入力欄に利用者が貼り付ける。送信後は画面の状態からも消す。
   (保存先は、この端末のブラウザ内だけ。表示・ログ・エラー文には出さない。)
   ============================================================ */
const PHASE_LABEL = {
  disabled: "未設定",
  stopped: "停止中(読み込み完了後に再開します)",
  idle: "同期済み",
  syncing: "同期中…",
  offline: "通信待ち(自動で再試行します)",
  auth: "要対応: トークン・権限",
  error: "要対応",
  conflict: "要対応: 競合",
  halted: "停止中: 保存データの確認が必要です",
};

function fmt(ms) {
  if (!ms) return "まだありません";
  try { return new Date(ms).toLocaleString("ja-JP", { hour12: false }); } catch (e) { return String(ms); }
}

export default function SyncModal({ engine, status, C, onClose }) {
  const configured = !!status.repo;
  const [repo, setRepo] = useState(status.repo || "");
  const [branch, setBranch] = useState(status.branch || "main");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [armed, setArmed] = useState(""); // 2回押しで実行する操作のID
  const [history, setHistory] = useState(null); // null=未取得, []=なし
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => { setArmed(""); }, [status.phase]);

  const run = async (fn, okMsg) => {
    setBusy(true); setError(""); setNotice("");
    try {
      await fn();
      if (okMsg) setNotice(okMsg);
    } catch (e) {
      setError((e && e.message) ? e.message : "操作に失敗しました");
    } finally {
      setBusy(false);
    }
  };
  const twoStep = (id, fn, okMsg) => {
    if (armed !== id) { setArmed(id); return; }
    setArmed("");
    run(fn, okMsg);
  };

  const connect = () => run(async () => {
    await engine.configure({ repo, branch, token });
    setToken(""); // 送信後は画面の状態からトークンを消す
  }, "接続しました");

  const loadHistory = () => run(async () => { setHistory(await engine.listHistory(30)); });

  const box = { background: C.surfaceRaised, border: `1px solid ${C.border}` };
  const btn = { color: C.gold, border: `1px solid ${C.goldSoft}` };
  const attention = ["error", "auth", "conflict", "halted"].includes(status.phase);
  const halted = status.phase === "halted";
  const daysLeft = status.expiresAt ? Math.floor((status.expiresAt - Date.now()) / 86400000) : null;

  return (
    <div className="absolute inset-0 z-40 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div
        className="w-full sm:max-w-md flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{ background: C.surface, border: `1px solid ${C.border}`, maxHeight: "90%" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="shrink-0 flex items-center justify-between px-4"
          style={{ background: C.surfaceRaised, borderBottom: `1px solid ${C.border}`, paddingTop: "max(12px, env(safe-area-inset-top))", paddingBottom: 12 }}
        >
          <span className="text-sm font-bold flex items-center gap-2"><Cloud size={16} color={C.gold} />GitHub同期(自動バックアップ)</span>
          <button onClick={onClose} style={{ minHeight: 44, minWidth: 44 }} className="flex items-center justify-center" aria-label="閉じる">
            <X size={20} color={C.textDim} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4" style={{ WebkitOverflowScrolling: "touch" }}>
          {/* 状態 */}
          <div className="p-3 rounded-lg" style={{ ...box, borderColor: attention ? C.danger : C.border }}>
            <div className="text-xs font-semibold mb-1" style={{ color: attention ? C.danger : C.text }}>
              {PHASE_LABEL[status.phase] || status.phase}
            </div>
            {status.message && <p className="text-[11px] leading-relaxed mb-2" style={{ color: attention ? C.danger : C.textDim }}>{status.message}</p>}
            {configured ? (
              <div className="text-[11px] leading-relaxed" style={{ color: C.textDim }}>
                <div>同期先: {status.repo}({status.branch})</div>
                <div>最終同期: {fmt(status.lastSyncedAt)}</div>
                <div>未送信の変更: {status.pending}件{status.pending > 0 && ["idle", "syncing", "offline"].includes(status.phase) ? "(自動で送ります)" : ""}</div>
                {typeof status.repoSizeKB === "number" && (
                  <div style={{ color: status.repoSizeKB > 500 * 1024 ? C.danger : C.textDim }}>
                    リポジトリの使用量: 約{(status.repoSizeKB / 1024).toFixed(1)}MB{status.repoSizeKB > 500 * 1024 ? "(大きくなっています。新しいリポジトリへの移行を検討してください)" : ""}
                  </div>
                )}
                {daysLeft !== null && (
                  <div style={{ color: daysLeft < 14 ? C.danger : C.textDim }}>トークンの期限: あと約{daysLeft}日</div>
                )}
              </div>
            ) : (
              <p className="text-[11px] leading-relaxed" style={{ color: C.textDim }}>
                まだ設定されていません。設定すると、印・順位・メモ・カテゴリ・馬データ・血統データが、あなたの非公開GitHubリポジトリに自動で控えられます。
              </p>
            )}
          </div>

          {error && <p className="text-xs leading-relaxed" style={{ color: C.danger }}>{error}</p>}
          {notice && <p className="text-xs leading-relaxed flex items-center gap-1" style={{ color: C.gold }}><Check size={14} />{notice}</p>}

          {/* 取り込みの失敗を元に戻せなかった場合: 確認するまで、同期も自動復元も止まっている */}
          {halted && (
            <div className="p-3 rounded-lg" style={{ ...box, borderColor: C.danger }}>
              <div className="text-xs font-bold mb-1 flex items-center gap-1" style={{ color: C.danger }}><AlertTriangle size={14} />この端末のデータを確認してください</div>
              <p className="text-[11px] leading-relaxed mb-2" style={{ color: C.textDim }}>
                GitHubからの取り込み中に保存が失敗し、元に戻す処理も完了しませんでした。一部のデータだけが新しくなっている可能性があります。
                確認が終わるまで、GitHubへの送信・取り込み・自動復元は行いません(GitHub上のデータは変更されません)。
              </p>
              <ol className="text-[11px] leading-relaxed mb-3 list-decimal pl-4" style={{ color: C.textDim }}>
                <li>まず「バックアップ」から、現在のデータをJSONで書き出して保存してください。</li>
                <li>馬数・印・メモが期待どおりか確認してください。</li>
                <li>問題がなければ、下のボタンで停止を解除します。解除しても、すぐには何も上書きしません。次の同期で内容の違いが見つかったら、どちらを使うか選べます。</li>
              </ol>
              {status.halt && status.halt.failed && status.halt.failed.length > 0 && (
                <p className="text-[10px] leading-relaxed mb-3 break-all" style={{ color: C.textDim }}>戻せなかった項目: {status.halt.failed.join(", ")}</p>
              )}
              <button
                disabled={busy}
                onClick={() => twoStep("ack", () => engine.acknowledgeHalt(), "停止を解除しました")}
                className="w-full py-2.5 rounded-lg text-xs font-semibold"
                style={{ color: C.danger, border: `1px solid ${C.danger}` }}
              >
                {armed === "ack" ? "もう一度押すと停止を解除します" : "確認しました(停止を解除する)"}
              </button>
            </div>
          )}

          {/* 競合 */}
          {status.phase === "conflict" && status.conflict && (
            <div className="p-3 rounded-lg" style={{ ...box, borderColor: C.danger }}>
              <div className="text-xs font-bold mb-1 flex items-center gap-1" style={{ color: C.danger }}><AlertTriangle size={14} />どちらの内容を使いますか</div>
              <p className="text-[11px] leading-relaxed mb-3" style={{ color: C.textDim }}>
                競合 {status.conflict.conflicts.length}件 / GitHubにだけある更新 {status.conflict.pull.length}件 / この端末にだけある更新 {status.conflict.push.length}件。選ぶまで、この端末もGitHubも変更しません。
              </p>
              <button
                disabled={busy}
                onClick={() => twoStep("remote", () => engine.resolveConflict("remote"), "GitHubの内容を取り込みました")}
                className="w-full py-2.5 rounded-lg text-xs font-semibold mb-2"
                style={btn}
              >
                {armed === "remote" ? "もう一度押すと実行します" : "GitHubの内容を使う"}
              </button>
              <p className="text-[10px] leading-relaxed mb-3" style={{ color: C.textDim }}>この端末の現在の内容は、先に自動で退避します(あとで「同期前の状態に戻す」で戻せます)。</p>
              <button
                disabled={busy}
                onClick={() => twoStep("local", () => engine.resolveConflict("local"), "この端末の内容をGitHubに送りました")}
                className="w-full py-2.5 rounded-lg text-xs font-semibold mb-2"
                style={btn}
              >
                {armed === "local" ? "もう一度押すと実行します" : "この端末の内容を使う"}
              </button>
              <p className="text-[10px] leading-relaxed" style={{ color: C.textDim }}>GitHub側の古い内容は消えず、履歴に残ります(履歴から戻せます)。</p>
            </div>
          )}

          {/* 設定フォーム(未設定、または再入力) */}
          {!halted && (!configured || status.phase === "auth") && (
            <div className="space-y-2">
              <div className="text-xs font-bold">{configured ? "トークンを入力し直す" : "接続の設定"}</div>
              <label className="block text-[11px]" style={{ color: C.textDim }}>
                リポジトリ(ユーザー名/リポジトリ名)
                <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="ユーザー名/pog-data" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  className="w-full mt-1 px-3 py-2 rounded-lg" style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }} />
              </label>
              <label className="block text-[11px]" style={{ color: C.textDim }}>
                ブランチ
                <input value={branch} onChange={(e) => setBranch(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  className="w-full mt-1 px-3 py-2 rounded-lg" style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }} />
              </label>
              <label className="block text-[11px]" style={{ color: C.textDim }}>
                トークン(github_pat_ で始まる文字列)
                <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  className="w-full mt-1 px-3 py-2 rounded-lg" style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }} />
              </label>
              <button
                onClick={connect}
                disabled={busy || !repo || !token}
                className="w-full py-3 rounded-lg text-sm font-semibold flex items-center justify-center gap-2"
                style={{ background: C.gold, color: C.bg, opacity: busy || !repo || !token ? 0.5 : 1 }}
              >
                {busy ? <RefreshCw size={16} className="animate-spin" /> : <Cloud size={16} />}接続して同期を始める
              </button>
              <p className="text-[10px] leading-relaxed" style={{ color: C.textDim }}>
                トークンは、この端末のブラウザ内にだけ保存されます(暗号化はしていません)。画面・ログ・バックアップJSONには出しません。公開リポジトリには接続できません。
              </p>
            </div>
          )}

          {/* 操作 */}
          {configured && !halted && (
            <div className="space-y-2">
              <button
                onClick={() => run(() => engine.syncNow())}
                disabled={busy || status.phase === "syncing"}
                className="w-full py-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-2"
                style={{ ...btn, opacity: busy || status.phase === "syncing" ? 0.6 : 1 }}
              >
                <RefreshCw size={14} className={status.phase === "syncing" ? "animate-spin" : ""} />今すぐ同期
              </button>

              <button onClick={loadHistory} disabled={busy} className="w-full py-2.5 rounded-lg text-xs font-semibold" style={btn}>
                履歴から戻す(GitHubの過去の版)
              </button>
              {history && history.length === 0 && <p className="text-[11px]" style={{ color: C.textDim }}>履歴がありません。</p>}
              {history && history.length > 0 && (
                <div className="rounded-lg overflow-hidden" style={box}>
                  {history.map((h) => (
                    <div key={h.sha} className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${C.border}` }}>
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px]" style={{ color: C.text }}>{fmt(h.date ? Date.parse(h.date) : null)}</div>
                        <div className="text-[10px] truncate" style={{ color: C.textDim }}>{h.message}</div>
                      </div>
                      <button
                        disabled={busy}
                        onClick={() => twoStep("h" + h.sha, () => engine.restoreFromCommit(h.sha), "この時点の内容に戻しました")}
                        className="shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold"
                        style={btn}
                      >
                        {armed === "h" + h.sha ? "もう一度" : "戻す"}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {status.hasSnapshot && (
                <button
                  disabled={busy}
                  onClick={() => twoStep("snap", () => engine.restorePreSnapshot(), "同期前の状態に戻しました")}
                  className="w-full py-2.5 rounded-lg text-xs font-semibold"
                  style={btn}
                >
                  {armed === "snap" ? "もう一度押すと実行します" : "同期前の状態に戻す(取り込み直前の退避)"}
                </button>
              )}

              <button
                disabled={busy}
                onClick={() => twoStep("disc", () => engine.disconnect(), "同期をやめました")}
                className="w-full py-2.5 rounded-lg text-xs font-semibold"
                style={{ color: C.danger, border: `1px solid ${C.danger}` }}
              >
                {armed === "disc" ? "もう一度押すと同期をやめます" : "同期をやめる(トークンを消す)"}
              </button>
              <p className="text-[10px] leading-relaxed" style={{ color: C.textDim }}>
                同期をやめても、この端末の馬データ・GitHub上のデータは消えません。消えるのは、この端末に保存したトークンと同期の記録だけです。
              </p>
            </div>
          )}

          <div className="pt-2" style={{ borderTop: `1px solid ${C.border}` }}>
            <button onClick={() => setShowHelp(!showHelp)} className="text-[11px] underline" style={{ color: C.textDim }}>
              {showHelp ? "説明を閉じる" : "仕組みと注意点"}
            </button>
            {showHelp && (
              <div className="mt-2 text-[11px] leading-relaxed space-y-2" style={{ color: C.textDim }}>
                <p>・印などを変更すると、約1分後にまとめてGitHubへ送ります。通信できないときは、この端末のデータはそのままで、自動で再試行します。</p>
                <p>・GitHubからこの端末へ書き込むのは、①この端末にデータが1件もなく、GitHubにある場合(自動復元)と、②画面で「GitHubの内容を使う」「戻す」を選んだ場合だけです。どちらも、書き込む前に現在の内容を退避します。</p>
                <p>・この端末で削除したデータは、GitHubからは削除しません。履歴にもすべて残ります。</p>
                <p>・トークンの期限が切れたら、GitHubで新しく作り、ここで入力し直してください。それまでも、この端末では普通に使えます。</p>
                <p>・バックアップが増えるとリポジトリが大きくなります。使用量はこの画面に表示されます。</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
