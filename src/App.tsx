import React, { useEffect, useMemo, useRef, useState } from "react";

type WinnerSide = "L" | "R" | null;

type Rules = {
  target: number; // 1..99
  deuce: boolean; // true => 2点差が必要
};

const LS_TARGET = "vc_targetPoints";
const LS_DEUCE = "vc_deuceEnabled";

function clampInt(n: number, min: number, max: number) {
  const x = Math.floor(n);
  return Math.min(max, Math.max(min, x));
}

function loadRules(): { rules: Rules; hasSaved: boolean } {
  const rawT = localStorage.getItem(LS_TARGET);
  const rawD = localStorage.getItem(LS_DEUCE);

  const t = Number(rawT);
  const target = Number.isFinite(t) ? clampInt(t, 1, 99) : 25;
  const deuce = rawD === "true" ? true : rawD === "false" ? false : true;

  return {
    rules: { target, deuce },
    hasSaved: rawT !== null || rawD !== null,
  };
}

function saveRules(r: Rules) {
  localStorage.setItem(LS_TARGET, String(r.target));
  localStorage.setItem(LS_DEUCE, String(r.deuce));
}

// ===== Audio (unlock + fanfare) =====
// 重要：iOS/Safari は「ユーザー操作」後に AudioContext を resume しないと無音になりやすい
type AudioState = {
  ctx: AudioContext | null;
  master: GainNode | null;
};

function createAudio(): AudioState {
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx) return { ctx: null, master: null };

  const ctx: AudioContext = new AudioCtx();
  const master = ctx.createGain();
  master.gain.value = 0.65;
  master.connect(ctx.destination);

  return { ctx, master };
}

async function ensureAudioUnlocked(audio: AudioState): Promise<boolean> {
  if (!audio.ctx || !audio.master) return false;
  try {
    if (audio.ctx.state === "suspended") await audio.ctx.resume();
    return audio.ctx.state === "running";
  } catch {
    return false;
  }
}

function playTestBeep(audio: AudioState) {
  if (!audio.ctx || !audio.master) return;
  const ctx = audio.ctx;
  const t0 = ctx.currentTime + 0.01;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
  g.connect(audio.master);

  const o1 = ctx.createOscillator();
  o1.type = "sine";
  o1.frequency.setValueAtTime(880, t0);
  o1.connect(g);
  o1.start(t0);
  o1.stop(t0 + 0.18);

  const o2 = ctx.createOscillator();
  o2.type = "sine";
  o2.frequency.setValueAtTime(1320, t0 + 0.20);
  o2.connect(g);
  o2.start(t0 + 0.20);
  o2.stop(t0 + 0.38);
}

// ファンファーレ風：短い上昇アルペジオ + 和音 + トドメ
function playFanfare(audio: AudioState) {
  if (!audio.ctx || !audio.master) return;
  const ctx = audio.ctx;
  const t0 = ctx.currentTime + 0.02;

  function tone(
    freq: number,
    start: number,
    dur: number,
    type: OscillatorType,
    gainVal: number,
    detune = 0
  ) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    osc.detune.setValueAtTime(detune, start);

    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gainVal, start + 0.01);
    g.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, gainVal * 0.35),
      start + dur * 0.55
    );
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);

    osc.connect(g);
    g.connect(audio.master!);

    osc.start(start);
    osc.stop(start + dur);
  }

  // Cメジャー
  const C5 = 523.25;
  const E5 = 659.25;
  const G5 = 783.99;
  const C6 = 1046.5;

  const seq = [C5, E5, G5, C6, G5, C6];
  seq.forEach((f, i) => {
    const s = t0 + i * 0.085;
    // ブラスっぽく：sawtooth を軽く detune して厚み
    tone(f, s, 0.18, "sawtooth", 0.18, -6);
    tone(f, s, 0.18, "sawtooth", 0.18, +6);
    // 1オクターブ下を薄く
    tone(f / 2, s, 0.20, "triangle", 0.06, 0);
  });

  const chordStart = t0 + seq.length * 0.085 + 0.02;
  [C5, E5, G5, C6].forEach((f, j) => {
    tone(f, chordStart, 0.55, "triangle", 0.10, j % 2 === 0 ? -4 : +4);
  });

  tone(C6, chordStart + 0.12, 0.65, "sine", 0.12, 0);
}

function computeWinner(L: number, R: number, rules: Rules): WinnerSide {
  const t = rules.target;

  if (!rules.deuce) {
    if (L >= t) return "L";
    if (R >= t) return "R";
    return null;
  }

  // デュースあり：目標点以上 かつ 2点差
  if ((L >= t || R >= t) && Math.abs(L - R) >= 2) {
    return L > R ? "L" : "R";
  }
  return null;
}

export default function App() {
  const [{ rules: initialRules, hasSaved }, setInit] = useState(() =>
    loadRules()
  );

  const [rules, setRules] = useState<Rules>(initialRules);
  const [L, setL] = useState(0);
  const [R, setR] = useState(0);
  const [winner, setWinner] = useState<WinnerSide>(null);

  const [showReset, setShowReset] = useState(false);
  const [showSettings, setShowSettings] = useState(!hasSaved);

  // settings form
  const [targetDraft, setTargetDraft] = useState<number>(initialRules.target);
  const [deuceDraft, setDeuceDraft] = useState<boolean>(initialRules.deuce);

  const audioRef = useRef<AudioState>(createAudio());

  // long press
  const LONG_PRESS_MS = 900;
  const lpTimerRef = useRef<number | null>(null);
  const suppressTapRef = useRef(false);

  const ruleBadge = useMemo(
    () => `目標${rules.target} / デュース${rules.deuce ? "あり" : "なし"}`,
    [rules]
  );

  const vibrate = (ms: number | number[]) => {
    try {
      if (navigator.vibrate) navigator.vibrate(ms);
    } catch {
      // ignore
    }
  };

  const resetAll = () => {
    setL(0);
    setR(0);
    setWinner(null);
  };

  const flashSide = (side: "L" | "R") => {
    const el = document.getElementById(side === "L" ? "halfL" : "halfR");
    if (!el) return;
    el.classList.remove("winflash");
    const forceReflow = (el as HTMLElement).offsetWidth;
    void forceReflow;
    el.classList.add("winflash");
    window.setTimeout(() => el.classList.remove("winflash"), 3800);
  };

  const celebrate = async (side: "L" | "R") => {
    const audio = audioRef.current;
    const ok = await ensureAudioUnlocked(audio);
    if (ok) playFanfare(audio);
    flashSide(side);
    vibrate(40);
  };

  // winner evaluation after any score change
  useEffect(() => {
    const w = computeWinner(L, R, rules);
    if (w && winner !== w) {
      setWinner(w);
      void celebrate(w);
      return;
    }
    if (!w && winner) {
      setWinner(null);
    }
  }, [L, R, rules]);

  // helpers
  const incLeft = () => {
    if (winner) return;
    setL((v) => v + 1);
    vibrate(10);
  };
  const incRight = () => {
    if (winner) return;
    setR((v) => v + 1);
    vibrate(10);
  };

  const decLeft = () => {
    setL((v) => Math.max(0, v - 1));
    vibrate(10);
  };
  const decRight = () => {
    setR((v) => Math.max(0, v - 1));
    vibrate(10);
  };

  const onSettingsOpen = async () => {
    // 設定ボタン自体がユーザー操作なので、ここでアンロックを試みる
    await ensureAudioUnlocked(audioRef.current);
    setTargetDraft(rules.target);
    setDeuceDraft(rules.deuce);
    setShowSettings(true);
  };

  const onSettingsSave = () => {
    const t = clampInt(Number(targetDraft), 1, 99);
    const next: Rules = { target: t, deuce: !!deuceDraft };
    setRules(next);
    saveRules(next);
    resetAll();
    setShowSettings(false);
  };

  // Attach pointer handlers for tap/long-press on each half
  const attachHalfHandlers = (side: "L" | "R") => {
    const onPointerDown: React.PointerEventHandler<HTMLDivElement> = (e) => {
      e.preventDefault();
      suppressTapRef.current = false;
      if (lpTimerRef.current) window.clearTimeout(lpTimerRef.current);
      lpTimerRef.current = window.setTimeout(() => {
        suppressTapRef.current = true;
        setShowReset(true);
        vibrate(40);
      }, LONG_PRESS_MS);
    };

    const clear = () => {
      if (lpTimerRef.current) {
        window.clearTimeout(lpTimerRef.current);
        lpTimerRef.current = null;
      }
    };

    const onPointerUp: React.PointerEventHandler<HTMLDivElement> = (e) => {
      e.preventDefault();
      clear();
      if (!suppressTapRef.current) {
        side === "L" ? incLeft() : incRight();
      }
    };

    const onPointerCancel: React.PointerEventHandler<HTMLDivElement> = () => {
      clear();
    };

    const onContextMenu: React.MouseEventHandler<HTMLDivElement> = (e) => {
      e.preventDefault();
    };

    return { onPointerDown, onPointerUp, onPointerCancel, onContextMenu };
  };

  const halfLHandlers = attachHalfHandlers("L");
  const halfRHandlers = attachHalfHandlers("R");

  // 初回ロードの hasSaved を再計算したい場合の保険（基本不要）
  useEffect(() => {
    setInit(loadRules());
  }, []);

  return (
    <div style={styles.appRoot}>
      {/* keyframes */}
      <style>
        {`
          @keyframes winFlash {
            0%   { background: rgba(0,255,130,.00); }
            25%  { background: rgba(0,255,130,.18); }
            50%  { background: rgba(0,255,130,.00); }
            75%  { background: rgba(0,255,130,.22); }
            100% { background: rgba(0,255,130,.00); }
          }
          .winflash::before {
            content: "";
            position: absolute;
            inset: 0;
            background: transparent;
            animation: winFlash 0.35s linear 0s 10;
            pointer-events: none;
          }
          .winsteady::before {
            content: "";
            position: absolute;
            inset: 0;
            background: rgba(0,255,130,.22);
            pointer-events: none;
          }
        `}
      </style>

      <div style={styles.scoreArea}>
        <div
          id="halfL"
          className={winner === "L" ? "winsteady" : undefined}
          style={{
            ...styles.half,
            borderRight: "2px solid rgba(255,255,255,0.07)",
          }}
          {...halfLHandlers}
        >
          <div style={styles.label}>LEFT</div>
          {winner === "L" && <div style={styles.winTag}>WIN</div>}
          <div style={styles.score}>{L}</div>
          <div style={styles.hint}>
            <span>タップで +1 / 長押しでリセット</span>
            <span style={styles.badge}>{ruleBadge}</span>
          </div>
        </div>

        <div
          id="halfR"
          className={winner === "R" ? "winsteady" : undefined}
          style={styles.half}
          {...halfRHandlers}
        >
          <div style={styles.label}>RIGHT</div>
          {winner === "R" && <div style={styles.winTag}>WIN</div>}
          <div style={styles.score}>{R}</div>
          <div style={styles.hint}>
            <span>タップで +1 / 長押しでリセット</span>
            <span style={{ ...styles.badge, opacity: 0 }} aria-hidden>
              _
            </span>
          </div>
        </div>
      </div>

      <div style={styles.controls}>
        <div style={styles.panel}>
          <div style={styles.small}>左チーム</div>
          <button style={{ ...styles.button, ...styles.minus }} onClick={decLeft}>
            -1
          </button>
        </div>

        <div style={{ ...styles.panel, justifyContent: "end" }}>
          <div style={{ ...styles.small, textAlign: "right" }}>右チーム</div>
          <button style={{ ...styles.button, ...styles.minus }} onClick={decRight}>
            -1
          </button>
        </div>

        <button style={{ ...styles.button, gridColumn: "1 / -1" }} onClick={onSettingsOpen}>
          試合設定（目標点 / デュース）
        </button>
      </div>

      {/* Reset confirm */}
      {showReset && (
        <div
          style={styles.overlay}
          onClick={(e) => e.target === e.currentTarget && setShowReset(false)}
        >
          <div style={styles.modal}>
            <h2 style={styles.modalTitle}>リセットしますか？</h2>
            <p style={styles.modalText}>両チームの点数を 0 に戻します。</p>
            <div style={styles.modalActions}>
              <button style={styles.button} onClick={() => setShowReset(false)}>
                キャンセル
              </button>
              <button
                style={{
                  ...styles.button,
                  borderColor: "rgba(255,80,80,.35)",
                  background: "rgba(255,80,80,.22)",
                }}
                onClick={() => {
                  resetAll();
                  setShowReset(false);
                }}
              >
                OK（リセット）
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings */}
      {showSettings && (
        <div
          style={styles.overlay}
          onClick={(e) => e.target === e.currentTarget && setShowSettings(false)}
        >
          <div style={styles.modal}>
            <h2 style={styles.modalTitle}>試合設定</h2>
            <p style={styles.modalText}>勝利条件を設定します。前回の設定が自動で入ります。</p>

            <div style={styles.form}>
              <div style={styles.row}>
                <label style={styles.rowLabel} htmlFor="targetPoints">
                  目標点（例：25 / 15 / 11）
                </label>
                <input
                  id="targetPoints"
                  style={styles.input}
                  type="number"
                  min={1}
                  max={99}
                  step={1}
                  value={targetDraft}
                  onChange={(e) => setTargetDraft(Number(e.target.value))}
                />
              </div>

              <div style={styles.row}>
                <label style={styles.rowLabel}>デュース</label>
                <div style={styles.toggle}>
                  <input
                    type="checkbox"
                    checked={deuceDraft}
                    onChange={(e) => setDeuceDraft(e.target.checked)}
                  />
                  <span style={styles.rowLabel}>あり（2点差が必要）</span>
                </div>
              </div>

              <button
                style={{ ...styles.button, width: "100%" }}
                onClick={async () => {
                  const ok = await ensureAudioUnlocked(audioRef.current);
                  if (ok) {
                    playTestBeep(audioRef.current);
                  } else {
                    alert(
                      "この環境では音がブロックされています（ミュート/ブラウザ制限の可能性）。"
                    );
                  }
                }}
              >
                🔊 音を有効化（タップしてテスト）
              </button>
            </div>

            <div style={styles.modalActions}>
              <button style={styles.button} onClick={() => setShowSettings(false)}>
                閉じる
              </button>
              <button style={styles.button} onClick={onSettingsSave}>
                保存して開始
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  appRoot: {
    height: "100vh",
    width: "100%",
    background: "#000",
    color: "#fff",
    display: "grid",
    gridTemplateRows: "1fr auto",
    fontFamily:
      "system-ui, -apple-system, Segoe UI, Roboto, Noto Sans JP, sans-serif",
    userSelect: "none",
    WebkitTapHighlightColor: "transparent",
  },
  scoreArea: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "2px",
    background: "rgba(255,255,255,.06)",
    minHeight: 0,
  },
  half: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    background: "#000",
    overflow: "hidden",
    touchAction: "manipulation",
  },
  label: {
    position: "absolute",
    top: 10,
    left: 12,
    fontSize: 14,
    opacity: 0.75,
    letterSpacing: "0.08em",
  },
  score: {
    fontSize: "clamp(96px, 18vw, 220px)",
    fontWeight: 900,
    lineHeight: 1,
  },
  hint: {
    position: "absolute",
    bottom: 10,
    left: 12,
    fontSize: 12,
    opacity: 0.4,
    display: "flex",
    gap: 10,
    alignItems: "baseline",
    flexWrap: "wrap",
  },
  badge: {
    border: "1px solid rgba(255,255,255,.18)",
    background: "rgba(255,255,255,.10)",
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 11,
    opacity: 0.85,
  },
  controls: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
    padding: 12,
    background: "rgba(255,255,255,.04)",
    borderTop: "1px solid rgba(255,255,255,.10)",
  },
  panel: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    alignItems: "center",
    gap: 8,
  },
  small: {
    fontSize: 12,
    opacity: 0.7,
  },
  button: {
    appearance: "none",
    border: "1px solid rgba(255,255,255,.18)",
    background: "rgba(255,255,255,.12)",
    color: "#fff",
    borderRadius: 12,
    padding: "10px 12px",
    fontSize: 14,
    fontWeight: 800,
    cursor: "pointer",
  },
  minus: {
    padding: "8px 10px",
    fontSize: 13,
    borderRadius: 10,
    background: "rgba(255,80,80,.20)",
  },
  overlay: {
    position: "fixed",
    inset: 0,
    display: "grid",
    placeItems: "center",
    background: "rgba(0,0,0,.62)",
    padding: 20,
    zIndex: 50,
  },
  modal: {
    width: "min(460px, 92vw)",
    border: "1px solid rgba(255,255,255,.18)",
    background: "rgba(20,20,20,.95)",
    borderRadius: 18,
    padding: 16,
    boxShadow: "0 16px 50px rgba(0,0,0,.55)",
  },
  modalTitle: {
    margin: 0,
    fontSize: 18,
    fontWeight: 900,
  },
  modalText: {
    margin: "8px 0 14px",
    fontSize: 13,
    opacity: 0.75,
    lineHeight: 1.5,
  },
  modalActions: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  },
  form: {
    display: "grid",
    gap: 10,
    marginBottom: 14,
  },
  row: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    alignItems: "center",
    gap: 10,
    padding: 10,
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 14,
    background: "rgba(255,255,255,.06)",
  },
  rowLabel: {
    fontSize: 13,
    opacity: 0.85,
  },
  input: {
    width: 88,
    padding: "8px 10px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.18)",
    background: "rgba(0,0,0,.35)",
    color: "#fff",
    fontWeight: 900,
    fontSize: 14,
    outline: "none",
  },
  toggle: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  winTag: {
    position: "absolute",
    top: 10,
    right: 12,
    fontSize: 12,
    fontWeight: 900,
    letterSpacing: "0.10em",
    padding: "3px 10px",
    borderRadius: 999,
    border: "1px solid rgba(0,255,130,.35)",
    background: "rgba(0,255,130,.14)",
    color: "rgba(255,255,255,.92)",
  },
};
