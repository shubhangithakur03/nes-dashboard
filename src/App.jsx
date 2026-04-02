import { useState, useEffect } from "react";
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from "recharts";

// ─── THEME ────────────────────────────────────────────────────────────────────
const C = {
  bg: "#f0f4f8", surface: "#ffffff", border: "#e2e8f0",
  text: "#0f172a", muted: "#64748b", faint: "#94a3b8",
  blue: "#2563eb", blueSoft: "#dbeafe", blueText: "#1d4ed8",
  green: "#16a34a", greenSoft: "#dcfce7", greenText: "#15803d",
  yellow: "#d97706", yellowSoft: "#fef9c3", yellowText: "#92400e",
  red: "#dc2626", redSoft: "#fee2e2", redText: "#991b1b",
  purple: "#7c3aed", purpleSoft: "#ede9fe",
  cyan: "#0891b2", orange: "#ea580c", orangeSoft: "#ffedd5",
  navy: "#1e3a5f",
};

const STATUS_COLORS = {
  "NOT STARTED": C.faint, "IN PROGRESS": C.blue,
  "PENDING REVIEW": C.yellow, "COMPLETED": C.green, "REJECTED/REWORK": C.red,
};
const PRIORITY_COLORS = { High: C.red, Medium: C.yellow, Low: C.green };
const TICKET_STATUSES = ["NOT STARTED", "IN PROGRESS", "PENDING REVIEW", "COMPLETED", "REJECTED/REWORK"];

// ─── ALL TABS & THEIR KEYS ────────────────────────────────────────────────────
const ALL_TABS = ["Dashboard", "Experts", "Reviewers", "Ops Team", "Tickets", "Tasks", "Ramp Plan", "Financials", "Visualizations", "Risk", "Access"];
const ADMIN_ONLY_TABS = ["Financials", "Access"]; // always hidden from non-admins regardless

// Tabs that can be toggled in access control (non-admin-only)
const CONTROLLABLE_TABS = ["Dashboard", "Experts", "Reviewers", "Ops Team", "Tickets", "Tasks", "Ramp Plan", "Visualizations", "Risk"];

// NES Project Phases (used for Ramp Plan AND Financials)
const PHASES = [
  { id: "p0_unified", name: "P0 – Unified (Full)", tasks: 4000, revenue: 250000, weeks: 8, color: C.blue },
  { id: "p0_nes", name: "P0 – Personalized NES", tasks: 4000, revenue: 270000, weeks: 8, color: C.purple },
  { id: "p1", name: "P1 – Unified comp+NES", tasks: 2000, revenue: 125000, weeks: 5, color: C.cyan },
  { id: "p2_completions", name: "P2 – Completions", tasks: 2000, revenue: 125000, weeks: 5, color: C.orange },
  { id: "p2_nes", name: "P2 – NES Standalone", tasks: 2000, revenue: 125000, weeks: 5, color: C.green },
];

// Ramp plan sheets keyed to each NES phase
const RAMP_SHEETS_DEFAULT = [
  { id: "p0_unified", name: "P0 – Unified (Full)", totalTasks: 4000, attemptAHT: 3.5, reviewAHT: 1.5, sbqDefault: 0.25, cbHoursPerWeek: 10, newHiresPerWeek: 10, promotionRate: 0.2, firstWeekCapacity: 0.5, weeks: ["W1","W2","W3","W4","W5","W6","W7","W8"], taskTargets: [0, 200, 400, 600, 700, 700, 800, 600] },
  { id: "p0_nes", name: "P0 – Personalized NES", totalTasks: 4000, attemptAHT: 5.0, reviewAHT: 1.5, sbqDefault: 0.3, cbHoursPerWeek: 10, newHiresPerWeek: 10, promotionRate: 0.2, firstWeekCapacity: 0.5, weeks: ["W1","W2","W3","W4","W5","W6","W7","W8"], taskTargets: [0, 200, 400, 600, 700, 700, 800, 600] },
  { id: "p1", name: "P1 – Unified comp+NES", totalTasks: 2000, attemptAHT: 4.0, reviewAHT: 1.5, sbqDefault: 0.25, cbHoursPerWeek: 10, newHiresPerWeek: 8, promotionRate: 0.2, firstWeekCapacity: 0.5, weeks: ["W1","W2","W3","W4","W5"], taskTargets: [0, 300, 500, 700, 500] },
  { id: "p2_completions", name: "P2 – Completions", totalTasks: 2000, attemptAHT: 3.0, reviewAHT: 1.0, sbqDefault: 0.25, cbHoursPerWeek: 10, newHiresPerWeek: 8, promotionRate: 0.2, firstWeekCapacity: 0.5, weeks: ["W1","W2","W3","W4","W5"], taskTargets: [0, 300, 500, 700, 500] },
  { id: "p2_nes", name: "P2 – NES Standalone", totalTasks: 2000, attemptAHT: 5.0, reviewAHT: 1.5, sbqDefault: 0.3, cbHoursPerWeek: 10, newHiresPerWeek: 8, promotionRate: 0.2, firstWeekCapacity: 0.5, weeks: ["W1","W2","W3","W4","W5"], taskTargets: [0, 250, 500, 750, 500] },
];

// ─── UTILS ────────────────────────────────────────────────────────────────────
function useLS(key, init) {
  const [s, setS] = useState(() => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : init; } catch { return init; } });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(s)); } catch {} }, [key, s]);
  return [s, setS];
}
const fmt = (n, d = 0) => (+(n ?? 0)).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtUSD = n => `$${fmt(n)}`;
const fmtPct = (n, d = 1) => `${fmt(n, d)}%`;

// ─── UI PRIMITIVES ────────────────────────────────────────────────────────────
const inputStyle = { width: "100%", background: "#f8fafc", border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, padding: "9px 14px", fontSize: 14, boxSizing: "border-box", outline: "none", fontFamily: "inherit" };
const selectStyle = { ...inputStyle, cursor: "pointer" };
const btnPrimary = { background: C.blue, color: "#fff", border: "none", borderRadius: 9, padding: "11px 22px", cursor: "pointer", fontWeight: 700, fontSize: 14, width: "100%" };
const btnSm = { background: "#f1f5f9", color: C.text, border: `1px solid ${C.border}`, borderRadius: 7, padding: "6px 14px", cursor: "pointer", fontWeight: 600, fontSize: 13 };

function Badge({ children, color = C.blue }) {
  return <span style={{ background: color + "18", color, border: `1px solid ${color}40`, borderRadius: 6, padding: "2px 9px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{children}</span>;
}
function KpiCard({ label, value, sub, color = C.text, icon, delta }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 22px", display: "flex", flexDirection: "column", gap: 6, boxShadow: "0 1px 3px #0001" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ color: C.muted, fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase" }}>{label}</span>
        {icon && <span style={{ fontSize: 17 }}>{icon}</span>}
      </div>
      <div style={{ color, fontSize: 28, fontWeight: 800, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>{value}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {sub && <span style={{ color: C.muted, fontSize: 12 }}>{sub}</span>}
        {delta != null && <span style={{ color: delta >= 0 ? C.green : C.red, fontSize: 12, fontWeight: 700 }}>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}%</span>}
      </div>
    </div>
  );
}
function TH({ cols }) {
  return (
    <thead><tr style={{ background: "#f8fafc" }}>
      {cols.map(c => <th key={c} style={{ textAlign: "left", color: C.muted, fontSize: 11, fontWeight: 700, padding: "10px 14px", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap", letterSpacing: "0.05em" }}>{c}</th>)}
    </tr></thead>
  );
}
function InNum({ value, onChange, prefix = "", suffix = "", width = "80px" }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
      {prefix && <span style={{ color: C.muted, fontSize: 12 }}>{prefix}</span>}
      <input type="number" value={value} onChange={e => onChange(parseFloat(e.target.value) || 0)}
        style={{ background: "#f1f5f9", border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, padding: "3px 8px", fontSize: 13, fontFamily: "'DM Mono', monospace", width, outline: "none" }} />
      {suffix && <span style={{ color: C.muted, fontSize: 12 }}>{suffix}</span>}
    </span>
  );
}
function Modal({ title, onClose, children, width = 520 }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "#0007", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: C.surface, borderRadius: 16, padding: 32, width, maxWidth: "95vw", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px #0003" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 24 }}>
          <span style={{ fontWeight: 800, fontSize: 18 }}>{title}</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 22 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
function FF({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ color: C.muted, fontSize: 11, fontWeight: 700, display: "block", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</label>
      {children}
    </div>
  );
}
function SectionCard({ title, children, extra }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 22 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <span style={{ fontWeight: 800, fontSize: 15 }}>{title}</span>
        {extra}
      </div>
      {children}
    </div>
  );
}

// ─── PIN LOGIN SCREEN ────────────────────────────────────────────────────────
function PinLogin({ accessUsers, onLogin }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  const tryLogin = () => {
    if (pin === "ST0311") { onLogin("__admin__"); return; }
    const user = accessUsers.find(u => u.pin === pin && u.pin);
    if (user) { onLogin(user.id); setError(""); }
    else { setError("Incorrect PIN. Contact Shubhangi."); setPin(""); }
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <div style={{ background: C.surface, borderRadius: 20, padding: 48, width: 380, boxShadow: "0 8px 40px #0002", textAlign: "center" }}>
        <div style={{ width: 56, height: 56, background: C.navy, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", fontSize: 28 }}>🔒</div>
        <div style={{ fontWeight: 800, fontSize: 22, color: C.text, marginBottom: 6 }}>GitHub NES Ops Center</div>
        <div style={{ color: C.muted, fontSize: 14, marginBottom: 28 }}>Enter your access PIN to continue</div>
        <input
          type="password"
          value={pin}
          onChange={e => setPin(e.target.value)}
          onKeyDown={e => e.key === "Enter" && tryLogin()}
          placeholder="Enter PIN"
          style={{ ...inputStyle, textAlign: "center", fontSize: 20, letterSpacing: "0.3em", marginBottom: 14 }}
          autoFocus
        />
        {error && <div style={{ color: C.red, fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <button onClick={tryLogin} style={{ ...btnPrimary }}>Enter Dashboard</button>
        <div style={{ color: C.faint, fontSize: 11, marginTop: 20 }}>Contact your ops administrator if you need access.</div>
      </div>
    </div>
  );
}

// ─── PERSON TAB (Experts / Reviewers / Ops) ───────────────────────────────────
function PersonTab({ items, setItems, type, financials }) {
  const isExpert = type === "expert";
  const isReviewer = type === "reviewer";
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(false);
  const [editId, setEditId] = useState(null);
  const color = isExpert ? C.blue : isReviewer ? C.purple : C.orange;

  const blank = () => ({
    id: `${isExpert ? "E" : isReviewer ? "R" : "O"}${String(items.length + 1).padStart(3, "0")}`,
    name: "", status: "active", region: "US", assignment: "",
    ...(isExpert ? { tasksCompleted: 0, tasksToday: 0, qualityScore: 0, avgSpeed: 0, baseRate: 0, perTaskRate: 0, bonusEarned: 0, joinDate: "" } : {}),
    ...(isReviewer ? { tasksReviewed: 0, tasksToday: 0, qualityScore: 0, avgSpeed: 0, baseRate: 0, perTaskRate: 0, bonusEarned: 0, joinDate: "" } : {}),
    ...(!isExpert && !isReviewer ? { role: "", responsibilities: "", weeklyHours: 40, activityPct: 0, completionRate: 0, salary: 0 } : {}),
  });
  const [form, setForm] = useState(blank());

  const filtered = items.filter(x => x.name.toLowerCase().includes(search.toLowerCase()));
  const openAdd = () => { setForm(blank()); setEditId(null); setModal(true); };
  const openEdit = x => { setForm({ ...x }); setEditId(x.id); setModal(true); };
  const save = () => {
    if (!form.name.trim()) return;
    if (editId) setItems(p => p.map(x => x.id === editId ? form : x));
    else setItems(p => [...p, form]);
    setModal(false);
  };
  const del = id => { if (confirm("Delete?")) setItems(p => p.filter(x => x.id !== id)); };
  const upd = (f, v) => setForm(p => ({ ...p, [f]: v }));
  const threshold = financials?.qualityThreshold || 90;

  const kpi = isExpert ? [
    { label: "Active", value: items.filter(x => x.status === "active").length, icon: "👥", color },
    { label: "Tasks Today", value: fmt(items.reduce((s, x) => s + (x.tasksToday || 0), 0)), icon: "✅", color: C.green },
    { label: "Total Completed", value: fmt(items.reduce((s, x) => s + (x.tasksCompleted || 0), 0)), icon: "📊", color: C.muted },
    { label: "Avg Quality", value: items.filter(x => x.qualityScore > 0).length ? fmtPct(items.filter(x => x.qualityScore > 0).reduce((s, x) => s + x.qualityScore, 0) / items.filter(x => x.qualityScore > 0).length) : "—", icon: "⭐", color: C.green },
  ] : isReviewer ? [
    { label: "Active", value: items.filter(x => x.status === "active").length, icon: "🔍", color },
    { label: "Reviews Today", value: fmt(items.reduce((s, x) => s + (x.tasksToday || 0), 0)), icon: "📋", color: C.green },
    { label: "Total Reviewed", value: fmt(items.reduce((s, x) => s + (x.tasksReviewed || 0), 0)), icon: "📊", color: C.muted },
    { label: "Avg Quality", value: items.filter(x => x.qualityScore > 0).length ? fmtPct(items.filter(x => x.qualityScore > 0).reduce((s, x) => s + x.qualityScore, 0) / items.filter(x => x.qualityScore > 0).length) : "—", icon: "⭐", color: C.green },
  ] : [
    { label: "Team Size", value: items.length, icon: "👔", color },
    { label: "Active", value: items.filter(x => x.status === "active").length, icon: "✅", color: C.green },
    { label: "Avg Activity", value: items.length > 0 ? fmtPct(items.reduce((s, x) => s + (x.activityPct || 0), 0) / items.length) : "—", icon: "📊", color: C.blue },
    { label: "Avg Completion", value: items.length > 0 ? fmtPct(items.reduce((s, x) => s + (x.completionRate || 0), 0) / items.length) : "—", icon: "🎯", color: C.purple },
  ];

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 20 }}>
        {kpi.map(k => <KpiCard key={k.label} {...k} />)}
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder={`Search ${type}s...`} style={{ ...inputStyle, flex: 1, width: "auto" }} />
        <button onClick={openAdd} style={{ ...btnSm, background: color, color: "#fff", border: "none" }}>+ Add {isExpert ? "Expert" : isReviewer ? "Reviewer" : "Ops Member"}</button>
      </div>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 800 }}>
          <TH cols={isExpert ? ["ID","Name","Status","Region","Assignment","Today","Total","Quality","$/task","Bonus","Actions"]
            : isReviewer ? ["ID","Name","Status","Region","Assignment","Today","Reviewed","Quality","$/task","Bonus","Actions"]
            : ["ID","Name","Role","Region","Responsibilities","Hrs/Wk","Activity","Completion","Status","Actions"]} />
          <tbody>
            {filtered.length === 0 && <tr><td colSpan={11} style={{ padding: 40, textAlign: "center", color: C.faint }}>No {type}s yet. Click "+ Add" to get started.</td></tr>}
            {filtered.map((x, i) => (
              <tr key={x.id} style={{ borderTop: `1px solid ${C.border}`, background: i % 2 ? "#fafafa" : C.surface }}>
                <td style={{ padding: "10px 14px", color: C.muted, fontFamily: "'DM Mono',monospace", fontSize: 12 }}>{x.id}</td>
                <td style={{ padding: "10px 14px", fontWeight: 700 }}>{x.name}</td>
                {!isExpert && !isReviewer && <td style={{ padding: "10px 14px", color: C.blue, fontSize: 13 }}>{x.role}</td>}
                {(isExpert || isReviewer) && <td style={{ padding: "10px 14px" }}><Badge color={x.status === "active" ? C.green : C.faint}>{x.status}</Badge></td>}
                <td style={{ padding: "10px 14px", color: C.muted, fontSize: 13 }}>{x.region || "—"}</td>
                <td style={{ padding: "10px 14px", color: C.muted, fontSize: 13, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.assignment || x.responsibilities || "—"}</td>
                {(isExpert || isReviewer) && <>
                  <td style={{ padding: "10px 14px", fontFamily: "'DM Mono',monospace", color, fontWeight: 700 }}>{x.tasksToday}</td>
                  <td style={{ padding: "10px 14px", fontFamily: "'DM Mono',monospace" }}>{isExpert ? x.tasksCompleted : x.tasksReviewed}</td>
                  <td style={{ padding: "10px 14px", fontFamily: "'DM Mono',monospace", fontWeight: 700, color: x.qualityScore >= threshold ? C.green : x.qualityScore > 0 ? C.red : C.faint }}>{x.qualityScore > 0 ? fmtPct(x.qualityScore) : "—"}</td>
                  <td style={{ padding: "10px 14px", fontFamily: "'DM Mono',monospace" }}>{x.perTaskRate > 0 ? fmtUSD(x.perTaskRate) : "—"}</td>
                  <td style={{ padding: "10px 14px", fontFamily: "'DM Mono',monospace", color: C.green }}>{x.bonusEarned > 0 ? fmtUSD(x.bonusEarned) : "—"}</td>
                </>}
                {!isExpert && !isReviewer && <>
                  <td style={{ padding: "10px 14px", fontFamily: "'DM Mono',monospace" }}>{x.weeklyHours}h</td>
                  <td style={{ padding: "10px 14px" }}>
                    <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 13 }}>{fmtPct(x.activityPct)}</div>
                    <div style={{ background: C.border, borderRadius: 3, height: 4, width: 60, marginTop: 3 }}>
                      <div style={{ background: x.activityPct >= 80 ? C.green : C.yellow, height: 4, borderRadius: 3, width: `${Math.min(x.activityPct, 100)}%` }} />
                    </div>
                  </td>
                  <td style={{ padding: "10px 14px", fontFamily: "'DM Mono',monospace" }}>{fmtPct(x.completionRate)}</td>
                  <td style={{ padding: "10px 14px" }}><Badge color={x.status === "active" ? C.green : C.faint}>{x.status}</Badge></td>
                </>}
                <td style={{ padding: "10px 14px" }}>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => openEdit(x)} style={{ ...btnSm, padding: "3px 10px", fontSize: 12 }}>Edit</button>
                    <button onClick={() => del(x.id)} style={{ ...btnSm, padding: "3px 10px", fontSize: 12, color: C.red, borderColor: C.red + "50" }}>Del</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {modal && (
        <Modal title={`${editId ? "Edit" : "Add"} ${isExpert ? "Expert" : isReviewer ? "Reviewer" : "Ops Member"}`} onClose={() => setModal(false)}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <FF label="Name"><input type="text" value={form.name} onChange={e => upd("name", e.target.value)} style={inputStyle} /></FF>
            <FF label="ID"><input type="text" value={form.id} onChange={e => upd("id", e.target.value)} style={inputStyle} /></FF>
            <FF label="Status"><select value={form.status} onChange={e => upd("status", e.target.value)} style={selectStyle}><option value="active">Active</option><option value="inactive">Inactive</option></select></FF>
            <FF label="Region"><select value={form.region} onChange={e => upd("region", e.target.value)} style={selectStyle}><option>US</option><option>LATAM</option><option>EU</option><option>APAC</option><option>Other</option></select></FF>
            {(isExpert || isReviewer) && <>
              <FF label="Assignment"><input type="text" value={form.assignment} onChange={e => upd("assignment", e.target.value)} style={inputStyle} /></FF>
              <FF label="Join Date"><input type="date" value={form.joinDate || ""} onChange={e => upd("joinDate", e.target.value)} style={inputStyle} /></FF>
              <FF label={isExpert ? "Tasks Today" : "Reviews Today"}><input type="number" value={form.tasksToday} onChange={e => upd("tasksToday", +e.target.value || 0)} style={inputStyle} /></FF>
              <FF label={isExpert ? "Total Completed" : "Total Reviewed"}><input type="number" value={isExpert ? form.tasksCompleted : form.tasksReviewed} onChange={e => upd(isExpert ? "tasksCompleted" : "tasksReviewed", +e.target.value || 0)} style={inputStyle} /></FF>
              <FF label="Quality Score %"><input type="number" value={form.qualityScore} onChange={e => upd("qualityScore", Math.min(100, +e.target.value || 0))} style={inputStyle} /></FF>
              <FF label="Avg Speed (h)"><input type="number" value={form.avgSpeed} onChange={e => upd("avgSpeed", +e.target.value || 0)} style={inputStyle} /></FF>
              <FF label="Base Rate ($/h)"><input type="number" value={form.baseRate} onChange={e => upd("baseRate", +e.target.value || 0)} style={inputStyle} /></FF>
              <FF label="Per-Task Rate ($)"><input type="number" value={form.perTaskRate} onChange={e => upd("perTaskRate", +e.target.value || 0)} style={inputStyle} /></FF>
              <FF label="Bonus Earned ($)"><input type="number" value={form.bonusEarned} onChange={e => upd("bonusEarned", +e.target.value || 0)} style={inputStyle} /></FF>
            </>}
            {!isExpert && !isReviewer && <>
              <FF label="Role"><input type="text" value={form.role} onChange={e => upd("role", e.target.value)} style={inputStyle} /></FF>
              <FF label="Weekly Hours"><input type="number" value={form.weeklyHours} onChange={e => upd("weeklyHours", +e.target.value || 0)} style={inputStyle} /></FF>
              <FF label="Activity %"><input type="number" value={form.activityPct} onChange={e => upd("activityPct", Math.min(100, +e.target.value || 0))} style={inputStyle} /></FF>
              <FF label="Completion %"><input type="number" value={form.completionRate} onChange={e => upd("completionRate", Math.min(100, +e.target.value || 0))} style={inputStyle} /></FF>
              <FF label="Annual Salary ($)"><input type="number" value={form.salary} onChange={e => upd("salary", +e.target.value || 0)} style={inputStyle} /></FF>
              <div style={{ gridColumn: "1/-1" }}><FF label="Responsibilities"><input type="text" value={form.responsibilities} onChange={e => upd("responsibilities", e.target.value)} style={inputStyle} /></FF></div>
            </>}
          </div>
          <button onClick={save} style={btnPrimary}>{editId ? "Save Changes" : "Add"}</button>
        </Modal>
      )}
    </div>
  );
}

// ─── TICKETS KANBAN ───────────────────────────────────────────────────────────
function TicketsTab({ tickets, setTickets, experts, reviewers, opsTeam }) {
  const [search, setSearch] = useState("");
  const [filterPri, setFilterPri] = useState("all");
  const [filterAssignee, setFilterAssignee] = useState("all");
  const [modal, setModal] = useState(false);
  const [editModal, setEditModal] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [form, setForm] = useState({ title: "", priority: "Medium", type: "expert", assignee: "", owner: "", deadline: "", description: "" });
  const people = [...experts, ...reviewers, ...opsTeam].map(x => x.name).filter(Boolean);
  const filtered = tickets.filter(t =>
    (filterPri === "all" || t.priority === filterPri) &&
    (filterAssignee === "all" || t.assignee === filterAssignee) &&
    (!search || t.title.toLowerCase().includes(search.toLowerCase()) || (t.assignee || "").toLowerCase().includes(search.toLowerCase()))
  );
  const create = () => {
    if (!form.title.trim()) return;
    setTickets(p => [...p, { ...form, id: `TKT-${String(p.length + 1).padStart(3, "0")}`, status: "NOT STARTED", createdAt: new Date().toISOString().split("T")[0] }]);
    setForm({ title: "", priority: "Medium", type: "expert", assignee: "", owner: "", deadline: "", description: "" });
    setModal(false);
  };
  const saveEdit = () => { setTickets(p => p.map(t => t.id === editModal.id ? { ...t, ...editModal } : t)); setEditModal(null); };
  const del = id => setTickets(p => p.filter(t => t.id !== id));
  const move = (id, status) => setTickets(p => p.map(t => t.id === id ? { ...t, status } : t));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tickets..." style={{ ...inputStyle, flex: 1, minWidth: 160, width: "auto" }} />
        <select value={filterPri} onChange={e => setFilterPri(e.target.value)} style={{ ...selectStyle, width: 140 }}>
          <option value="all">All Priorities</option><option>High</option><option>Medium</option><option>Low</option>
        </select>
        <select value={filterAssignee} onChange={e => setFilterAssignee(e.target.value)} style={{ ...selectStyle, width: 180 }}>
          <option value="all">All Assignees</option>
          {people.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <button onClick={() => setModal(true)} style={{ ...btnSm, background: C.blue, color: "#fff", border: "none" }}>+ New Ticket</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10, overflowX: "auto", minWidth: 800 }}>
        {TICKET_STATUSES.map(status => {
          const col = filtered.filter(t => t.status === status);
          return (
            <div key={status} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (dragId) move(dragId, status); setDragId(null); }}
              style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, minHeight: 340, display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "12px 14px", borderBottom: `3px solid ${STATUS_COLORS[status]}`, display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: STATUS_COLORS[status], fontSize: 10, fontWeight: 800, letterSpacing: "0.07em" }}>{status}</span>
                <span style={{ background: STATUS_COLORS[status] + "22", color: STATUS_COLORS[status], borderRadius: "50%", width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800 }}>{col.length}</span>
              </div>
              <div style={{ padding: 9, display: "flex", flexDirection: "column", gap: 8, flex: 1, overflowY: "auto" }}>
                {col.map(t => (
                  <div key={t.id} draggable onDragStart={() => setDragId(t.id)}
                    style={{ background: "#f8fafc", border: `1px solid ${C.border}`, borderLeft: `3px solid ${PRIORITY_COLORS[t.priority]}`, borderRadius: 8, padding: "10px 12px", cursor: "grab" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                      <span style={{ color: C.faint, fontSize: 10, fontFamily: "'DM Mono',monospace" }}>{t.id}</span>
                      <Badge color={t.type === "expert" ? C.purple : t.type === "review" ? C.cyan : C.orange}>{t.type}</Badge>
                    </div>
                    <div style={{ color: C.text, fontWeight: 700, fontSize: 12, marginBottom: 5, lineHeight: 1.4 }}>{t.title}</div>
                    {t.assignee && <div style={{ color: C.muted, fontSize: 11, marginBottom: 3 }}>👤 {t.assignee}</div>}
                    {t.deadline && <div style={{ color: new Date(t.deadline) < new Date() ? C.red : C.muted, fontSize: 11, marginBottom: 5 }}>📅 {t.deadline}</div>}
                    <div style={{ display: "flex", gap: 5, justifyContent: "space-between", alignItems: "center" }}>
                      <Badge color={PRIORITY_COLORS[t.priority]}>{t.priority}</Badge>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button onClick={() => setEditModal({ ...t })} style={{ ...btnSm, padding: "2px 8px", fontSize: 10 }}>Edit</button>
                        <button onClick={() => del(t.id)} style={{ ...btnSm, padding: "2px 7px", fontSize: 10, color: C.red, borderColor: C.red + "50" }}>✕</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {modal && (
        <Modal title="Create Ticket" onClose={() => setModal(false)}>
          <FF label="Title"><input type="text" value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} style={inputStyle} placeholder="Describe the ticket..." /></FF>
          <FF label="Assignee"><select value={form.assignee} onChange={e => setForm(p => ({ ...p, assignee: e.target.value }))} style={selectStyle}><option value="">— Select —</option>{people.map(p => <option key={p} value={p}>{p}</option>)}</select></FF>
          <FF label="Owner (Ops)"><select value={form.owner} onChange={e => setForm(p => ({ ...p, owner: e.target.value }))} style={selectStyle}><option value="">— Select —</option>{opsTeam.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}</select></FF>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <FF label="Priority"><select value={form.priority} onChange={e => setForm(p => ({ ...p, priority: e.target.value }))} style={selectStyle}><option>High</option><option>Medium</option><option>Low</option></select></FF>
            <FF label="Type"><select value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))} style={selectStyle}><option value="expert">Expert</option><option value="ops">Ops</option><option value="review">Review</option></select></FF>
            <FF label="Deadline"><input type="date" value={form.deadline} onChange={e => setForm(p => ({ ...p, deadline: e.target.value }))} style={inputStyle} /></FF>
          </div>
          <FF label="Description"><textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} style={{ ...inputStyle, height: 70, resize: "vertical" }} /></FF>
          <button onClick={create} style={btnPrimary}>Create Ticket</button>
        </Modal>
      )}
      {editModal && (
        <Modal title={`Edit ${editModal.id}`} onClose={() => setEditModal(null)}>
          <FF label="Title"><input type="text" value={editModal.title} onChange={e => setEditModal(p => ({ ...p, title: e.target.value }))} style={inputStyle} /></FF>
          <FF label="Assignee"><select value={editModal.assignee || ""} onChange={e => setEditModal(p => ({ ...p, assignee: e.target.value }))} style={selectStyle}><option value="">— Unassigned —</option>{people.map(p => <option key={p} value={p}>{p}</option>)}</select></FF>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <FF label="Status"><select value={editModal.status} onChange={e => setEditModal(p => ({ ...p, status: e.target.value }))} style={selectStyle}>{TICKET_STATUSES.map(s => <option key={s}>{s}</option>)}</select></FF>
            <FF label="Priority"><select value={editModal.priority} onChange={e => setEditModal(p => ({ ...p, priority: e.target.value }))} style={selectStyle}><option>High</option><option>Medium</option><option>Low</option></select></FF>
            <FF label="Deadline"><input type="date" value={editModal.deadline || ""} onChange={e => setEditModal(p => ({ ...p, deadline: e.target.value }))} style={inputStyle} /></FF>
          </div>
          <FF label="Description"><textarea value={editModal.description || ""} onChange={e => setEditModal(p => ({ ...p, description: e.target.value }))} style={{ ...inputStyle, height: 70, resize: "vertical" }} /></FF>
          <button onClick={saveEdit} style={btnPrimary}>Save Changes</button>
        </Modal>
      )}
    </div>
  );
}

// ─── TASKS (WEEKLY TRACKER) ───────────────────────────────────────────────────
function TasksTab({ taskTracker, setTaskTracker }) {
  const [activeWeek, setActiveWeek] = useState(0);
  const addWeek = () => {
    const n = taskTracker.length + 1;
    setTaskTracker(p => [...p, { id: n, label: `Week ${n}`, goal: 0, sbqRate: 0.25, totalCB: 0, newAnnotators: 0, newReviewers: 0, oldAnnotators: 0, oldReviewers: 0, tasksPerWeekAnnotator: 5, tasksPerWeekReviewer: 15 }]);
    setActiveWeek(taskTracker.length);
  };
  const upd = (f, v) => setTaskTracker(p => p.map((w, i) => i === activeWeek ? { ...w, [f]: +v || 0 } : w));
  if (taskTracker.length === 0) return (
    <div style={{ textAlign: "center", padding: 60 }}>
      <div style={{ color: C.muted, marginBottom: 16 }}>No weeks tracked yet.</div>
      <button onClick={addWeek} style={{ ...btnSm, background: C.blue, color: "#fff", border: "none" }}>+ Add Week 1</button>
    </div>
  );
  const w = taskTracker[activeWeek];
  const attemptsNeeded = w.sbqRate < 1 && w.sbqRate > 0 ? Math.ceil(w.goal / (1 - w.sbqRate)) : w.goal;
  const actual = (w.newAnnotators + w.oldAnnotators) * w.tasksPerWeekAnnotator;
  const buffer = actual - w.goal;
  const newAnnotatorTasks = w.newAnnotators * w.tasksPerWeekAnnotator;
  const newReviewerTasks = w.newReviewers * w.tasksPerWeekReviewer;
  const completedEOW = newAnnotatorTasks;
  const reviewedEOW = Math.min(newReviewerTasks, completedEOW);
  const notReviewed = completedEOW - reviewedEOW;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {taskTracker.map((wk, i) => (
          <button key={i} onClick={() => setActiveWeek(i)} style={{ ...btnSm, background: activeWeek === i ? C.blue : C.surface, color: activeWeek === i ? "#fff" : C.text, border: activeWeek === i ? "none" : `1px solid ${C.border}` }}>{wk.label}</button>
        ))}
        <button onClick={addWeek} style={btnSm}>+ Add Week</button>
        {taskTracker.length > 0 && <button onClick={() => { if (confirm("Delete this week?")) { setTaskTracker(p => p.filter((_, i) => i !== activeWeek)); setActiveWeek(Math.max(0, activeWeek - 1)); } }} style={{ ...btnSm, color: C.red, borderColor: C.red + "50" }}>Delete Week</button>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 12, padding: 20 }}>
          <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 14 }}>📋 Tasks</div>
          {[["Goal","goal",true],["SBQ Rate %",null,false],["Attempts Needed",null,false],["Actual",null,false],["Buffer",null,false]].map(([label,field]) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #fde68a50" }}>
              <span style={{ color: C.muted, fontSize: 13 }}>{label}</span>
              {label === "Goal" ? <InNum value={w.goal} onChange={v => upd("goal", v)} width="75px" />
               : label === "SBQ Rate %" ? <InNum value={+(w.sbqRate * 100).toFixed(0)} onChange={v => upd("sbqRate", v / 100)} suffix="%" width="60px" />
               : <span style={{ fontFamily: "'DM Mono',monospace", fontWeight: 700, color: label === "Buffer" ? (buffer >= 0 ? C.green : C.red) : C.text }}>
                   {label === "Attempts Needed" ? fmt(attemptsNeeded) : label === "Actual" ? fmt(actual) : fmt(buffer)}
                 </span>}
            </div>
          ))}
        </div>
        <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: 20 }}>
          <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 14 }}>👥 Contributors (CB)</div>
          {[["Total CB","totalCB"],["New Annotators","newAnnotators"],["New Reviewers","newReviewers"],["Old Annotators","oldAnnotators"],["Old Reviewers","oldReviewers"]].map(([label,field]) => (
            <div key={field} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #bfdbfe50" }}>
              <span style={{ color: C.muted, fontSize: 13 }}>{label}</span>
              <InNum value={w[field]} onChange={v => upd(field, v)} width="65px" />
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Total Annotators</span>
            <span style={{ fontFamily: "'DM Mono',monospace", fontWeight: 800, color: C.blue }}>{w.newAnnotators + w.oldAnnotators}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Total Reviewers</span>
            <span style={{ fontFamily: "'DM Mono',monospace", fontWeight: 800, color: C.purple }}>{w.newReviewers + w.oldReviewers}</span>
          </div>
        </div>
        <div style={{ background: "#fdf4ff", border: "1px solid #e9d5ff", borderRadius: 12, padding: 20 }}>
          <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 14 }}>⚙️ Work</div>
          {[["Tasks/Week (Annotator)","tasksPerWeekAnnotator"],["Tasks/Week (Reviewer)","tasksPerWeekReviewer"]].map(([label,field]) => (
            <div key={field} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #e9d5ff50" }}>
              <span style={{ color: C.muted, fontSize: 13 }}>{label}</span>
              <InNum value={w[field]} onChange={v => upd(field, v)} width="65px" />
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #e9d5ff50" }}>
            <span style={{ color: C.muted, fontSize: 13 }}>New Annotator Tasks</span>
            <span style={{ fontFamily: "'DM Mono',monospace", fontWeight: 700 }}>{fmt(newAnnotatorTasks)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}>
            <span style={{ color: C.muted, fontSize: 13 }}>New Reviewer Tasks</span>
            <span style={{ fontFamily: "'DM Mono',monospace", fontWeight: 700 }}>{fmt(newReviewerTasks)}</span>
          </div>
        </div>
      </div>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 22 }}>
        <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 16 }}>📊 End of Week Totals (Auto-calculated)</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
          {[["Completed",completedEOW,C.green,C.greenSoft,"New Annotators × Tasks/Week"],["Reviewed",reviewedEOW,C.blue,C.blueSoft,"min(Reviewer Tasks, Completed)"],["Not Reviewed",notReviewed,C.yellow,C.yellowSoft,"Completed − Reviewed"]].map(([label,val,color,bg,note]) => (
            <div key={label} style={{ background: bg, borderRadius: 10, padding: 18, textAlign: "center" }}>
              <div style={{ color, fontWeight: 800, fontSize: 28, fontFamily: "'DM Mono',monospace" }}>{fmt(val)}</div>
              <div style={{ color, fontWeight: 700, fontSize: 13, marginTop: 4 }}>{label}</div>
              <div style={{ color: C.muted, fontSize: 11, marginTop: 4 }}>{note}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── RAMP PLAN (per NES phase) ────────────────────────────────────────────────
function RampPlanTab({ rampData, setRampData }) {
  const [active, setActive] = useState(0);
  const s = rampData[active];
  const upd = (f, v) => setRampData(p => p.map((x, i) => i === active ? { ...x, [f]: +v || 0 } : x));
  const updTarget = (wi, v) => setRampData(p => p.map((x, i) => { if (i !== active) return x; const t = [...x.taskTargets]; t[wi] = +v || 0; return { ...x, taskTargets: t }; }));
  const aht = s.attemptAHT + s.reviewAHT;
  const tasksPerCB = aht > 0 ? s.cbHoursPerWeek / aht : 0;
  const totalProd = tasksPerCB * s.totalTasks;
  const sbqAffected = Math.round(totalProd * s.sbqDefault);
  const effective = totalProd - sbqAffected;
  const totalTargets = s.taskTargets.reduce((a, b) => a + (b || 0), 0);
  const phase = PHASES.find(p => p.id === s.id);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 20px" }}>
        <div style={{ color: C.muted, fontSize: 11, fontWeight: 700, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.07em" }}>NES Project Phase</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {rampData.map((x, i) => {
            const ph = PHASES.find(p => p.id === x.id);
            return (
              <button key={i} onClick={() => setActive(i)} style={{ ...btnSm, background: active === i ? (ph?.color || C.blue) : C.surface, color: active === i ? "#fff" : C.text, border: active === i ? "none" : `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 6 }}>
                {active === i && <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#fff" }} />}
                {x.name}
              </button>
            );
          })}
        </div>
      </div>

      {phase && (
        <div style={{ background: (phase.color || C.blue) + "12", border: `1px solid ${phase.color || C.blue}30`, borderRadius: 10, padding: "14px 20px", display: "flex", gap: 24 }}>
          <div><span style={{ color: C.muted, fontSize: 12 }}>Phase Target Tasks</span><div style={{ fontFamily: "'DM Mono',monospace", fontWeight: 800, fontSize: 18, color: phase.color }}>{fmt(phase.tasks)}</div></div>
          <div><span style={{ color: C.muted, fontSize: 12 }}>Duration</span><div style={{ fontFamily: "'DM Mono',monospace", fontWeight: 800, fontSize: 18, color: phase.color }}>{phase.weeks}w</div></div>
          <div><span style={{ color: C.muted, fontSize: 12 }}>Ramp Target</span><div style={{ fontFamily: "'DM Mono',monospace", fontWeight: 800, fontSize: 18, color: totalTargets === s.totalTasks ? C.green : C.yellow }}>{fmt(totalTargets)} / {fmt(s.totalTasks)}</div></div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <SectionCard title="Task Configuration">
          {[["Total Tasks","totalTasks",false],["Attempt AHT (hrs)","attemptAHT",false],["Review AHT (hrs)","reviewAHT",false],["AHT End-to-End",null,true,`${fmt(aht,2)} hrs`],["SBQ Rate","sbqDefault",false,"%",true],["CB Hours/Week","cbHoursPerWeek",false],["New Hires/Week","newHiresPerWeek",false],["Promotion Rate","promotionRate",false,"%",true],["1st Week Capacity","firstWeekCapacity",false,"%",true]].map(([label,field,calc,display,isPct]) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ color: C.muted, fontSize: 13 }}>{label}</span>
              {calc ? <span style={{ fontFamily: "'DM Mono',monospace", fontWeight: 700, color: C.blue }}>{display}</span>
                : <InNum value={isPct ? +(s[field] * 100).toFixed(1) : s[field]} onChange={v => upd(field, isPct ? v / 100 : v)} suffix={isPct ? "%" : ""} width="85px" />}
            </div>
          ))}
        </SectionCard>
        <SectionCard title="Weekly Production (Auto-calculated)">
          {[["Tasks per CB/Week",fmt(tasksPerCB,1),C.blue],["Total Hours",fmt(s.totalTasks * s.cbHoursPerWeek),C.muted],["Total Tasks Produced",fmt(totalProd,0),C.text],["Attempts per CB",s.attemptAHT > 0 ? fmt(s.cbHoursPerWeek / s.attemptAHT,0) : "—",C.muted],["Reviews per CB",s.reviewAHT > 0 ? fmt(s.cbHoursPerWeek / s.reviewAHT,0) : "—",C.muted],["Affected by SBQ",fmt(sbqAffected),C.yellow],["Effective Production",fmt(effective),C.green],["Total (Produced + SBQ)",fmt(totalProd + sbqAffected),C.text],["Effort to Full Prod (hrs)",fmt((totalProd + sbqAffected) * aht,0),C.orange]].map(([label,val,color]) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ color: C.muted, fontSize: 13 }}>{label}</span>
              <span style={{ fontFamily: "'DM Mono',monospace", fontWeight: 700, color }}>{val}</span>
            </div>
          ))}
        </SectionCard>
      </div>
      <SectionCard title="Weekly Schedule" extra={<span style={{ color: C.muted, fontSize: 13 }}>Total: <strong style={{ color: totalTargets === s.totalTasks ? C.green : C.yellow }}>{fmt(totalTargets)} / {fmt(s.totalTasks)}</strong></span>}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr style={{ background: "#f8fafc" }}>
              {s.weeks.map(w => <th key={w} style={{ padding: "8px 12px", color: C.muted, fontSize: 11, fontWeight: 700, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>{w}</th>)}
              <th style={{ padding: "8px 12px", color: C.muted, fontSize: 11, fontWeight: 700, borderBottom: `1px solid ${C.border}` }}>TOTAL</th>
            </tr></thead>
            <tbody><tr>
              {s.taskTargets.map((t, wi) => (
                <td key={wi} style={{ padding: "10px 12px", textAlign: "center", borderBottom: `1px solid ${C.border}` }}>
                  <InNum value={t} onChange={v => updTarget(wi, v)} width="65px" />
                </td>
              ))}
              <td style={{ padding: "10px 12px", textAlign: "center", fontFamily: "'DM Mono',monospace", fontWeight: 800, color: totalTargets === s.totalTasks ? C.green : C.yellow }}>{fmt(totalTargets)}</td>
            </tr></tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

// ─── FINANCIALS ───────────────────────────────────────────────────────────────
function FinancialsTab({ experts, reviewers, opsTeam, financials, setFinancials, phaseFinancials, setPhaseFinancials }) {
  const [activePhase, setActivePhase] = useState("p0_unified");
  const updF = (f, v) => setFinancials(p => ({ ...p, [f]: +v || 0 }));
  const updPF = (ph, f, v) => setPhaseFinancials(p => ({ ...p, [ph]: { ...(p[ph] || {}), [f]: +v || 0 } }));
  const pf = phaseFinancials[activePhase] || {};
  const phase = PHASES.find(p => p.id === activePhase);
  const regionRates = financials.regionRates || { US: 30, EU: 22, LATAM: 12, APAC: 10, Other: 15 };
  const updRegion = (r, v) => setFinancials(p => ({ ...p, regionRates: { ...(p.regionRates || {}), [r]: +v || 0 } }));

  const totalRev = PHASES.reduce((s, p) => s + (phaseFinancials[p.id]?.revenue || p.revenue), 0);
  const totalCosts = experts.reduce((s, e) => s + e.tasksCompleted * e.perTaskRate + e.bonusEarned, 0)
    + reviewers.reduce((s, r) => s + r.tasksReviewed * r.perTaskRate + r.bonusEarned, 0)
    + opsTeam.reduce((s, o) => s + o.salary / 12, 0)
    + (financials.infrastructureCost || 0) + (financials.otherOverhead || 0);
  const margin = totalRev > 0 ? (totalRev - totalCosts) / totalRev * 100 : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
        <KpiCard label="Total Revenue" value={totalRev > 0 ? fmtUSD(totalRev) : "—"} color={C.blue} icon="💰" />
        <KpiCard label="Total Costs" value={totalCosts > 0 ? fmtUSD(totalCosts) : "—"} color={C.orange} icon="💸" />
        <KpiCard label="Gross Margin" value={totalRev > 0 ? fmtPct(margin) : "—"} color={margin >= (financials.targetMargin || 35) ? C.green : C.red} icon="📊" delta={totalRev > 0 ? margin - (financials.targetMargin || 35) : null} />
        <KpiCard label="Net Profit" value={totalRev > 0 ? fmtUSD(totalRev - totalCosts) : "—"} color={(totalRev - totalCosts) >= 0 ? C.green : C.red} icon="✨" />
      </div>

      <SectionCard title="Phase-by-Phase Financials">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
          {PHASES.map(p => (
            <button key={p.id} onClick={() => setActivePhase(p.id)} style={{ ...btnSm, background: activePhase === p.id ? (p.color || C.blue) : C.surface, color: activePhase === p.id ? "#fff" : C.text, border: activePhase === p.id ? "none" : `1px solid ${C.border}` }}>{p.name}</button>
          ))}
        </div>
        {phase && (
          <div style={{ background: (phase.color) + "10", border: `1px solid ${phase.color}30`, borderRadius: 8, padding: "10px 16px", marginBottom: 18, display: "flex", gap: 20 }}>
            <span style={{ color: C.muted, fontSize: 13 }}>Phase: <strong style={{ color: phase.color }}>{phase.name}</strong></span>
            <span style={{ color: C.muted, fontSize: 13 }}>Target Tasks: <strong>{fmt(phase.tasks)}</strong></span>
            <span style={{ color: C.muted, fontSize: 13 }}>Duration: <strong>{phase.weeks}w</strong></span>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          <div>
            <div style={{ color: C.muted, fontSize: 11, fontWeight: 700, marginBottom: 12, textTransform: "uppercase" }}>Revenue & Budget</div>
            {[["Revenue from Client","revenue",true],["Budget Allocated","budget",true],["Task Count","taskCount",false],["Duration (weeks)","durationWeeks",false]].map(([label,field,isMoney]) => {
              const def = field === "revenue" ? phase?.revenue : field === "taskCount" ? phase?.tasks : field === "durationWeeks" ? phase?.weeks : 0;
              return (
                <div key={field} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                  <span style={{ color: C.muted, fontSize: 13 }}>{label}</span>
                  <InNum value={pf[field] ?? def ?? 0} onChange={v => updPF(activePhase, field, v)} prefix={isMoney ? "$" : ""} width="100px" />
                </div>
              );
            })}
          </div>
          <div>
            <div style={{ color: C.muted, fontSize: 11, fontWeight: 700, marginBottom: 12, textTransform: "uppercase" }}>Cost Tracking</div>
            {[["Expert Task Cost","expertCost"],["Reviewer Task Cost","reviewerCost"],["Ops Overhead","opsCost"],["Infrastructure","infraCost"],["Other","otherCost"]].map(([label,field]) => (
              <div key={field} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                <span style={{ color: C.muted, fontSize: 13 }}>{label}</span>
                <InNum value={pf[field] || 0} onChange={v => updPF(activePhase, field, v)} prefix="$" width="100px" />
              </div>
            ))}
            {(() => {
              const phaseCost = ["expertCost","reviewerCost","opsCost","infraCost","otherCost"].reduce((s,f) => s + (pf[f]||0), 0);
              const phaseRev = pf.revenue || phase?.revenue || 0;
              const pm = phaseRev > 0 ? (phaseRev - phaseCost) / phaseRev * 100 : 0;
              return (<>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 0" }}>
                  <span style={{ fontWeight: 800 }}>Phase Total Cost</span>
                  <span style={{ fontFamily: "'DM Mono',monospace", fontWeight: 800, color: C.red }}>{fmtUSD(phaseCost)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 800 }}>Phase Margin</span>
                  <span style={{ fontFamily: "'DM Mono',monospace", fontWeight: 800, color: pm >= (financials.targetMargin || 35) ? C.green : C.red }}>{fmtPct(pm)}</span>
                </div>
              </>);
            })()}
          </div>
        </div>
      </SectionCard>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <SectionCard title="Global Settings">
          {[["Infrastructure Cost ($)","infrastructureCost"],["Other Overhead ($)","otherOverhead"],["Target Margin %","targetMargin"],["Quality Threshold %","qualityThreshold"]].map(([label,field]) => (
            <div key={field} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ color: C.muted, fontSize: 13 }}>{label}</span>
              <InNum value={financials[field] || 0} onChange={v => updF(field, v)} width="90px" />
            </div>
          ))}
        </SectionCard>
        <SectionCard title="Regional Tiered Rates ($/task)">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <TH cols={["Region","Rate ($/task)","Experts","Reviewers","Ops"]} />
            <tbody>
              {["US","EU","LATAM","APAC","Other"].map(r => (
                <tr key={r} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ padding: "10px 14px", fontWeight: 700 }}>{r}</td>
                  <td style={{ padding: "10px 14px" }}><InNum value={regionRates[r] || 0} onChange={v => updRegion(r, v)} prefix="$" width="70px" /></td>
                  <td style={{ padding: "10px 14px", fontFamily: "'DM Mono',monospace" }}>{experts.filter(e => e.region === r).length}</td>
                  <td style={{ padding: "10px 14px", fontFamily: "'DM Mono',monospace" }}>{reviewers.filter(x => x.region === r).length}</td>
                  <td style={{ padding: "10px 14px", fontFamily: "'DM Mono',monospace" }}>{opsTeam.filter(x => x.region === r).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      </div>

      {financials.bonusTiers && (
        <SectionCard title="Bonus Structure">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
            {financials.bonusTiers.map((tier, i) => {
              const tc = [C.orange,C.muted,C.yellow][i];
              const qualified = experts.filter(e => e.tasksCompleted >= tier.minTasks && e.qualityScore >= tier.minQuality).length;
              return (
                <div key={tier.name} style={{ background: tc + "10", border: `1px solid ${tc}30`, borderRadius: 10, padding: 18 }}>
                  <div style={{ color: tc, fontWeight: 800, fontSize: 16, marginBottom: 12 }}>{tier.name}</div>
                  {[["Min Tasks","minTasks"],["Min Quality %","minQuality"],["Bonus ($)","bonusAmt"]].map(([l,f]) => (
                    <div key={f} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ color: C.muted, fontSize: 12 }}>{l}</span>
                      <InNum value={tier[f]} onChange={v => setFinancials(p => { const t = [...p.bonusTiers]; t[i] = { ...t[i], [f]: v }; return { ...p, bonusTiers: t }; })} width="70px" />
                    </div>
                  ))}
                  <div style={{ marginTop: 10, padding: 10, background: tc + "20", borderRadius: 8, textAlign: "center" }}>
                    <div style={{ color: tc, fontWeight: 800, fontSize: 20 }}>{qualified}</div>
                    <div style={{ color: C.muted, fontSize: 11 }}>qualify → {fmtUSD(qualified * tier.bonusAmt)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

// ─── DASHBOARD (no financials) ────────────────────────────────────────────────
function DashboardTab({ experts, reviewers, opsTeam, tickets, financials }) {
  const tasksToday = experts.reduce((s, e) => s + e.tasksToday, 0) + reviewers.reduce((s, r) => s + r.tasksToday, 0);
  const totalDone = experts.reduce((s, e) => s + e.tasksCompleted, 0);
  const totalReviewed = reviewers.reduce((s, r) => s + r.tasksReviewed, 0);
  const avgQ = [...experts, ...reviewers].filter(x => x.qualityScore > 0);
  const avgQuality = avgQ.length ? avgQ.reduce((s, x) => s + x.qualityScore, 0) / avgQ.length : 0;
  const byStatus = TICKET_STATUSES.map(s => ({ name: s, count: tickets.filter(t => t.status === s).length }));
  const highPri = tickets.filter(t => t.priority === "High" && t.status !== "COMPLETED");
  const overdue = tickets.filter(t => t.deadline && new Date(t.deadline) < new Date() && t.status !== "COMPLETED");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
        <KpiCard label="Active Experts" value={experts.filter(e => e.status === "active").length} sub={`${experts.length} total`} color={C.blue} icon="👥" />
        <KpiCard label="Active Reviewers" value={reviewers.filter(r => r.status === "active").length} sub={`${reviewers.length} total`} color={C.purple} icon="🔍" />
        <KpiCard label="Tasks Today" value={fmt(tasksToday)} sub="all contributors" color={C.green} icon="✅" />
        <KpiCard label="Avg Quality" value={avgQuality > 0 ? fmtPct(avgQuality) : "—"} color={avgQuality >= (financials.qualityThreshold || 90) ? C.green : avgQuality > 0 ? C.red : C.faint} icon="⭐" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
        <KpiCard label="Total Completed" value={fmt(totalDone)} sub="by experts" color={C.muted} icon="📊" />
        <KpiCard label="Total Reviewed" value={fmt(totalReviewed)} sub="by reviewers" color={C.purple} icon="📋" />
        <KpiCard label="High Priority Tickets" value={highPri.length} color={highPri.length > 0 ? C.red : C.green} icon="🚨" />
        <KpiCard label="Overdue Tickets" value={overdue.length} color={overdue.length > 0 ? C.red : C.green} icon="⏰" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <SectionCard title="Ticket Pipeline">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {byStatus.map(({ name, count }) => (
              <div key={name}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                  <span style={{ color: STATUS_COLORS[name], fontSize: 11, fontWeight: 700 }}>{name}</span>
                  <span style={{ fontFamily: "'DM Mono',monospace", fontWeight: 700, fontSize: 13 }}>{count}</span>
                </div>
                <div style={{ background: C.border, borderRadius: 4, height: 7 }}>
                  <div style={{ background: STATUS_COLORS[name], height: 7, borderRadius: 4, width: tickets.length ? `${count / tickets.length * 100}%` : "0%", transition: "width 0.4s" }} />
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
        <SectionCard title="Team Composition">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[
              ["Experts", experts.filter(e => e.status === "active").length, experts.length, C.blue],
              ["Reviewers", reviewers.filter(r => r.status === "active").length, reviewers.length, C.purple],
              ["Ops Team", opsTeam.filter(o => o.status === "active").length, opsTeam.length, C.orange],
            ].map(([label, active, total, color]) => (
              <div key={label}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ color, fontSize: 12, fontWeight: 700 }}>{label}</span>
                  <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 13 }}>{active} / {total} active</span>
                </div>
                <div style={{ background: C.border, borderRadius: 4, height: 8 }}>
                  <div style={{ background: color, height: 8, borderRadius: 4, width: total ? `${active / total * 100}%` : "0%", transition: "width 0.4s" }} />
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
            <div style={{ color: C.muted, fontSize: 12, fontWeight: 700, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Today's Output</div>
            <div style={{ display: "flex", gap: 20 }}>
              <div><div style={{ fontFamily: "'DM Mono',monospace", fontWeight: 800, fontSize: 22, color: C.blue }}>{fmt(experts.reduce((s,e) => s + e.tasksToday, 0))}</div><div style={{ color: C.muted, fontSize: 12 }}>Attempts</div></div>
              <div><div style={{ fontFamily: "'DM Mono',monospace", fontWeight: 800, fontSize: 22, color: C.purple }}>{fmt(reviewers.reduce((s,r) => s + r.tasksToday, 0))}</div><div style={{ color: C.muted, fontSize: 12 }}>Reviews</div></div>
            </div>
          </div>
        </SectionCard>
      </div>
      {overdue.length > 0 && (
        <SectionCard title="⏰ Overdue Tickets">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {overdue.slice(0, 5).map(t => (
              <div key={t.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", background: C.redSoft, borderRadius: 8 }}>
                <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 12, color: C.muted }}>{t.id}</span>
                <span style={{ fontWeight: 700 }}>{t.title}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <Badge color={PRIORITY_COLORS[t.priority]}>{t.priority}</Badge>
                  <span style={{ color: C.red, fontSize: 12 }}>Due: {t.deadline}</span>
                </div>
              </div>
            ))}
            {overdue.length > 5 && <div style={{ color: C.muted, fontSize: 13, textAlign: "center" }}>+{overdue.length - 5} more overdue tickets</div>}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

// ─── VISUALIZATIONS (no financials) ──────────────────────────────────────────
function VisualizationsTab({ experts, reviewers, tickets, financials }) {
  const ticketData = TICKET_STATUSES.map(s => ({ name: s.split("/")[0], value: tickets.filter(t => t.status === s).length, color: STATUS_COLORS[s] }));
  const qualityData = [...experts, ...reviewers].filter(x => x.qualityScore > 0).map(x => ({ name: x.name.split(" ")[0], quality: x.qualityScore, type: experts.includes(x) ? "Expert" : "Reviewer" }));
  const regionData = ["US","EU","LATAM","APAC","Other"].map(r => ({ region: r, experts: experts.filter(e => e.region === r).length, reviewers: reviewers.filter(x => x.region === r).length })).filter(x => x.experts + x.reviewers > 0);
  const priorityData = ["High","Medium","Low"].map(p => ({ priority: p, open: tickets.filter(t => t.priority === p && t.status !== "COMPLETED").length, done: tickets.filter(t => t.priority === p && t.status === "COMPLETED").length }));
  const chart = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 22 };
  const chartTitle = { color: C.muted, fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 16 };
  const empty = <div style={{ color: C.faint, textAlign: "center", padding: 50, fontSize: 14 }}>Add data to see this chart</div>;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
      <div style={chart}>
        <div style={chartTitle}>Ticket Status Distribution</div>
        {tickets.length === 0 ? empty : (
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={ticketData.filter(d => d.value > 0)} cx="50%" cy="50%" outerRadius={80} dataKey="value" label={({ name, value }) => `${name} (${value})`} labelLine={false}>
                {ticketData.map((e, i) => <Cell key={i} fill={e.color} />)}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>
      <div style={chart}>
        <div style={chartTitle}>Ticket Priority Breakdown</div>
        {tickets.length === 0 ? empty : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={priorityData}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="priority" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip contentStyle={{ borderRadius: 8 }} />
              <Legend />
              <Bar dataKey="open" name="Open" fill={C.red} radius={[4,4,0,0]} />
              <Bar dataKey="done" name="Done" fill={C.green} radius={[4,4,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      <div style={chart}>
        <div style={chartTitle}>Quality Scores</div>
        {qualityData.length === 0 ? empty : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={qualityData}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis domain={[80,100]} tick={{ fontSize: 10 }} />
              <Tooltip contentStyle={{ borderRadius: 8 }} />
              <Bar dataKey="quality" name="Quality %" radius={[4,4,0,0]}>
                {qualityData.map((e, i) => <Cell key={i} fill={e.quality >= (financials.qualityThreshold || 90) ? C.green : C.red} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      <div style={chart}>
        <div style={chartTitle}>Team by Region</div>
        {regionData.length === 0 ? empty : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={regionData}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="region" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip contentStyle={{ borderRadius: 8 }} />
              <Legend />
              <Bar dataKey="experts" name="Experts" fill={C.blue} radius={[4,4,0,0]} />
              <Bar dataKey="reviewers" name="Reviewers" fill={C.purple} radius={[4,4,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ─── RISK ─────────────────────────────────────────────────────────────────────
function RiskTab({ experts, reviewers, tickets, financials, opsTeam }) {
  const threshold = financials.qualityThreshold || 90;
  const belowQ = [...experts, ...reviewers].filter(x => x.status === "active" && x.qualityScore > 0 && x.qualityScore < threshold);
  const overdue = tickets.filter(t => t.deadline && new Date(t.deadline) < new Date() && t.status !== "COMPLETED");
  const backlog = tickets.filter(t => t.status === "PENDING REVIEW");
  const rejected = tickets.filter(t => t.status === "REJECTED/REWORK");
  const risks = [
    { id: "q", level: belowQ.length > 2 ? "HIGH" : belowQ.length > 0 ? "MEDIUM" : "LOW", title: "Quality Below Threshold", desc: `${belowQ.length} contributor(s) below ${threshold}%`, detail: belowQ.map(x => `${x.name}: ${fmtPct(x.qualityScore)}`).join(", ") || "All contributors above threshold ✓" },
    { id: "o", level: overdue.length > 5 ? "HIGH" : overdue.length > 0 ? "MEDIUM" : "LOW", title: "Overdue Tickets", desc: `${overdue.length} ticket(s) past deadline`, detail: overdue.slice(0, 3).map(t => `${t.id}: ${t.title}`).join(" | ") || "No overdue tickets ✓" },
    { id: "b", level: backlog.length > 10 ? "HIGH" : backlog.length > 4 ? "MEDIUM" : "LOW", title: "Review Bottleneck", desc: `${backlog.length} in Pending Review`, detail: backlog.length > 4 ? "Queue growing — add reviewer capacity" : "Manageable ✓" },
    { id: "r", level: rejected.length > 5 ? "HIGH" : rejected.length > 2 ? "MEDIUM" : "LOW", title: "High Rejection Rate", desc: `${rejected.length} rejected/rework`, detail: rejected.length > 2 ? "Elevated rejection — check training" : "Normal ✓" },
  ];
  const rc = { HIGH: C.red, MEDIUM: C.yellow, LOW: C.green };
  const rb = { HIGH: C.redSoft, MEDIUM: C.yellowSoft, LOW: C.greenSoft };

  // Weekly report (no financial data)
  const [copied, setCopied] = useState(false);
  const report = `GITHUB NES OPS CENTER — WEEKLY SNAPSHOT\nGenerated: ${new Date().toLocaleDateString()}\n${"─".repeat(48)}\n\nTEAM\n• Active Experts: ${experts.filter(e => e.status === "active").length}/${experts.length}\n• Active Reviewers: ${reviewers.filter(r => r.status === "active").length}/${reviewers.length}\n• Ops Members: ${opsTeam.length}\n\nTASKS TODAY\n• Attempts: ${experts.reduce((s,e)=>s+e.tasksToday,0)}\n• Reviews: ${reviewers.reduce((s,r)=>s+r.tasksToday,0)}\n\nTICKET PIPELINE\n${TICKET_STATUSES.map(s => `• ${s}: ${tickets.filter(t => t.status === s).length}`).join("\n")}\n\nRISK FLAGS\n• Below Quality Threshold: ${belowQ.length}\n• Overdue Tickets: ${overdue.length}\n• Pending Review: ${backlog.length}\n• Rejected/Rework: ${rejected.length}`;
  const copy = () => { navigator.clipboard.writeText(report); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
        <KpiCard label="High Risk" value={risks.filter(r => r.level === "HIGH").length} color={C.red} icon="🚨" />
        <KpiCard label="Medium Risk" value={risks.filter(r => r.level === "MEDIUM").length} color={C.yellow} icon="⚠️" />
        <KpiCard label="Clear" value={risks.filter(r => r.level === "LOW").length} color={C.green} icon="✅" />
      </div>
      {risks.map(risk => (
        <div key={risk.id} style={{ background: rb[risk.level], border: `1px solid ${rc[risk.level]}30`, borderLeft: `4px solid ${rc[risk.level]}`, borderRadius: 10, padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontWeight: 800, fontSize: 15 }}>{risk.title}</span>
            <Badge color={rc[risk.level]}>{risk.level}</Badge>
          </div>
          <div style={{ color: C.muted, fontSize: 13, marginBottom: 8 }}>{risk.desc}</div>
          <div style={{ color: C.muted, fontSize: 12, background: "#fff8", padding: "8px 12px", borderRadius: 8 }}>{risk.detail}</div>
        </div>
      ))}
      {belowQ.length > 0 && (
        <SectionCard title="⚠️ Contributors Needing Attention">
          {belowQ.map(x => (
            <div key={x.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", background: C.redSoft, borderRadius: 8, marginBottom: 8 }}>
              <span style={{ fontWeight: 700 }}>{x.name}</span>
              <span style={{ color: C.muted, fontSize: 13 }}>{x.assignment || x.role}</span>
              <span style={{ color: C.red, fontFamily: "'DM Mono',monospace", fontWeight: 700 }}>{fmtPct(x.qualityScore)} <span style={{ color: C.muted, fontSize: 11 }}>(-{fmtPct(threshold - x.qualityScore)} gap)</span></span>
            </div>
          ))}
        </SectionCard>
      )}
      <SectionCard title="📋 Weekly Report" extra={<button onClick={copy} style={{ ...btnSm, background: copied ? C.green : C.blue, color: "#fff", border: "none" }}>{copied ? "✓ Copied!" : "Copy Report"}</button>}>
        <pre style={{ color: C.muted, fontSize: 12, fontFamily: "'DM Mono',monospace", lineHeight: 1.8, whiteSpace: "pre-wrap", margin: 0 }}>{report}</pre>
      </SectionCard>
    </div>
  );
}

// ─── ACCESS TAB ───────────────────────────────────────────────────────────────
function AccessTab({ accessUsers, setAccessUsers }) {
  const [modal, setModal] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [showPins, setShowPins] = useState(false);

  const blankForm = () => ({
    name: "", email: "", role: "viewer", pin: "",
    tabs: { Dashboard: true, Experts: true, Reviewers: true, "Ops Team": false, Tickets: true, Tasks: true, "Ramp Plan": false, Visualizations: true, Risk: true },
  });
  const [form, setForm] = useState(blankForm());

  const save = () => {
    if (!form.name.trim() || !form.pin.trim()) return;
    if (editUser) {
      setAccessUsers(p => p.map(u => u.id === editUser.id ? { ...form, id: u.id, addedAt: u.addedAt } : u));
      setEditUser(null);
    } else {
      setAccessUsers(p => [...p, { ...form, id: Date.now().toString(), addedAt: new Date().toISOString().split("T")[0] }]);
    }
    setForm(blankForm());
    setModal(false);
  };
  const openEdit = u => { setForm({ name: u.name, email: u.email || "", role: u.role, pin: u.pin || "", tabs: u.tabs || {} }); setEditUser(u); setModal(true); };
  const del = id => { if (confirm("Remove this user?")) setAccessUsers(p => p.filter(u => u.id !== id)); };
  const toggleTab = tab => setForm(p => ({ ...p, tabs: { ...p.tabs, [tab]: !p.tabs[tab] } }));

  const presets = {
    "View Only": { Dashboard: true, Experts: false, Reviewers: false, "Ops Team": false, Tickets: false, Tasks: false, "Ramp Plan": false, Visualizations: true, Risk: false },
    "Ops Member": { Dashboard: true, Experts: true, Reviewers: true, "Ops Team": true, Tickets: true, Tasks: true, "Ramp Plan": false, Visualizations: true, Risk: true },
    "Full Access (no Financials)": { Dashboard: true, Experts: true, Reviewers: true, "Ops Team": true, Tickets: true, Tasks: true, "Ramp Plan": true, Visualizations: true, Risk: true },
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ background: C.blueSoft, border: `1px solid ${C.blue}30`, borderRadius: 12, padding: 18 }}>
        <div style={{ color: C.blueText, fontWeight: 700, marginBottom: 8, fontSize: 15 }}>🔐 How PIN-based Access Works</div>
        <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.7 }}>
          When someone opens the dashboard URL, they'll see a PIN login screen. You assign each person a unique PIN here, and their access is limited to only the tabs you check below. <strong>Financials and Access tabs are always admin-only</strong> and never visible to PIN users. The admin PIN is <strong style={{ fontFamily: "'DM Mono',monospace", color: C.navy }}>"ADMIN"</strong> — change this in your source code before deploying (look for <code style={{ fontFamily: "'DM Mono',monospace", background: "#fff", padding: "1px 5px", borderRadius: 4 }}>pin === "ADMIN"</code>).
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setForm(blankForm()); setEditUser(null); setModal(true); }} style={{ ...btnSm, background: C.blue, color: "#fff", border: "none" }}>+ Add User</button>
          <button onClick={() => setShowPins(p => !p)} style={btnSm}>{showPins ? "Hide PINs" : "Reveal PINs"}</button>
        </div>
        <span style={{ color: C.muted, fontSize: 13 }}>{accessUsers.length} user(s) with access</span>
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <TH cols={["Name","Email","Role","PIN","Tab Access","Added","Actions"]} />
          <tbody>
            {accessUsers.length === 0 && <tr><td colSpan={7} style={{ padding: 40, textAlign: "center", color: C.faint }}>No users added yet. Click "+ Add User" to grant access.</td></tr>}
            {accessUsers.map((u, i) => {
              const enabledTabs = Object.entries(u.tabs || {}).filter(([, v]) => v).map(([k]) => k);
              return (
                <tr key={u.id} style={{ borderTop: `1px solid ${C.border}`, background: i % 2 ? "#fafafa" : C.surface }}>
                  <td style={{ padding: "12px 14px", fontWeight: 700 }}>{u.name}</td>
                  <td style={{ padding: "12px 14px", color: C.muted, fontSize: 13 }}>{u.email || "—"}</td>
                  <td style={{ padding: "12px 14px" }}><Badge color={u.role === "admin" ? C.red : u.role === "editor" ? C.blue : C.green}>{u.role}</Badge></td>
                  <td style={{ padding: "12px 14px", fontFamily: "'DM Mono',monospace", fontSize: 13 }}>{showPins ? (u.pin || "—") : "••••"}</td>
                  <td style={{ padding: "12px 14px" }}>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {enabledTabs.length === 0 ? <span style={{ color: C.faint, fontSize: 12 }}>No tabs</span>
                        : enabledTabs.map(t => <Badge key={t} color={C.blue}>{t}</Badge>)}
                    </div>
                  </td>
                  <td style={{ padding: "12px 14px", color: C.muted, fontSize: 12 }}>{u.addedAt}</td>
                  <td style={{ padding: "12px 14px" }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => openEdit(u)} style={{ ...btnSm, padding: "3px 10px", fontSize: 12 }}>Edit</button>
                      <button onClick={() => del(u.id)} style={{ ...btnSm, padding: "3px 10px", fontSize: 12, color: C.red, borderColor: C.red + "50" }}>Remove</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal title={editUser ? "Edit User Access" : "Add User Access"} onClose={() => { setModal(false); setEditUser(null); }} width={580}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <FF label="Name"><input type="text" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} style={inputStyle} placeholder="Full name" /></FF>
            <FF label="Email (optional)"><input type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} style={inputStyle} placeholder="email@company.com" /></FF>
            <FF label="Role"><select value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))} style={selectStyle}><option value="viewer">Viewer</option><option value="editor">Editor</option></select></FF>
            <FF label="PIN (they'll type this to log in)"><input type="text" value={form.pin} onChange={e => setForm(p => ({ ...p, pin: e.target.value }))} style={{ ...inputStyle, fontFamily: "'DM Mono',monospace" }} placeholder="e.g. NES2024" /></FF>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ color: C.muted, fontSize: 11, fontWeight: 700, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Tab Access — Presets</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
              {Object.entries(presets).map(([label, tabs]) => (
                <button key={label} onClick={() => setForm(p => ({ ...p, tabs }))} style={{ ...btnSm, fontSize: 12 }}>{label}</button>
              ))}
            </div>
            <div style={{ color: C.muted, fontSize: 11, fontWeight: 700, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>Or pick individually</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {CONTROLLABLE_TABS.map(tab => (
                <label key={tab} style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer", fontSize: 13, padding: "8px 12px", background: form.tabs[tab] ? C.blueSoft : "#f8fafc", border: `1px solid ${form.tabs[tab] ? C.blue + "50" : C.border}`, borderRadius: 8 }}>
                  <input type="checkbox" checked={!!form.tabs[tab]} onChange={() => toggleTab(tab)} />
                  <span style={{ color: form.tabs[tab] ? C.blueText : C.muted, fontWeight: form.tabs[tab] ? 700 : 500 }}>{tab}</span>
                </label>
              ))}
            </div>
            <div style={{ marginTop: 10, padding: "8px 12px", background: "#f8fafc", borderRadius: 8, border: `1px solid ${C.border}` }}>
              <span style={{ color: C.faint, fontSize: 12 }}>🔒 Financials and Access tabs are always admin-only and never shown to PIN users.</span>
            </div>
          </div>
          <button onClick={save} style={btnPrimary}>{editUser ? "Save Changes" : "Add User"}</button>
        </Modal>
      )}
    </div>
  );
}

// ─── APP ROOT ────────────────────────────────────────────────────────────────
const DEFAULT_FIN = {
  targetMargin: 35, qualityThreshold: 90, infrastructureCost: 0, otherOverhead: 0,
  bonusTiers: [{ name: "Bronze", minTasks: 100, minQuality: 90, bonusAmt: 50 }, { name: "Silver", minTasks: 150, minQuality: 93, bonusAmt: 150 }, { name: "Gold", minTasks: 200, minQuality: 96, bonusAmt: 350 }],
  regionRates: { US: 30, EU: 22, LATAM: 12, APAC: 10, Other: 15 },
};

export default function App() {
  const [loggedInUserId, setLoggedInUserId] = useState(null);
  const [activeTab, setActiveTab] = useState("Dashboard");
  const [experts, setExperts] = useLS("nes3_experts", []);
  const [reviewers, setReviewers] = useLS("nes3_reviewers", []);
  const [opsTeam, setOpsTeam] = useLS("nes3_ops", []);
  const [tickets, setTickets] = useLS("nes3_tickets", []);
  const [financials, setFinancials] = useLS("nes3_financials", DEFAULT_FIN);
  const [phaseFinancials, setPhaseFinancials] = useLS("nes3_phaseFinancials", {});
  const [taskTracker, setTaskTracker] = useLS("nes3_tasks", []);
  const [rampData, setRampData] = useLS("nes3_ramp", RAMP_SHEETS_DEFAULT);
  const [accessUsers, setAccessUsers] = useLS("nes3_access", []);

  const isAdmin = loggedInUserId === "__admin__";
  const currentUser = accessUsers.find(u => u.id === loggedInUserId);

  // Determine which tabs this user can see
  const visibleTabs = isAdmin
    ? ALL_TABS
    : currentUser
      ? CONTROLLABLE_TABS.filter(t => currentUser.tabs?.[t])
      : [];

  // If active tab is no longer visible, reset
  useEffect(() => {
    if (loggedInUserId && !visibleTabs.includes(activeTab)) {
      setActiveTab(visibleTabs[0] || "Dashboard");
    }
  }, [loggedInUserId, visibleTabs.join(",")]);

  const resetAll = () => {
    if (confirm("Reset ALL data? Cannot be undone.")) {
      setExperts([]); setReviewers([]); setOpsTeam([]); setTickets([]);
      setFinancials(DEFAULT_FIN); setPhaseFinancials({}); setTaskTracker([]);
      setRampData(RAMP_SHEETS_DEFAULT); setAccessUsers([]);
    }
  };

  if (!loggedInUserId) {
    return <PinLogin accessUsers={accessUsers} onLogin={setLoggedInUserId} />;
  }

  const props = { experts, reviewers, opsTeam, tickets, financials, phaseFinancials };

  const tabContent = {
    Dashboard: <DashboardTab {...props} />,
    Experts: <PersonTab items={experts} setItems={setExperts} type="expert" financials={financials} />,
    Reviewers: <PersonTab items={reviewers} setItems={setReviewers} type="reviewer" financials={financials} />,
    "Ops Team": <PersonTab items={opsTeam} setItems={setOpsTeam} type="ops" financials={financials} />,
    Tickets: <TicketsTab tickets={tickets} setTickets={setTickets} experts={experts} reviewers={reviewers} opsTeam={opsTeam} />,
    Tasks: <TasksTab taskTracker={taskTracker} setTaskTracker={setTaskTracker} />,
    "Ramp Plan": <RampPlanTab rampData={rampData} setRampData={setRampData} />,
    Financials: <FinancialsTab experts={experts} reviewers={reviewers} opsTeam={opsTeam} financials={financials} setFinancials={setFinancials} phaseFinancials={phaseFinancials} setPhaseFinancials={setPhaseFinancials} />,
    Visualizations: <VisualizationsTab experts={experts} reviewers={reviewers} tickets={tickets} financials={financials} />,
    Risk: <RiskTab experts={experts} reviewers={reviewers} tickets={tickets} financials={financials} opsTeam={opsTeam} />,
    Access: <AccessTab accessUsers={accessUsers} setAccessUsers={setAccessUsers} />,
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'IBM Plex Sans','Segoe UI',system-ui,sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      {/* Header */}
      <div style={{ background: C.navy, borderBottom: "1px solid #1e40af", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ padding: "0 28px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, maxWidth: 1600, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#4ade80", boxShadow: "0 0 8px #4ade80" }} />
            <span style={{ fontWeight: 800, fontSize: 15, color: "#f1f5f9" }}>GitHub NES Ops Center</span>
            {!isAdmin && currentUser && (
              <span style={{ background: "#ffffff20", color: "#94a3b8", borderRadius: 6, padding: "2px 10px", fontSize: 12 }}>
                {currentUser.name} · {currentUser.role}
              </span>
            )}
            {isAdmin && <span style={{ background: "#dc262620", color: "#fca5a5", borderRadius: 6, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>ADMIN</span>}
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ color: "#94a3b8", fontSize: 12, fontFamily: "'DM Mono',monospace" }}>
              {experts.filter(e => e.status === "active").length}E · {reviewers.filter(r => r.status === "active").length}R · {tickets.filter(t => t.status !== "COMPLETED").length} open
            </span>
            {isAdmin && <button onClick={resetAll} style={{ background: "transparent", border: "1px solid #334155", borderRadius: 7, color: "#94a3b8", padding: "4px 12px", cursor: "pointer", fontSize: 12 }}>Reset All</button>}
            <button onClick={() => setLoggedInUserId(null)} style={{ background: "transparent", border: "1px solid #334155", borderRadius: 7, color: "#94a3b8", padding: "4px 12px", cursor: "pointer", fontSize: 12 }}>Log Out</button>
          </div>
        </div>
        {/* Tabs — only show what this user can see */}
        <div style={{ padding: "0 28px", display: "flex", gap: 0, overflowX: "auto", maxWidth: 1600, margin: "0 auto" }}>
          {visibleTabs.map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              style={{ background: "none", border: "none", color: activeTab === tab ? "#60a5fa" : "#94a3b8", padding: "10px 16px", cursor: "pointer", fontSize: 13, fontWeight: activeTab === tab ? 700 : 500, borderBottom: activeTab === tab ? "2px solid #60a5fa" : "2px solid transparent", transition: "all 0.12s", whiteSpace: "nowrap" }}>
              {tab}
            </button>
          ))}
        </div>
      </div>
      {/* Content */}
      <div style={{ padding: "28px", maxWidth: 1600, margin: "0 auto" }}>
        {tabContent[activeTab] || <div style={{ color: C.muted, textAlign: "center", padding: 60 }}>You don't have access to this tab.</div>}
      </div>
    </div>
  );
}
