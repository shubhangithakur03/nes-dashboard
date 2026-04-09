import { useState, useEffect, useRef } from "react";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, RadarChart, Radar, PolarGrid, PolarAngleAxis, ScatterChart, Scatter
} from "recharts";
import * as XLSX from "xlsx";
import PptxGenJS from "pptxgenjs";
import { createClient } from "@supabase/supabase-js";

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
const SUPA_URL = "https://qhhcdoovufokxbkaytgc.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFoaGNkb292dWZva3hia2F5dGdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyNjU4NTcsImV4cCI6MjA5MDg0MTg1N30.czV5KxG6LiRfJBdFiWSxmTGDPnlW8brMmD4Wu4wI-HE";
const sb = createClient(SUPA_URL, SUPA_KEY);

const SB_ENVELOPE_KEY = "__nes_envelope_v1";
const singletonWriteQueues = new Map();
const rowWriteQueues = new Map();

const isObject = v => !!v && typeof v === "object";
const isEnvelope = v => isObject(v) && !Array.isArray(v) && v[SB_ENVELOPE_KEY] === true && Object.prototype.hasOwnProperty.call(v, "payload");
const wrapStoredValue = (payload, rev = 0) => ({ [SB_ENVELOPE_KEY]: true, rev, updatedAt: new Date().toISOString(), payload });
const unwrapStoredValue = (value, fallback) => (isEnvelope(value) ? (value.payload ?? fallback) : (value ?? fallback));
const readStoredRev = value => (isEnvelope(value) ? (Number(value.rev) || 0) : 0);

const newIdToken = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
};
const makeId = prefix => `${prefix}-${newIdToken()}`;
const reserveUniqueId = (usedIds, prefix) => {
  let candidate = makeId(prefix);
  let guard = 0;
  while (usedIds.has(candidate) && guard < 30) {
    candidate = makeId(prefix);
    guard += 1;
  }
  usedIds.add(candidate);
  return candidate;
};
const uniqueIdForItems = (items, prefix) => {
  const used = new Set((Array.isArray(items) ? items : []).map(item => (item?.id == null ? "" : String(item.id))).filter(Boolean));
  return reserveUniqueId(used, prefix);
};
const normalizeIdCollection = (items, prefix) => {
  const list = Array.isArray(items) ? items : [];
  const used = new Set();
  let changed = false;
  const normalized = [];

  list.forEach(item => {
    if (!isObject(item) || Array.isArray(item)) {
      changed = true;
      return;
    }

    const currentId = item.id == null ? "" : String(item.id);
    if (!currentId || used.has(currentId)) {
      const nextId = reserveUniqueId(used, prefix);
      normalized.push({ ...item, id: nextId });
      changed = true;
      return;
    }

    used.add(currentId);
    normalized.push(item);
  });

  return { items: normalized, changed };
};
const sameJSON = (a, b) => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

// Each "collection" is stored as a single row in its table with id='singleton'
// For arrays (experts, reviewers etc) we store the whole array as a jsonb value
// This keeps the schema dead-simple and avoids per-row complexity
async function sbGetRawSingleton(table) {
  try {
    const { data, error } = await sb.from(table).select("data").eq("id","singleton").maybeSingle();
    if (error || !data) return { exists: false, raw: null };
    return { exists: true, raw: data.data };
  } catch {
    return { exists: false, raw: null };
  }
}
async function sbGet(table, fallback) {
  const { exists, raw } = await sbGetRawSingleton(table);
  if (!exists) return fallback;
  return unwrapStoredValue(raw, fallback);
}
async function sbGetWithVersion(table, fallback) {
  const { exists, raw } = await sbGetRawSingleton(table);
  if (!exists) return { value: fallback, rev: 0 };
  return { value: unwrapStoredValue(raw, fallback), rev: readStoredRev(raw) };
}
async function sbSet(table, value, rev) {
  try {
    const payload = Number.isFinite(rev) ? wrapStoredValue(value, rev) : value;
    await sb.from(table).upsert({ id:"singleton", data: payload }, { onConflict:"id" });
    return true;
  } catch(e) {
    console.error("Supabase write error:", table, e);
    return false;
  }
}

const backupKey = table => `nes_backup_${table}`;
const readBackup = (table, fallback) => {
  try {
    if (typeof window === "undefined") return fallback;
    const raw = window.localStorage.getItem(backupKey(table));
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};
const writeBackup = (table, value) => {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(backupKey(table), JSON.stringify(value));
  } catch {
    // Ignore local backup write failures (quota/private mode).
  }
};

function queueSingletonWrite(table, valOrFn, fallbackValue) {
  const chained = (singletonWriteQueues.get(table) || Promise.resolve())
    .catch(() => null)
    .then(async () => {
      const latest = await sbGetWithVersion(table, fallbackValue);
      const next = typeof valOrFn === "function" ? valOrFn(latest.value) : valOrFn;
      const ok = await sbSet(table, next, latest.rev + 1);
      if (!ok) return null;
      writeBackup(table, next);
      return next;
    })
    .catch(e => {
      console.error("Supabase singleton sync error:", table, e);
      return null;
    });

  singletonWriteQueues.set(table, chained);
  return chained;
}

const toRowMap = rows => {
  const map = new Map();
  (Array.isArray(rows) ? rows : []).forEach(item => {
    if (!isObject(item) || Array.isArray(item) || item.id == null) return;
    map.set(String(item.id), item);
  });
  return map;
};

const chunkArray = (items, size = 200) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

async function sbFetchRowsByIds(table, ids) {
  const uniqueIds = Array.from(new Set((Array.isArray(ids) ? ids : []).filter(Boolean)));
  const map = new Map();
  if (uniqueIds.length === 0) return map;

  const chunks = chunkArray(uniqueIds, 200);
  for (let i = 0; i < chunks.length; i += 1) {
    const { data, error } = await sb.from(table).select("id,data").in("id", chunks[i]);
    if (error) throw error;
    (Array.isArray(data) ? data : []).forEach(row => {
      const item = unwrapStoredValue(row.data, null);
      if (!isObject(item) || Array.isArray(item)) return;
      map.set(String(row.id), item);
    });
  }

  return map;
}

const isClosedTimeLog = item => isObject(item) && !Array.isArray(item) && !!item.endTime;

async function sbSyncRows(table, prevRows, nextRows, options = {}) {
  try {
    const prevMap = toRowMap(prevRows);
    const nextMap = toRowMap(nextRows);

    const upsertCandidates = [];
    nextMap.forEach((item, id) => {
      const prevItem = prevMap.get(id);
      if (!prevItem || !sameJSON(prevItem, item)) {
        upsertCandidates.push({ id, prevItem: prevItem || null, nextItem: item });
      }
    });

    const deletionCandidates = [];
    prevMap.forEach((item, id) => {
      if (!nextMap.has(id)) deletionCandidates.push({ id, prevItem: item });
    });

    const affectedIds = Array.from(new Set([
      ...upsertCandidates.map(c => c.id),
      ...deletionCandidates.map(c => c.id),
    ]));

    const serverMap = await sbFetchRowsByIds(table, affectedIds);
    const upserts = [];
    const deletions = [];
    let skippedConflicts = 0;

    upsertCandidates.forEach(({ id, prevItem, nextItem }) => {
      const serverItem = serverMap.get(id);

      // New row creation should not overwrite an existing, divergent row.
      if (!prevItem) {
        if (!serverItem) {
          upserts.push({ id, data: nextItem });
          return;
        }
        if (!sameJSON(serverItem, nextItem)) skippedConflicts += 1;
        return;
      }

      // If the row disappeared remotely, treat as conflict and skip stale resurrection.
      if (!serverItem) {
        skippedConflicts += 1;
        return;
      }

      // Idempotent update already applied remotely.
      if (sameJSON(serverItem, nextItem)) return;

      // Protect against stale tabs reopening an already closed timer session.
      if (table === "time_logs" && isClosedTimeLog(serverItem) && !isClosedTimeLog(nextItem)) {
        skippedConflicts += 1;
        return;
      }

      // Allow stop transitions (open -> closed) even if lock heartbeat changed on server.
      if (table === "time_logs" && !isClosedTimeLog(prevItem) && isClosedTimeLog(nextItem) && !isClosedTimeLog(serverItem)) {
        upserts.push({ id, data: nextItem });
        return;
      }

      // Standard optimistic check: only write if server still matches caller's base snapshot.
      if (sameJSON(serverItem, prevItem)) {
        upserts.push({ id, data: nextItem });
        return;
      }

      skippedConflicts += 1;
    });

    deletionCandidates.forEach(({ id, prevItem }) => {
      const serverItem = serverMap.get(id);
      if (!serverItem) return;
      if (sameJSON(serverItem, prevItem)) {
        deletions.push(id);
        return;
      }
      skippedConflicts += 1;
    });

    if (upserts.length > 0) {
      const { error } = await sb.from(table).upsert(upserts, { onConflict: "id" });
      if (error) throw error;
    }
    if (deletions.length > 0) {
      const { error } = await sb.from(table).delete().in("id", deletions);
      if (error) throw error;
    }
    if (options.cleanupSingleton) {
      const { error } = await sb.from(table).delete().eq("id", "singleton");
      if (error) console.error("Supabase singleton cleanup error:", table, error);
    }

    if (skippedConflicts > 0) {
      console.warn("Supabase row sync conflict skipped:", table, skippedConflicts);
    }

    return true;
  } catch (e) {
    console.error("Supabase row sync error:", table, e);
    return false;
  }
}

function queueRowWrite(table, prevRows, nextRows, options = {}) {
  const chained = (rowWriteQueues.get(table) || Promise.resolve())
    .catch(() => null)
    .then(() => sbSyncRows(table, prevRows, nextRows, options))
    .catch(e => {
      console.error("Supabase row queue error:", table, e);
      return false;
    });

  rowWriteQueues.set(table, chained);
  return chained;
}

// Drop-in replacement for useLS — loads from Supabase, syncs on change
function useSupabase(table, init) {
  const [s, setS] = useState(init);
  const [loaded, setLoaded] = useState(false);
  const writeSeq = useRef(0);

  useEffect(() => {
    let alive = true;
    sbGet(table, init).then(v => {
      if (!alive) return;
      const fromFallback = v === init;
      const next = fromFallback ? readBackup(table, init) : v;
      setS(next);
      writeBackup(table, next);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [table, init]);

  const setAndSync = (valOrFn) => {
    const seq = ++writeSeq.current;
    setS(prev => {
      const next = typeof valOrFn === "function" ? valOrFn(prev) : valOrFn;
      writeBackup(table, next);

      queueSingletonWrite(table, valOrFn, next).then(committed => {
        if (committed == null || seq !== writeSeq.current) return;
        setS(curr => (sameJSON(curr, committed) ? curr : committed));
      });

      return next;
    });
  };

  return [s, setAndSync, loaded];
}

function useSupabaseRows(table, init, idPrefix) {
  const [s, setS] = useState(init);
  const [loaded, setLoaded] = useState(false);
  const modeRef = useRef("rows");
  const writeSeq = useRef(0);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const { data, error } = await sb.from(table).select("id,data");
        if (error) throw error;

        const rows = Array.isArray(data) ? data : [];
        const singletonRow = rows.find(r => r.id === "singleton");
        const rowItems = rows
          .filter(r => r.id !== "singleton")
          .map(r => unwrapStoredValue(r.data, null))
          .filter(item => isObject(item) && !Array.isArray(item));

        const singletonRaw = singletonRow ? unwrapStoredValue(singletonRow.data, init) : [];
        const singletonItems = Array.isArray(singletonRaw)
          ? singletonRaw.filter(item => isObject(item) && !Array.isArray(item))
          : [];

        const merged = [...rowItems];
        const seen = new Set(rowItems.map(item => String(item.id ?? "")).filter(Boolean));
        singletonItems.forEach(item => {
          const key = item.id == null ? "" : String(item.id);
          if (key && seen.has(key)) return;
          merged.push(item);
          if (key) seen.add(key);
        });

        const base = merged.length > 0 ? merged : readBackup(table, init);
        const normalized = normalizeIdCollection(base, idPrefix);
        const next = normalized.items;

        modeRef.current = "rows";
        if ((singletonRow && singletonItems.length > 0) || normalized.changed) {
          queueRowWrite(table, rowItems, next, { cleanupSingleton: true }).then(ok => {
            if (!ok) modeRef.current = "singleton";
          });
        }

        if (!alive) return;
        setS(next);
        writeBackup(table, next);
        setLoaded(true);
      } catch {
        modeRef.current = "singleton";
        const fallback = await sbGet(table, init);
        const normalized = normalizeIdCollection(fallback, idPrefix);
        if (!alive) return;
        setS(normalized.items);
        writeBackup(table, normalized.items);
        setLoaded(true);
        if (normalized.changed) queueSingletonWrite(table, normalized.items, normalized.items);
      }
    })();

    return () => { alive = false; };
  }, [table, idPrefix, init]);

  const setAndSync = (valOrFn) => {
    const seq = ++writeSeq.current;
    setS(prev => {
      const calculated = typeof valOrFn === "function" ? valOrFn(prev) : valOrFn;
      const normalized = normalizeIdCollection(calculated, idPrefix);
      const next = normalized.items;
      writeBackup(table, next);

      if (modeRef.current === "rows") {
        queueRowWrite(table, prev, next, { cleanupSingleton: true }).then(ok => {
          if (ok) return;
          modeRef.current = "singleton";
          queueSingletonWrite(table, next, next).then(committed => {
            if (committed == null || seq !== writeSeq.current) return;
            const fixed = normalizeIdCollection(committed, idPrefix).items;
            setS(curr => (sameJSON(curr, fixed) ? curr : fixed));
            writeBackup(table, fixed);
          });
        });
      } else {
        queueSingletonWrite(table, next, next).then(committed => {
          if (committed == null || seq !== writeSeq.current) return;
          const fixed = normalizeIdCollection(committed, idPrefix).items;
          setS(curr => (sameJSON(curr, fixed) ? curr : fixed));
          writeBackup(table, fixed);
        });
      }

      return next;
    });
  };

  return [s, setAndSync, loaded];
}

// ─── THEME ───────────────────────────────────────────────────────────────────
const C = {
  bg:"#f0f4f8", surface:"#ffffff", border:"#e2e8f0",
  text:"#0f172a", muted:"#64748b", faint:"#94a3b8",
  blue:"#2563eb", blueSoft:"#dbeafe", blueText:"#1d4ed8",
  green:"#16a34a", greenSoft:"#dcfce7", greenText:"#15803d",
  yellow:"#d97706", yellowSoft:"#fef9c3", yellowText:"#92400e",
  red:"#dc2626", redSoft:"#fee2e2", redText:"#991b1b",
  purple:"#7c3aed", purpleSoft:"#ede9fe",
  cyan:"#0891b2", cyanSoft:"#cffafe",
  orange:"#ea580c", orangeSoft:"#ffedd5",
  teal:"#0d9488", tealSoft:"#ccfbf1",
  navy:"#1e3a5f",
};

const STATUS_COLORS = {
  "NOT STARTED":C.faint,"IN PROGRESS":C.blue,
  "PENDING REVIEW":C.yellow,"COMPLETED":C.green,"REJECTED/REWORK":C.red,
};
const PRIORITY_COLORS = { High:C.red, Medium:C.yellow, Low:C.green };
const TICKET_STATUSES = ["NOT STARTED","IN PROGRESS","PENDING REVIEW","COMPLETED","REJECTED/REWORK"];

// Expert/Reviewer statuses — ordered for display
const PERSON_STATUSES = ["active","to-be-offboarded","inactive","offboarded"];
const STATUS_SORT = { active:0, "to-be-offboarded":1, inactive:2, offboarded:3 };
const STATUS_COLOR_MAP = { active:C.green, "to-be-offboarded":C.yellow, inactive:C.faint, offboarded:C.red };

const ALL_TABS = ["Dashboard","Standup","Experts","Reviewers","Ops Team","Tickets","Tasks","Velocity","Quality Control","Time Tracker","Ramp Plan","Financials","Visualizations","Risk","Access"];
const CONTROLLABLE_TABS = ["Dashboard","Standup","Experts","Reviewers","Ops Team","Tickets","Tasks","Velocity","Quality Control","Time Tracker","Ramp Plan","Visualizations","Risk"];

const PHASES = [
  { id:"p0_unified",    name:"P0 – Unified (Full)",   tasks:4000, revenue:250000, weeks:8, color:C.blue   },
  { id:"p0_nes",        name:"P0 – Personalized NES", tasks:4000, revenue:270000, weeks:8, color:C.purple },
  { id:"p1",            name:"P1 – Unified comp+NES", tasks:2000, revenue:125000, weeks:5, color:C.cyan   },
  { id:"p2_completions",name:"P2 – Completions",      tasks:2000, revenue:125000, weeks:5, color:C.orange },
  { id:"p2_nes",        name:"P2 – NES Standalone",   tasks:2000, revenue:125000, weeks:5, color:C.green  },
];

const RAMP_DEFAULT = [
  { id:"p0_unified",    name:"P0 – Unified (Full)",   totalTasks:4000, attemptAHT:3.5, reviewAHT:1.5, sbqDefault:0.25, cbHoursPerWeek:10, newHiresPerWeek:10, promotionRate:0.2, firstWeekCapacity:0.5, weeks:["W1","W2","W3","W4","W5","W6","W7","W8"], taskTargets:[0,200,400,600,700,700,800,600], weeklyProduction:{tasksPerCB:0,totalHours:0,totalProduced:0,attemptsPerCB:0,reviewsPerCB:0,sbqAffected:0,effectiveProd:0,totalWithSBQ:0,effortHours:0} },
  { id:"p0_nes",        name:"P0 – Personalized NES", totalTasks:4000, attemptAHT:5.0, reviewAHT:1.5, sbqDefault:0.3,  cbHoursPerWeek:10, newHiresPerWeek:10, promotionRate:0.2, firstWeekCapacity:0.5, weeks:["W1","W2","W3","W4","W5","W6","W7","W8"], taskTargets:[0,200,400,600,700,700,800,600], weeklyProduction:{tasksPerCB:0,totalHours:0,totalProduced:0,attemptsPerCB:0,reviewsPerCB:0,sbqAffected:0,effectiveProd:0,totalWithSBQ:0,effortHours:0} },
  { id:"p1",            name:"P1 – Unified comp+NES", totalTasks:2000, attemptAHT:4.0, reviewAHT:1.5, sbqDefault:0.25, cbHoursPerWeek:10, newHiresPerWeek:8,  promotionRate:0.2, firstWeekCapacity:0.5, weeks:["W1","W2","W3","W4","W5"],             taskTargets:[0,300,500,700,500],       weeklyProduction:{tasksPerCB:0,totalHours:0,totalProduced:0,attemptsPerCB:0,reviewsPerCB:0,sbqAffected:0,effectiveProd:0,totalWithSBQ:0,effortHours:0} },
  { id:"p2_completions",name:"P2 – Completions",      totalTasks:2000, attemptAHT:3.0, reviewAHT:1.0, sbqDefault:0.25, cbHoursPerWeek:10, newHiresPerWeek:8,  promotionRate:0.2, firstWeekCapacity:0.5, weeks:["W1","W2","W3","W4","W5"],             taskTargets:[0,300,500,700,500],       weeklyProduction:{tasksPerCB:0,totalHours:0,totalProduced:0,attemptsPerCB:0,reviewsPerCB:0,sbqAffected:0,effectiveProd:0,totalWithSBQ:0,effortHours:0} },
  { id:"p2_nes",        name:"P2 – NES Standalone",   totalTasks:2000, attemptAHT:5.0, reviewAHT:1.5, sbqDefault:0.3,  cbHoursPerWeek:10, newHiresPerWeek:8,  promotionRate:0.2, firstWeekCapacity:0.5, weeks:["W1","W2","W3","W4","W5"],             taskTargets:[0,250,500,750,500],       weeklyProduction:{tasksPerCB:0,totalHours:0,totalProduced:0,attemptsPerCB:0,reviewsPerCB:0,sbqAffected:0,effectiveProd:0,totalWithSBQ:0,effortHours:0} },
];

const DEFAULT_FIN = {
  targetMargin:35, qualityThreshold:90, infrastructureCost:0, otherOverhead:0,
  bonusTiers:[{name:"Bronze",minTasks:100,minQuality:90,bonusAmt:50},{name:"Silver",minTasks:150,minQuality:93,bonusAmt:150},{name:"Gold",minTasks:200,minQuality:96,bonusAmt:350}],
  regionRates:{US:30,EU:22,LATAM:12,APAC:10,Other:15},
};

const TZ_OPTIONS = [
  { label:"BST · GMT+1",    iana:"Europe/London",       abbr:"BST" },
  { label:"IST · GMT+5:30", iana:"Asia/Kolkata",        abbr:"IST" },
  { label:"EST · GMT-5",    iana:"America/New_York",    abbr:"EST" },
  { label:"UTC · GMT+0",    iana:"UTC",                 abbr:"UTC" },
  { label:"PST · GMT-8",    iana:"America/Los_Angeles", abbr:"PST" },
  { label:"CET · GMT+2",    iana:"Europe/Berlin",       abbr:"CET" },
];
const DEFAULT_TIME_TRACKER_TZ = "America/New_York";
const isKnownTz = iana => TZ_OPTIONS.some(t => t.iana === iana);
const timeTrackerTzKey = (userId, isAdmin) => `nes_tt_view_tz_${isAdmin ? "__admin__" : (userId || "unknown")}`;
const readTimeTrackerTzPref = (userId, isAdmin) => {
  try {
    if (typeof window === "undefined") return DEFAULT_TIME_TRACKER_TZ;
    const saved = window.localStorage.getItem(timeTrackerTzKey(userId, isAdmin));
    return isKnownTz(saved) ? saved : DEFAULT_TIME_TRACKER_TZ;
  } catch {
    return DEFAULT_TIME_TRACKER_TZ;
  }
};
const writeTimeTrackerTzPref = (userId, isAdmin, iana) => {
  try {
    if (typeof window === "undefined" || !isKnownTz(iana)) return;
    window.localStorage.setItem(timeTrackerTzKey(userId, isAdmin), iana);
  } catch {
    // Ignore preference write failures (quota/private mode).
  }
};
const QM_COLORS = [C.blue,C.purple,C.green,C.red,C.orange,C.cyan,C.teal,C.yellow,C.navy,"#ec4899"];

const wallClockToUTC = (dateStr, timeStr, iana) => {
  try {
    if (!dateStr || !timeStr || !iana) return "";
    const [y, m, d] = String(dateStr).split("-").map(Number);
    const [hh, mm] = String(timeStr).split(":").map(Number);
    if (![y, m, d, hh, mm].every(Number.isFinite)) return "";

    const naiveUtcMs = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
    const naiveDate = new Date(naiveUtcMs);
    const tzLocalString = naiveDate.toLocaleString("en-US", { timeZone: iana, hour12: false });
    const tzAsLocalDate = new Date(tzLocalString);
    if (Number.isNaN(tzAsLocalDate.getTime())) return "";

    const offsetMs = tzAsLocalDate.getTime() - naiveUtcMs;
    const correctedUtc = new Date(naiveUtcMs - offsetMs);
    if (Number.isNaN(correctedUtc.getTime())) return "";
    return correctedUtc.toISOString();
  } catch {
    return "";
  }
};

// ─── UTILS ───────────────────────────────────────────────────────────────────
const fmt  = (n,d=0)=>(+(n??0)).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtU = (n,d=2)=>`$${fmt(n,d)}`;
const fmtP = (n,d=1)=>`${fmt(n,d)}%`;
const today = ()=>new Date().toISOString().split("T")[0];
const daysSince = d=>d?Math.floor((Date.now()-new Date(d).getTime())/86400000):null;
const EMPTY_LIST = [];
const EMPTY_OBJECT = {};
// ─── TIME-TRACKER HELPERS ────────────────────────────────────────────────────
const fmtTZ=(iso,iana)=>{try{return new Intl.DateTimeFormat("en-GB",{timeZone:iana,weekday:"short",day:"2-digit",month:"short"}).format(new Date(iso));}catch{return"—";}};
const fmtTimeTZ=(iso,iana)=>{try{return new Intl.DateTimeFormat("en-GB",{timeZone:iana,hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(iso));}catch{return"—";}};
const isoDateInTZ=(iso,iana)=>{try{return new Intl.DateTimeFormat("en-CA",{timeZone:iana}).format(new Date(iso));}catch{return"";}};
const hasDayShift=(iso,tzA,tzB)=>tzA&&tzB&&tzA!==tzB?isoDateInTZ(iso,tzA)!==isoDateInTZ(iso,tzB):false;
const fmtElapsed=s=>{const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;return[h,m,sec].map(n=>String(n).padStart(2,"0")).join(":");};
const durStr=(s,e)=>{const ms=new Date(e)-new Date(s);if(ms<=0)return"—";const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000);return h>0?`${h}h ${m}m`:`${m}m`;};
const weekBounds=(baseDate=new Date())=>{
  const ws=new Date(baseDate);
  const dow=ws.getDay();
  ws.setDate(ws.getDate()-(dow===0?6:dow-1));
  ws.setHours(0,0,0,0);
  const we=new Date(ws);we.setDate(ws.getDate()+7);
  return { weekStart:ws, weekEnd:we };
};
const opsMetricsById=(opsTeam,timeLogs,baseDate=new Date())=>{
  const { weekStart, weekEnd }=weekBounds(baseDate);
  const byId={};
  opsTeam.forEach(o=>{byId[o.id]={approvedWeekHours:0,pendingWeekHours:0,approvedWeekPay:0,pendingWeekPay:0,totalApprovedPay:0,totalPendingPay:0};});
  const statusOf=l=>l.approvalStatus||"approved";
  timeLogs.forEach(l=>{
    if(!l.endTime||!byId[l.qmId]) return;
    const ms=new Date(l.endTime)-new Date(l.startTime);
    if(ms<=0) return;
    const hrs=ms/3600000;
    const inWeek=new Date(l.startTime)>=weekStart&&new Date(l.startTime)<weekEnd;
    const rate=l.hourlyRateSnapshot??(opsTeam.find(o=>o.id===l.qmId)?.hourlyRate||0);
    const pay=hrs*rate;
    const st=statusOf(l);
    if(st==="approved"){
      byId[l.qmId].totalApprovedPay+=pay;
      if(inWeek){byId[l.qmId].approvedWeekHours+=hrs;byId[l.qmId].approvedWeekPay+=pay;}
    }else if(st==="pending"){
      byId[l.qmId].totalPendingPay+=pay;
      if(inWeek){byId[l.qmId].pendingWeekHours+=hrs;byId[l.qmId].pendingWeekPay+=pay;}
    }
  });
  return byId;
};

// ─── EXPORT ──────────────────────────────────────────────────────────────────
function dlXLSX(sheets, fname="NES_Export") {
  const wb=XLSX.utils.book_new();
  sheets.forEach(({name,data})=>{
    const ws=XLSX.utils.json_to_sheet(data.length?data:[{"(no data)":""}]);
    if(data.length){ const cols=Object.keys(data[0]).map(k=>({wch:Math.max(k.length,...data.map(r=>String(r[k]??"").length))+2})); ws["!cols"]=cols; }
    XLSX.utils.book_append_sheet(wb,ws,name.slice(0,31));
  });
  XLSX.writeFile(wb,`${fname}_${today()}.xlsx`);
}

// ─── UI PRIMITIVES ───────────────────────────────────────────────────────────
const iStyle = {width:"100%",background:"#f8fafc",border:`1px solid ${C.border}`,borderRadius:8,color:C.text,padding:"9px 14px",fontSize:14,boxSizing:"border-box",outline:"none",fontFamily:"inherit"};
const selStyle = {...iStyle,cursor:"pointer"};
const btnPri = {background:C.blue,color:"#fff",border:"none",borderRadius:9,padding:"11px 22px",cursor:"pointer",fontWeight:700,fontSize:14,width:"100%"};
const btnSm  = {background:"#f1f5f9",color:C.text,border:`1px solid ${C.border}`,borderRadius:7,padding:"6px 14px",cursor:"pointer",fontWeight:600,fontSize:13};

function Bdg({children,color=C.blue}){
  return <span style={{background:color+"18",color,border:`1px solid ${color}40`,borderRadius:6,padding:"2px 9px",fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>{children}</span>;
}
function KPI({label,value,sub,color=C.text,icon,delta}){
  return(
    <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:"18px 22px",display:"flex",flexDirection:"column",gap:6,boxShadow:"0 1px 3px #0001"}}>
      <div style={{display:"flex",justifyContent:"space-between"}}>
        <span style={{color:C.muted,fontSize:11,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase"}}>{label}</span>
        {icon&&<span style={{fontSize:17}}>{icon}</span>}
      </div>
      <div style={{color,fontSize:28,fontWeight:800,fontFamily:"'DM Mono',monospace",lineHeight:1}}>{value}</div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        {sub&&<span style={{color:C.muted,fontSize:12}}>{sub}</span>}
        {delta!=null&&<span style={{color:delta>=0?C.green:C.red,fontSize:12,fontWeight:700}}>{delta>=0?"▲":"▼"} {Math.abs(delta).toFixed(1)}%</span>}
      </div>
    </div>
  );
}
function TH({cols}){
  return <thead><tr style={{background:"#f8fafc"}}>{cols.map(c=><th key={c} style={{textAlign:"left",color:C.muted,fontSize:11,fontWeight:700,padding:"10px 14px",borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap",letterSpacing:"0.05em",verticalAlign:"middle"}}>{c}</th>)}</tr></thead>;
}
function InN({value,onChange,prefix="",suffix="",width="80px"}){
  return <span style={{display:"inline-flex",alignItems:"center",gap:3}}>
    {prefix&&<span style={{color:C.muted,fontSize:12}}>{prefix}</span>}
    <input type="number" value={value} onChange={e=>onChange(parseFloat(e.target.value)||0)} style={{background:"#f1f5f9",border:`1px solid ${C.border}`,borderRadius:6,color:C.text,padding:"3px 8px",fontSize:13,fontFamily:"'DM Mono',monospace",width,outline:"none"}}/>
    {suffix&&<span style={{color:C.muted,fontSize:12}}>{suffix}</span>}
  </span>;
}
function Modal({title,onClose,children,width=520}){
  return <div style={{position:"fixed",inset:0,background:"#0007",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:"12px"}} onClick={e=>e.target===e.currentTarget&&onClose()}>
    <div className="modal-inner" style={{background:C.surface,borderRadius:16,padding:28,width,maxWidth:"96vw",maxHeight:"90vh",overflowY:"auto",boxShadow:"0 20px 60px #0003"}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:20}}>
        <span style={{fontWeight:800,fontSize:17}}>{title}</span>
        <button onClick={onClose} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:22,lineHeight:1}}>×</button>
      </div>
      {children}
    </div>
  </div>;
}
function FF({label,children}){
  return <div style={{marginBottom:14}}>
    <label style={{color:C.muted,fontSize:11,fontWeight:700,display:"block",marginBottom:5,textTransform:"uppercase",letterSpacing:"0.05em"}}>{label}</label>
    {children}
  </div>;
}
function Card({title,children,extra,color}){
  return <div style={{background:C.surface,border:`1px solid ${color||C.border}`,borderRadius:12,padding:22}}>
    {(title||extra)&&<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
      <span style={{fontWeight:800,fontSize:15}}>{title}</span>{extra}
    </div>}
    {children}
  </div>;
}
function ExBtn({onClick,label,color}){
  return <button onClick={onClick} style={{background:color||C.green,color:"#fff",border:"none",borderRadius:8,padding:"7px 16px",cursor:"pointer",fontWeight:700,fontSize:13}}>{label}</button>;
}
function Spark({data,color=C.blue,threshold}){
  if(!data||data.length<2) return <span style={{color:C.faint,fontSize:11}}>—</span>;
  const w=80,h=28,pad=3;
  const mn=Math.min(...data)-2, mx=Math.max(...data)+2;
  const x=(i)=>pad+(i/(data.length-1))*(w-2*pad);
  const y=(v)=>h-pad-((v-mn)/(mx-mn||1))*(h-2*pad);
  const pts=data.map((v,i)=>`${x(i)},${y(v)}`).join(" ");
  const last=data[data.length-1], prev=data[data.length-2];
  return(
    <svg width={w} height={h} style={{display:"block"}}>
      {threshold&&<line x1={pad} x2={w-pad} y1={y(threshold)} y2={y(threshold)} stroke={C.red} strokeWidth={1} strokeDasharray="2,2" opacity={0.5}/>}
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.8}/>
      <circle cx={x(data.length-1)} cy={y(last)} r={3} fill={last>=prev?C.green:C.red}/>
    </svg>
  );
}

// ─── PIN LOGIN ───────────────────────────────────────────────────────────────
function PinLogin({accessUsers,onLogin}){
  const [pin,setPin]=useState(""); const [err,setErr]=useState("");
  const go=()=>{
    if(pin==="shubhi12s"){onLogin("__admin__");return;}
    const u=accessUsers.find(u=>u.pin===pin&&u.pin);
    if(u){onLogin(u.id);setErr("");}else{setErr("Incorrect PIN. Contact your administrator.");setPin("");}
  };
  return(
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
      <div style={{background:C.surface,borderRadius:20,padding:48,width:380,boxShadow:"0 8px 40px #0002",textAlign:"center"}}>
        <div style={{width:56,height:56,background:C.navy,borderRadius:14,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 20px",fontSize:28}}>🔒</div>
        <div style={{fontWeight:800,fontSize:22,marginBottom:6}}>GitHub NES Ops Center</div>
        <div style={{color:C.muted,fontSize:14,marginBottom:28}}>Enter your access PIN</div>
        <input type="password" value={pin} onChange={e=>setPin(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()} placeholder="PIN" style={{...iStyle,textAlign:"center",fontSize:20,letterSpacing:"0.3em",marginBottom:14}} autoFocus/>
        {err&&<div style={{color:C.red,fontSize:13,marginBottom:12}}>{err}</div>}
        <button onClick={go} style={btnPri}>Enter</button>
        <div style={{color:C.faint,fontSize:11,marginTop:20}}>Contact your ops administrator for access.</div>
      </div>
    </div>
  );
}

// ─── PERSON TAB ──────────────────────────────────────────────────────────────
function PersonTab({items,setItems,type,financials,timeLogs=[]}){
  const isE=type==="expert", isR=type==="reviewer";
  const [search,setSearch]=useState(""); const [filterStatus,setFilterStatus]=useState("all");
  const [modal,setModal]=useState(false); const [editId,setEditId]=useState(null);
  const color=isE?C.blue:isR?C.purple:C.orange;

  const blank=()=>({
    id:"",
    name:"",status:"active",region:"US",
    ...(isE||isR)?{
      tasksCompleted:0, lastWeekCompleted:0, qualityScore:0, avgSpeed:0,
      perTaskRate:0, bonusEarned:0, qualityHistory:[],
      ...(isE?{dateAdded:today()}:{datePromoted:today()}),
    }:{},
    ...(!isE&&!isR)?{role:"",responsibilities:"",activityPct:0,hourlyRate:0}:{},
  });
  const [form,setForm]=useState(blank());
  const upd=(f,v)=>setForm(p=>({...p,[f]:v}));

  // Sort: active → to-be-offboarded → inactive → offboarded
  const sorted=[...items].sort((a,b)=>(STATUS_SORT[a.status]??99)-(STATUS_SORT[b.status]??99));
  const filtered=sorted.filter(x=>
    (filterStatus==="all"||x.status===filterStatus)&&
    x.name.toLowerCase().includes(search.toLowerCase())
  );

  const openAdd=()=>{ setForm(blank()); setEditId(null); setModal(true); };
  const openEdit=x=>{
    const dateFields=isE
      ? { dateAdded:x.dateAdded||x.joinDate||"" }
      : isR
        ? { datePromoted:x.datePromoted||x.joinDate||"" }
        : {};
    setForm({...x,...dateFields,qualityHistory:x.qualityHistory||[]});
    setEditId(x.id);
    setModal(true);
  };
  const save=()=>{
    if(!form.name.trim()) return;
    let finalForm={...form};
    const existing=items.find(x=>x.id===editId);
    if(isE&&!finalForm.dateAdded){
      finalForm={...finalForm,dateAdded:existing?.dateAdded||existing?.joinDate||today()};
    }
    if(isR&&!finalForm.datePromoted){
      finalForm={...finalForm,datePromoted:existing?.datePromoted||existing?.joinDate||today()};
    }
    if(editId&&existing&&(isE||isR)&&existing.qualityScore!==form.qualityScore&&form.qualityScore>0){
      finalForm={...finalForm,qualityHistory:[...(existing.qualityHistory||[]),{date:today(),score:form.qualityScore}].slice(-12)};
    }
    if(!editId&&(isE||isR)&&form.qualityScore>0){
      finalForm={...finalForm,qualityHistory:[{date:today(),score:form.qualityScore}]};
    }
    if(editId) setItems(p=>p.map(x=>x.id===editId?finalForm:x));
    else setItems(p=>{
      const nextId = uniqueIdForItems(p, isE ? "E" : isR ? "R" : "O");
      return [...p, { ...finalForm, id: nextId }];
    });
    setModal(false);
  };
  const del=id=>{ if(confirm("Delete?")) setItems(p=>p.filter(x=>x.id!==id)); };

  const threshold=financials?.qualityThreshold||90;
  const withAHT=items.filter(x=>x.avgSpeed>0);
  const avgAHT=withAHT.length?withAHT.reduce((s,x)=>s+x.avgSpeed,0)/withAHT.length:0;
  const opsMetrics=!isE&&!isR?opsMetricsById(items,timeLogs,new Date()):{};
  const opsTotals=!isE&&!isR?items.reduce((acc,o)=>{
    const m=opsMetrics[o.id]||{};
    acc.approvedWeekHours+=(m.approvedWeekHours||0);
    acc.pendingWeekHours+=(m.pendingWeekHours||0);
    acc.approvedWeekPay+=(m.approvedWeekPay||0);
    acc.pendingWeekPay+=(m.pendingWeekPay||0);
    acc.totalApprovedPay+=(m.totalApprovedPay||0);
    return acc;
  },{approvedWeekHours:0,pendingWeekHours:0,approvedWeekPay:0,pendingWeekPay:0,totalApprovedPay:0}):null;

  // Weekly delta = current total - last week total
  const weeklyDelta=(x)=>{
    if(!isE&&!isR) return null;
    const curr=isE?x.tasksCompleted:x.tasksReviewed;
    const prev=x.lastWeekCompleted||0;
    return curr-prev;
  };

  const kpi=isE?[
    {label:"Active",value:items.filter(x=>x.status==="active").length,icon:"👥",color},
    {label:"Weekly Output",value:fmt(items.reduce((s,x)=>s+(weeklyDelta(x)||0),0)),icon:"📈",color:C.green,sub:"vs last week"},
    {label:"Total Completed",value:fmt(items.reduce((s,x)=>s+(x.tasksCompleted||0),0)),icon:"📊",color:C.muted},
    {label:"Avg Quality",value:items.filter(x=>x.qualityScore>0).length?fmtP(items.filter(x=>x.qualityScore>0).reduce((s,x)=>s+x.qualityScore,0)/items.filter(x=>x.qualityScore>0).length):"—",icon:"⭐",color:C.green},
  ]:isR?[
    {label:"Active",value:items.filter(x=>x.status==="active").length,icon:"🔍",color},
    {label:"Weekly Output",value:fmt(items.reduce((s,x)=>s+(weeklyDelta(x)||0),0)),icon:"📈",color:C.green,sub:"vs last week"},
    {label:"Total Reviewed",value:fmt(items.reduce((s,x)=>s+(x.tasksReviewed||0),0)),icon:"📊",color:C.muted},
    {label:"Avg Quality",value:items.filter(x=>x.qualityScore>0).length?fmtP(items.filter(x=>x.qualityScore>0).reduce((s,x)=>s+x.qualityScore,0)/items.filter(x=>x.qualityScore>0).length):"—",icon:"⭐",color:C.green},
  ]:[
    {label:"Team Size",value:items.length,icon:"👔",color},
    {label:"Approved Pay (All Time)",value:fmtU(opsTotals?.totalApprovedPay||0),icon:"💼",color:C.orange},
    {label:"Pending Pay (This Week)",value:fmtU(opsTotals?.pendingWeekPay||0),icon:"🧾",color:C.yellow},
    {label:"Avg Activity",value:items.length>0?fmtP(items.reduce((s,x)=>s+(x.activityPct||0),0)/items.length):"—",icon:"📊",color:C.blue},
    {label:"Avg Hourly Rate",value:items.filter(x=>x.hourlyRate>0).length?fmtU(items.filter(x=>x.hourlyRate>0).reduce((s,x)=>s+x.hourlyRate,0)/items.filter(x=>x.hourlyRate>0).length):"—",icon:"💵",color:C.purple},
  ];

  return(
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14,marginBottom:20}}>
        {kpi.map(k=><KPI key={k.label} {...k}/>)}
      </div>

      {/* Daily tracking info banner */}
      {(isE||isR)&&(
        <div style={{background:C.tealSoft,border:`1px solid ${C.teal}30`,borderRadius:10,padding:"12px 18px",marginBottom:14,display:"flex",gap:10,alignItems:"center"}}>
          <span style={{fontSize:18}}>💡</span>
          <div style={{color:C.teal,fontSize:13,lineHeight:1.6}}>
            <strong>Weekly update model:</strong> Instead of daily tracking, update each contributor's "Current Total" once a week. The dashboard automatically calculates the weekly delta (Current Total − Last Week Total). At the end of each week, click <strong>"Roll Week"</strong> to archive last week's totals and start fresh.
          </div>
        </div>
      )}

      <div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder={`Search ${type}s...`} style={{...iStyle,flex:1,minWidth:180,width:"auto"}}/>
        <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)} style={{...selStyle,width:180}}>
          <option value="all">All Statuses</option>
          {PERSON_STATUSES.map(s=><option key={s} value={s}>{s}</option>)}
        </select>
        {(isE||isR)&&(
          <button onClick={()=>{
            if(confirm("Roll week? This sets 'Last Week Total' to each contributor's current total.")){
              setItems(p=>p.map(x=>({...x,lastWeekCompleted:isE?x.tasksCompleted:x.tasksReviewed})));
            }
          }} style={{...btnSm,background:C.teal,color:"#fff",border:"none"}}>🔄 Roll Week</button>
        )}
        {(isE||isR)&&(
          <button onClick={()=>{
            const input=document.createElement("input");
            input.type="file";input.accept=".xlsx,.xls,.csv";
            input.onchange=async(e)=>{
              const file=e.target.files[0];if(!file)return;
              const reader=new FileReader();
              reader.onload=ev=>{
                try{
                  const wb=XLSX.read(ev.target.result,{type:"binary"});
                  const ws=wb.Sheets[wb.SheetNames[0]];
                  const rows=XLSX.utils.sheet_to_json(ws);
                  if(!rows.length){alert("No data found in file.");return;}
                  const imported=rows.map(r=>({
                    id:"",
                    name:r["Name"]||r["name"]||"",
                    status:(r["Status"]||r["status"]||"active").toLowerCase(),
                    region:r["Region"]||r["region"]||"US",
                    dateAdded:isE?(r["Date Added"]||r["dateAdded"]||r["Join Date"]||r["joinDate"]||""):"",
                    datePromoted:isR?(r["Date Promoted"]||r["datePromoted"]||r["Join Date"]||r["joinDate"]||""):"",
                    tasksCompleted:+(r["Current Total"]||r["tasksCompleted"]||0),
                    tasksReviewed:+(r["Current Total"]||r["tasksReviewed"]||0),
                    lastWeekCompleted:+(r["Last Week Total"]||r["lastWeekCompleted"]||0),
                    qualityScore:+(r["Quality %"]||r["qualityScore"]||0),
                    avgSpeed:+(r["Avg AHT (h)"]||r["avgSpeed"]||0),
                    perTaskRate:+(r["Per-Task $"]||r["perTaskRate"]||0),
                    bonusEarned:+(r["Bonus $"]||r["bonusEarned"]||0),
                    qualityHistory:[],
                  })).filter(x=>x.name.trim());
                  if(!imported.length){alert("No valid rows found. Make sure the file has a 'Name' column.");return;}
                  // Merge: update existing by name, add new ones
                  setItems(prev=>{
                    const updated=[...prev];
                    const existingNames=new Map(prev.map(x=>[x.name.toLowerCase(),x]));
                    const usedIds=new Set(prev.map(x=>String(x.id??"")).filter(Boolean));
                    const toAdd=[];
                    imported.forEach(imp=>{
                      const existing=existingNames.get(imp.name.toLowerCase());
                      if(existing){
                        const idx=updated.findIndex(x=>x.id===existing.id);
                        if(idx>=0) updated[idx]={...existing,...imp,id:existing.id,qualityHistory:existing.qualityHistory||[]};
                      } else {
                        const nextId=reserveUniqueId(usedIds,isE?"E":"R");
                        toAdd.push({...imp,id:nextId});
                      }
                    });
                    return [...updated,...toAdd];
                  });
                  alert(`✅ Imported ${imported.length} row(s). Existing entries updated by name match, new entries added.`);
                }catch(err){alert("Import failed: "+err.message);}
              };
              reader.readAsBinaryString(file);
            };
            input.click();
          }} style={{...btnSm,background:C.purple,color:"#fff",border:"none"}}>⬆ Import Excel</button>
        )}
        <ExBtn onClick={()=>{
          dlXLSX([{name:isE?"Experts":isR?"Reviewers":"Ops Team",data:items.map(x=>isE?({
            ID:x.id,Name:x.name,Status:x.status,Region:x.region,"Date Added":x.dateAdded||x.joinDate||"",
            "Current Total":x.tasksCompleted,"Last Week Total":x.lastWeekCompleted||0,"Weekly Delta":x.tasksCompleted-(x.lastWeekCompleted||0),
            "Quality %":x.qualityScore,"Avg AHT (h)":x.avgSpeed,"Per-Task $":x.perTaskRate,"Bonus $":x.bonusEarned,
          }):isR?({
            ID:x.id,Name:x.name,Status:x.status,Region:x.region,"Date Promoted":x.datePromoted||x.joinDate||"",
            "Current Total":x.tasksReviewed,"Last Week Total":x.lastWeekCompleted||0,"Weekly Delta":x.tasksReviewed-(x.lastWeekCompleted||0),
            "Quality %":x.qualityScore,"Avg AHT (h)":x.avgSpeed,"Per-Task $":x.perTaskRate,"Bonus $":x.bonusEarned,
          }):({
            ID:x.id,Name:x.name,Role:x.role,Status:x.status,Region:x.region,
            "Responsibilities":x.responsibilities||"",
            "Approved Hrs/Wk":+(opsMetrics[x.id]?.approvedWeekHours||0).toFixed(2),
            "Pending Hrs/Wk":+(opsMetrics[x.id]?.pendingWeekHours||0).toFixed(2),
            "Hourly Rate ($)":x.hourlyRate,
            "Approved Pay/Wk ($)":+(opsMetrics[x.id]?.approvedWeekPay||0).toFixed(2),
            "Pending Pay/Wk ($)":+(opsMetrics[x.id]?.pendingWeekPay||0).toFixed(2),
            "Total Approved Pay ($)":+(opsMetrics[x.id]?.totalApprovedPay||0).toFixed(2),
            "Activity %":x.activityPct,
          }))}],"NES_Export");
        }} label={`⬇ Export ${isE?"Experts":isR?"Reviewers":"Ops Team"}`}/>
        <button onClick={openAdd} style={{...btnSm,background:color,color:"#fff",border:"none"}}>+ Add {isE?"Expert":isR?"Reviewer":"Ops Member"}</button>
      </div>

      {(() => {
        const tableCols=isE
          ? ["#","Name","Status","Region","Date Added","This Week","Total","Quality","AHT","$/task"]
          : isR
            ? ["#","Name","Status","Region","Date Promoted","This Week","Total","Quality","AHT"]
            : ["#","Name","Role","Region","Responsibilities","Approved Hrs/Wk","Pending Hrs/Wk","Rate ($/h)","Approved Pay/Wk","Pending Pay/Wk","Total Approved Pay","Activity","Status","Actions"];

        return (
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",minWidth:860}}>
          <TH cols={tableCols}/>
          <tbody>
            {filtered.length===0&&<tr><td colSpan={tableCols.length} style={{padding:40,textAlign:"center",color:C.faint}}>No {type}s yet. Click "+ Add" to get started.</td></tr>}
            {filtered.map((x,i)=>{
              const delta=weeklyDelta(x);
              const ahtFlag=avgAHT>0&&x.avgSpeed>0?(x.avgSpeed>avgAHT*1.3?"slow":x.avgSpeed<avgAHT*0.6?"fast":null):null;
              const m=!isE&&!isR?(opsMetrics[x.id]||{}):null;
              return(
                <tr key={x.id} style={{borderTop:`1px solid ${C.border}`,background:i%2?"#fafafa":C.surface}}>
                  <td style={{padding:"10px 14px",color:C.faint,fontFamily:"'DM Mono',monospace",fontSize:12,width:40}}>{i+1}</td>
                  <td style={{padding:"10px 14px",fontWeight:700}}>{x.name}</td>
                  {(!isE&&!isR)&&<td style={{padding:"10px 14px",color:C.blue,fontSize:13}}>{x.role}</td>}
                  {(isE||isR)&&<td style={{padding:"10px 14px"}}><Bdg color={STATUS_COLOR_MAP[x.status]||C.faint}>{x.status}</Bdg></td>}
                  <td style={{padding:"10px 14px",color:C.muted,fontSize:13}}>{x.region||"—"}</td>
                  {isE&&<td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",color:C.muted,fontSize:12}}>{x.dateAdded||x.joinDate||"—"}</td>}
                  {isR&&<td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",color:C.muted,fontSize:12}}>{x.datePromoted||x.joinDate||"—"}</td>}
                  {(!isE&&!isR)&&<td style={{padding:"10px 14px",color:C.muted,fontSize:13,maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x.responsibilities||"—"}</td>}
                  {(isE||isR)&&<>
                    <td style={{padding:"10px 14px"}}>
                      <div style={{fontFamily:"'DM Mono',monospace",fontWeight:700,color:delta>0?C.green:delta<0?C.red:C.muted}}>
                        {delta!=null?(delta>0?"+":"")+fmt(delta):"—"}
                      </div>
                    </td>
                    <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace"}}>{isE?x.tasksCompleted:x.tasksReviewed}</td>
                    <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",fontWeight:700,color:x.qualityScore>=threshold?C.green:x.qualityScore>0?C.red:C.faint}}>{x.qualityScore>0?fmtP(x.qualityScore):"—"}</td>
                    <td style={{padding:"10px 14px"}}>
                      <span style={{fontFamily:"'DM Mono',monospace",fontSize:12,color:ahtFlag==="slow"?C.red:ahtFlag==="fast"?C.yellow:C.muted}}>{x.avgSpeed>0?`${x.avgSpeed}h`:"—"}</span>
                      {ahtFlag&&<span style={{marginLeft:4}}><Bdg color={ahtFlag==="slow"?C.red:C.yellow}>{ahtFlag}</Bdg></span>}
                    </td>
                    {isE&&<td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace"}}>{x.perTaskRate>0?fmtU(x.perTaskRate):"—"}</td>}
                  </>}
                  {(!isE&&!isR)&&<>
                    <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace"}}>{(m?.approvedWeekHours||0).toFixed(1)}h</td>
                    <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",color:C.yellowText}}>{(m?.pendingWeekHours||0).toFixed(1)}h</td>
                    <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace"}}>{x.hourlyRate>0?fmtU(x.hourlyRate):""}/h</td>
                    <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",color:C.blue,fontWeight:700}}>{fmtU(m?.approvedWeekPay||0)}</td>
                    <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",color:C.yellowText}}>{fmtU(m?.pendingWeekPay||0)}</td>
                    <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",color:C.orange}}>{fmtU(m?.totalApprovedPay||0)}</td>
                    <td style={{padding:"10px 14px"}}>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:13}}>{fmtP(x.activityPct||0)}</div>
                      <div style={{background:C.border,borderRadius:3,height:4,width:60,marginTop:3}}><div style={{background:(x.activityPct||0)>=80?C.green:C.yellow,height:4,borderRadius:3,width:`${Math.min(x.activityPct||0,100)}%`}}/></div>
                    </td>
                    <td style={{padding:"10px 14px"}}><Bdg color={STATUS_COLOR_MAP[x.status]||C.faint}>{x.status}</Bdg></td>
                  </>}
                  {(!isE&&!isR)&&<td style={{padding:"10px 14px"}}>
                    <div style={{display:"flex",gap:6}}>
                      <button onClick={()=>openEdit(x)} style={{...btnSm,padding:"3px 10px",fontSize:12}}>Edit</button>
                      <button onClick={()=>del(x.id)} style={{...btnSm,padding:"3px 10px",fontSize:12,color:C.red,borderColor:C.red+"50"}}>Del</button>
                    </div>
                  </td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
        );
      })()}

      {modal&&(
        <Modal title={`${editId?"Edit":"Add"} ${isE?"Expert":isR?"Reviewer":"Ops Member"}`} onClose={()=>setModal(false)}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
            <FF label="Name"><input type="text" value={form.name} onChange={e=>upd("name",e.target.value)} style={iStyle}/></FF>
            <FF label="Status">
              <select value={form.status} onChange={e=>upd("status",e.target.value)} style={selStyle}>
                {PERSON_STATUSES.map(s=><option key={s} value={s}>{s}</option>)}
              </select>
            </FF>
            <FF label="Region"><select value={form.region} onChange={e=>upd("region",e.target.value)} style={selStyle}><option>US</option><option>LATAM</option><option>EU</option><option>APAC</option><option>Other</option></select></FF>
            {(isE||isR)&&<>
              {isE&&<FF label="Date Added"><input type="date" value={form.dateAdded||""} onChange={e=>upd("dateAdded",e.target.value)} style={iStyle}/></FF>}
              {isR&&<FF label="Date Promoted"><input type="date" value={form.datePromoted||""} onChange={e=>upd("datePromoted",e.target.value)} style={iStyle}/></FF>}
              <FF label={isE?"Current Total Completed":"Current Total Reviewed"}>
                <input type="number" value={isE?form.tasksCompleted:form.tasksReviewed} onChange={e=>upd(isE?"tasksCompleted":"tasksReviewed",+e.target.value||0)} style={iStyle}/>
              </FF>
              <FF label="Last Week Total (for delta calc)">
                <input type="number" value={form.lastWeekCompleted||0} onChange={e=>upd("lastWeekCompleted",+e.target.value||0)} style={iStyle}/>
              </FF>
              <FF label="Quality Score % (auto-logs to history)"><input type="number" value={form.qualityScore} onChange={e=>upd("qualityScore",Math.min(100,+e.target.value||0))} style={iStyle}/></FF>
              <FF label="Avg AHT / Speed (h)"><input type="number" step="0.1" value={form.avgSpeed} onChange={e=>upd("avgSpeed",+e.target.value||0)} style={iStyle}/></FF>
              <FF label="Per-Task Rate ($)"><input type="number" step="0.01" value={form.perTaskRate} onChange={e=>upd("perTaskRate",+e.target.value||0)} style={iStyle}/></FF>
              <FF label="Bonus Earned ($)"><input type="number" value={form.bonusEarned} onChange={e=>upd("bonusEarned",+e.target.value||0)} style={iStyle}/></FF>
            </>}
            {(!isE&&!isR)&&<>
              <FF label="Role"><input type="text" value={form.role} onChange={e=>upd("role",e.target.value)} style={iStyle}/></FF>
              <FF label="Hourly Rate ($/h)"><input type="number" step="0.5" value={form.hourlyRate||0} onChange={e=>upd("hourlyRate",+e.target.value||0)} style={iStyle}/></FF>
              <FF label="Activity %"><input type="number" value={form.activityPct} onChange={e=>upd("activityPct",Math.min(100,+e.target.value||0))} style={iStyle}/></FF>
              <div style={{gridColumn:"1/-1"}}><FF label="Responsibilities"><input type="text" value={form.responsibilities} onChange={e=>upd("responsibilities",e.target.value)} style={iStyle}/></FF></div>
            </>}
          </div>
          {(isE||isR)&&form.qualityHistory?.length>0&&(
            <div style={{marginBottom:14,padding:12,background:"#f8fafc",borderRadius:8}}>
              <div style={{color:C.muted,fontSize:11,fontWeight:700,marginBottom:6}}>QUALITY HISTORY</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {form.qualityHistory.map((h,i)=><span key={i} style={{fontFamily:"'DM Mono',monospace",fontSize:12,background:h.score>=threshold?C.greenSoft:C.redSoft,color:h.score>=threshold?C.greenText:C.redText,padding:"2px 8px",borderRadius:5}}>{h.date}: {h.score}%</span>)}
              </div>
            </div>
          )}
          <button onClick={save} style={btnPri}>{editId?"Save Changes":"Add"}</button>
        </Modal>
      )}
    </div>
  );
}

// ─── TICKETS ─────────────────────────────────────────────────────────────────
function TicketsTab({tickets,setTickets,experts,reviewers,opsTeam}){
  const [search,setSearch]=useState(""); const [filterPri,setFilterPri]=useState("all");
  const [filterAssignee,setFilterAssignee]=useState("all"); const [filterType,setFilterType]=useState("all");
  const [modal,setModal]=useState(false); const [editModal,setEditModal]=useState(null); const [dragId,setDragId]=useState(null);
  const [form,setForm]=useState({title:"",priority:"Medium",type:"expert",assignee:"",owner:"",deadline:"",description:""});
  const TICKET_TYPES=["expert","ops","review","documentation","training","miscellaneous"];
  const people=[...experts,...reviewers,...opsTeam].map(x=>x.name).filter(Boolean);
  const filtered=tickets.filter(t=>
    (filterPri==="all"||t.priority===filterPri)&&
    (filterAssignee==="all"||t.assignee===filterAssignee)&&
    (filterType==="all"||t.type===filterType)&&
    (!search||t.title.toLowerCase().includes(search.toLowerCase()))
  );
  const typeColor=t=>({expert:C.purple,ops:C.orange,review:C.cyan,documentation:C.blue,training:C.teal,miscellaneous:C.muted}[t]||C.muted);
  const create=()=>{
    if(!form.title.trim())return;
    setTickets(p=>{
      const nextId=uniqueIdForItems(p,"TKT");
      return [...p,{...form,id:nextId,status:"NOT STARTED",createdAt:today()}];
    });
    setForm({title:"",priority:"Medium",type:"expert",assignee:"",owner:"",deadline:"",description:""});setModal(false);
  };
  const saveEdit=()=>{
    setTickets(p=>{
      let edited=false;
      return p.map(t=>{
        if(edited||t.id!==editModal.id) return t;
        edited=true;
        return {...t,...editModal};
      });
    });
    setEditModal(null);
  };
  const del=id=>setTickets(p=>{
    let removed=false;
    return p.filter(t=>{
      if(removed||t.id!==id) return true;
      removed=true;
      return false;
    });
  });
  const move=(id,status)=>setTickets(p=>{
    let moved=false;
    return p.map(t=>{
      if(moved||t.id!==id) return t;
      moved=true;
      return {...t,status};
    });
  });

  return(
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search tickets..." style={{...iStyle,flex:1,minWidth:140,width:"auto"}}/>
        <select value={filterPri} onChange={e=>setFilterPri(e.target.value)} style={{...selStyle,width:130}}><option value="all">All Priority</option><option>High</option><option>Medium</option><option>Low</option></select>
        <select value={filterType} onChange={e=>setFilterType(e.target.value)} style={{...selStyle,width:150}}><option value="all">All Types</option>{TICKET_TYPES.map(t=><option key={t}>{t}</option>)}</select>
        <select value={filterAssignee} onChange={e=>setFilterAssignee(e.target.value)} style={{...selStyle,width:160}}><option value="all">All Assignees</option>{people.map(p=><option key={p} value={p}>{p}</option>)}</select>
        <button onClick={()=>setModal(true)} style={{...btnSm,background:C.blue,color:"#fff",border:"none"}}>+ New Ticket</button>
        <ExBtn onClick={()=>dlXLSX([{name:"Tickets",data:tickets.map(t=>({ID:t.id,Title:t.title,Status:t.status,Priority:t.priority,Type:t.type,Assignee:t.assignee,Owner:t.owner,Deadline:t.deadline,Created:t.createdAt,"Age (days)":t.createdAt?daysSince(t.createdAt):"—",Description:t.description}))}],"NES_Tickets")} label="⬇ Export"/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,overflowX:"auto",minWidth:800}}>
        {TICKET_STATUSES.map(status=>{
          const col=filtered.filter(t=>t.status===status);
          return(
            <div key={status} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(dragId)move(dragId,status);setDragId(null);}}
              style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,minHeight:340,display:"flex",flexDirection:"column"}}>
              <div style={{padding:"12px 14px",borderBottom:`3px solid ${STATUS_COLORS[status]}`,display:"flex",justifyContent:"space-between"}}>
                <span style={{color:STATUS_COLORS[status],fontSize:10,fontWeight:800,letterSpacing:"0.07em"}}>{status}</span>
                <span style={{background:STATUS_COLORS[status]+"22",color:STATUS_COLORS[status],borderRadius:"50%",width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800}}>{col.length}</span>
              </div>
              <div style={{padding:9,display:"flex",flexDirection:"column",gap:8,flex:1,overflowY:"auto"}}>
                {col.map(t=>{
                  const age=t.createdAt?daysSince(t.createdAt):null;
                  const stale=age!=null&&age>7&&t.status!=="COMPLETED";
                  return(
                    <div key={t.id} draggable onDragStart={()=>setDragId(t.id)}
                      style={{background:"#f8fafc",border:`1px solid ${C.border}`,borderLeft:`3px solid ${PRIORITY_COLORS[t.priority]}`,borderRadius:8,padding:"10px 12px",cursor:"grab"}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                        <span style={{color:C.faint,fontSize:10,fontFamily:"'DM Mono',monospace"}}>{t.id}</span>
                        <Bdg color={typeColor(t.type)}>{t.type}</Bdg>
                      </div>
                      <div style={{color:C.text,fontWeight:700,fontSize:12,marginBottom:5,lineHeight:1.4}}>{t.title}</div>
                      {t.assignee&&<div style={{color:C.muted,fontSize:11,marginBottom:3}}>👤 {t.assignee}</div>}
                      {t.deadline&&<div style={{color:new Date(t.deadline)<new Date()?C.red:C.muted,fontSize:11,marginBottom:3}}>📅 {t.deadline}</div>}
                      {age!=null&&<div style={{color:stale?C.red:C.faint,fontSize:10,marginBottom:5}}>⏱ {age}d{stale?" · STALE":""}</div>}
                      <div style={{display:"flex",gap:5,justifyContent:"space-between",alignItems:"center"}}>
                        <Bdg color={PRIORITY_COLORS[t.priority]}>{t.priority}</Bdg>
                        <div style={{display:"flex",gap:4}}>
                          <button onClick={()=>setEditModal({...t})} style={{...btnSm,padding:"2px 8px",fontSize:10}}>Edit</button>
                          <button onClick={()=>del(t.id)} style={{...btnSm,padding:"2px 7px",fontSize:10,color:C.red,borderColor:C.red+"50"}}>✕</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {modal&&(
        <Modal title="Create Ticket" onClose={()=>setModal(false)}>
          <FF label="Title"><input type="text" value={form.title} onChange={e=>setForm(p=>({...p,title:e.target.value}))} style={iStyle} placeholder="Describe the ticket..."/></FF>
          <FF label="Assignee"><select value={form.assignee} onChange={e=>setForm(p=>({...p,assignee:e.target.value}))} style={selStyle}><option value="">— Select —</option>{people.map(p=><option key={p} value={p}>{p}</option>)}</select></FF>
          <FF label="Owner (Ops)"><select value={form.owner} onChange={e=>setForm(p=>({...p,owner:e.target.value}))} style={selStyle}><option value="">— Select —</option>{opsTeam.map(m=><option key={m.id} value={m.name}>{m.name}</option>)}</select></FF>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
            <FF label="Priority"><select value={form.priority} onChange={e=>setForm(p=>({...p,priority:e.target.value}))} style={selStyle}><option>High</option><option>Medium</option><option>Low</option></select></FF>
            <FF label="Type"><select value={form.type} onChange={e=>setForm(p=>({...p,type:e.target.value}))} style={selStyle}>{TICKET_TYPES.map(t=><option key={t} value={t}>{t}</option>)}</select></FF>
            <FF label="Deadline"><input type="date" value={form.deadline} onChange={e=>setForm(p=>({...p,deadline:e.target.value}))} style={iStyle}/></FF>
          </div>
          <FF label="Description"><textarea value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))} style={{...iStyle,height:70,resize:"vertical"}}/></FF>
          <button onClick={create} style={btnPri}>Create Ticket</button>
        </Modal>
      )}
      {editModal&&(
        <Modal title={`Edit ${editModal.id}`} onClose={()=>setEditModal(null)}>
          <FF label="Title"><input type="text" value={editModal.title} onChange={e=>setEditModal(p=>({...p,title:e.target.value}))} style={iStyle}/></FF>
          <FF label="Assignee"><select value={editModal.assignee||""} onChange={e=>setEditModal(p=>({...p,assignee:e.target.value}))} style={selStyle}><option value="">— Unassigned —</option>{people.map(p=><option key={p} value={p}>{p}</option>)}</select></FF>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:10}}>
            <FF label="Status"><select value={editModal.status} onChange={e=>setEditModal(p=>({...p,status:e.target.value}))} style={selStyle}>{TICKET_STATUSES.map(s=><option key={s}>{s}</option>)}</select></FF>
            <FF label="Priority"><select value={editModal.priority} onChange={e=>setEditModal(p=>({...p,priority:e.target.value}))} style={selStyle}><option>High</option><option>Medium</option><option>Low</option></select></FF>
            <FF label="Type"><select value={editModal.type||"expert"} onChange={e=>setEditModal(p=>({...p,type:e.target.value}))} style={selStyle}>{TICKET_TYPES.map(t=><option key={t}>{t}</option>)}</select></FF>
            <FF label="Deadline"><input type="date" value={editModal.deadline||""} onChange={e=>setEditModal(p=>({...p,deadline:e.target.value}))} style={iStyle}/></FF>
          </div>
          <FF label="Description"><textarea value={editModal.description||""} onChange={e=>setEditModal(p=>({...p,description:e.target.value}))} style={{...iStyle,height:70,resize:"vertical"}}/></FF>
          <button onClick={saveEdit} style={btnPri}>Save Changes</button>
        </Modal>
      )}
    </div>
  );
}

// ─── TASKS ───────────────────────────────────────────────────────────────────
function TasksTab({taskTracker,setTaskTracker}){
  const [activeWeek,setActiveWeek]=useState(0);
  const addWeek=()=>{
    const n=taskTracker.length+1;
    setTaskTracker(p=>[...p,{id:n,label:`Week ${n}`,date:today(),goal:0,sbqRate:0.25,totalCB:0,newAnnotators:0,newReviewers:0,oldAnnotators:0,oldReviewers:0,tasksPerWeekAnnotator:5,tasksPerWeekReviewer:15}]);
    setActiveWeek(taskTracker.length);
  };
  const upd=(f,v)=>setTaskTracker(p=>p.map((w,i)=>i===activeWeek?{...w,[f]:+v||0}:w));
  if(taskTracker.length===0) return(
    <div style={{textAlign:"center",padding:60}}>
      <div style={{color:C.muted,marginBottom:16}}>No weeks tracked yet.</div>
      <button onClick={addWeek} style={{...btnSm,background:C.blue,color:"#fff",border:"none"}}>+ Add Week 1</button>
    </div>
  );
  const w=taskTracker[activeWeek];
  const attNeeded=w.sbqRate<1&&w.sbqRate>0?Math.ceil(w.goal/(1-w.sbqRate)):w.goal;
  const actual=(w.newAnnotators+w.oldAnnotators)*w.tasksPerWeekAnnotator;
  const buffer=actual-w.goal;
  const newAnnTasks=w.newAnnotators*w.tasksPerWeekAnnotator;
  const newRevTasks=w.newReviewers*w.tasksPerWeekReviewer;
  const completedEOW=newAnnTasks;
  const reviewedEOW=Math.min(newRevTasks,completedEOW);
  const cumData=taskTracker.reduce((acc,wk)=>{
    const completed=wk.newAnnotators*wk.tasksPerWeekAnnotator;
    const prevCum=acc.length>0?acc[acc.length-1].cumulative:0;
    acc.push({week:wk.label,completed,cumulative:prevCum+completed});
    return acc;
  },[]);
  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
        {taskTracker.map((wk,i)=>(
          <button key={i} onClick={()=>setActiveWeek(i)} style={{...btnSm,background:activeWeek===i?C.blue:C.surface,color:activeWeek===i?"#fff":C.text,border:activeWeek===i?"none":`1px solid ${C.border}`}}>{wk.label}</button>
        ))}
        <button onClick={addWeek} style={btnSm}>+ Add Week</button>
        {taskTracker.length>0&&<button onClick={()=>{if(confirm("Delete this week?")){setTaskTracker(p=>p.filter((_,i)=>i!==activeWeek));setActiveWeek(Math.max(0,activeWeek-1));}}} style={{...btnSm,color:C.red,borderColor:C.red+"50"}}>Delete Week</button>}
        <ExBtn onClick={()=>dlXLSX([{name:"Task Tracker",data:taskTracker.map(wk=>{const c=wk.newAnnotators*wk.tasksPerWeekAnnotator;const r=Math.min(wk.newReviewers*wk.tasksPerWeekReviewer,c);return{Week:wk.label,Date:wk.date||"",Goal:wk.goal,"SBQ %":(wk.sbqRate*100).toFixed(1),Actual:(wk.newAnnotators+wk.oldAnnotators)*wk.tasksPerWeekAnnotator,"EOW Completed":c,"EOW Reviewed":r,"EOW Not Reviewed":c-r};})}],"NES_Tasks")} label="⬇ Export Tasks"/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:16}}>
        <div style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:12,padding:20}}>
          <div style={{fontWeight:800,fontSize:14,marginBottom:14}}>📋 Tasks</div>
          {[["Goal","goal",true],["SBQ Rate %",null,false],["Attempts Needed",null,false],["Actual",null,false],["Buffer",null,false]].map(([label])=>(
            <div key={label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #fde68a50"}}>
              <span style={{color:C.muted,fontSize:13}}>{label}</span>
              {label==="Goal"?<InN value={w.goal} onChange={v=>upd("goal",v)} width="75px"/>
               :label==="SBQ Rate %"?<InN value={+(w.sbqRate*100).toFixed(0)} onChange={v=>upd("sbqRate",v/100)} suffix="%" width="60px"/>
               :<span style={{fontFamily:"'DM Mono',monospace",fontWeight:700,color:label==="Buffer"?(buffer>=0?C.green:C.red):C.text}}>
                 {label==="Attempts Needed"?fmt(attNeeded):label==="Actual"?fmt(actual):fmt(buffer)}
               </span>}
            </div>
          ))}
        </div>
        <div style={{background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:12,padding:20}}>
          <div style={{fontWeight:800,fontSize:14,marginBottom:14}}>👥 Contributors</div>
          {[["Total CB","totalCB"],["New Annotators","newAnnotators"],["New Reviewers","newReviewers"],["Old Annotators","oldAnnotators"],["Old Reviewers","oldReviewers"]].map(([label,field])=>(
            <div key={field} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #bfdbfe50"}}>
              <span style={{color:C.muted,fontSize:13}}>{label}</span>
              <InN value={w[field]} onChange={v=>upd(field,v)} width="65px"/>
            </div>
          ))}
          <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0"}}><span style={{fontWeight:700,fontSize:13}}>Total Ann.</span><span style={{fontFamily:"'DM Mono',monospace",fontWeight:800,color:C.blue}}>{w.newAnnotators+w.oldAnnotators}</span></div>
          <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0"}}><span style={{fontWeight:700,fontSize:13}}>Total Rev.</span><span style={{fontFamily:"'DM Mono',monospace",fontWeight:800,color:C.purple}}>{w.newReviewers+w.oldReviewers}</span></div>
        </div>
        <div style={{background:"#fdf4ff",border:"1px solid #e9d5ff",borderRadius:12,padding:20}}>
          <div style={{fontWeight:800,fontSize:14,marginBottom:14}}>⚙️ Work</div>
          {[["Tasks/Wk (Annotator)","tasksPerWeekAnnotator"],["Tasks/Wk (Reviewer)","tasksPerWeekReviewer"]].map(([label,field])=>(
            <div key={field} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #e9d5ff50"}}>
              <span style={{color:C.muted,fontSize:13}}>{label}</span><InN value={w[field]} onChange={v=>upd(field,v)} width="65px"/>
            </div>
          ))}
          <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #e9d5ff50"}}><span style={{color:C.muted,fontSize:13}}>New Ann. Tasks</span><span style={{fontFamily:"'DM Mono',monospace",fontWeight:700}}>{fmt(newAnnTasks)}</span></div>
          <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0"}}><span style={{color:C.muted,fontSize:13}}>New Rev. Tasks</span><span style={{fontFamily:"'DM Mono',monospace",fontWeight:700}}>{fmt(newRevTasks)}</span></div>
        </div>
      </div>
      <Card title="📊 End of Week Totals">
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16}}>
          {[["Completed",completedEOW,C.green,C.greenSoft,"New Ann × Tasks/Wk"],["Reviewed",reviewedEOW,C.blue,C.blueSoft,"min(Rev Tasks, Completed)"],["Not Reviewed",completedEOW-reviewedEOW,C.yellow,C.yellowSoft,"Completed − Reviewed"]].map(([label,val,color,bg,note])=>(
            <div key={label} style={{background:bg,borderRadius:10,padding:18,textAlign:"center"}}>
              <div style={{color,fontWeight:800,fontSize:28,fontFamily:"'DM Mono',monospace"}}>{fmt(val)}</div>
              <div style={{color,fontWeight:700,fontSize:13,marginTop:4}}>{label}</div>
              <div style={{color:C.muted,fontSize:11,marginTop:4}}>{note}</div>
            </div>
          ))}
        </div>
      </Card>
      {cumData.length>1&&(
        <Card title="📈 Cumulative Progress Across All Weeks">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={cumData}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
              <XAxis dataKey="week" tick={{fontSize:11}}/>
              <YAxis tick={{fontSize:10}}/>
              <Tooltip contentStyle={{borderRadius:8}}/>
              <Legend/>
              <Area type="monotone" dataKey="cumulative" name="Cumulative" stroke={C.blue} fill={C.blueSoft} strokeWidth={2}/>
            </AreaChart>
          </ResponsiveContainer>
        </Card>
      )}
    </div>
  );
}

// ─── VELOCITY ────────────────────────────────────────────────────────────────
function VelocityTab({taskTracker,rampData}){
  const [activePhase,setActivePhase]=useState(0);
  const ramp=rampData[activePhase];
  const phase=PHASES.find(p=>p.id===ramp?.id);
  let rampCum=0,actualCum=0;
  const chartData=ramp?.weeks.map((w,i)=>{
    const target=ramp.taskTargets[i]||0;
    rampCum+=target;
    const tk=taskTracker[i];
    const actual=tk?(tk.newAnnotators+tk.oldAnnotators)*tk.tasksPerWeekAnnotator:null;
    if(actual!=null)actualCum+=actual;
    return{week:w,weeklyTarget:target,weeklyActual:actual??0,cumulativeTarget:rampCum,cumulativeActual:actual!=null?actualCum:null};
  })||[];
  const lastActual=chartData.filter(d=>d.cumulativeActual!=null).slice(-1)[0];
  const weeksWithData=chartData.filter(d=>d.cumulativeActual!=null).length;
  const variance=lastActual?lastActual.cumulativeActual-lastActual.cumulativeTarget:null;
  const pctVariance=lastActual&&lastActual.cumulativeTarget>0?(variance/lastActual.cumulativeTarget*100):null;
  const avgOutput=weeksWithData>0&&lastActual?lastActual.cumulativeActual/weeksWithData:0;
  const projectedFinal=ramp?avgOutput*ramp.weeks.length:null;
  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:"14px 20px"}}>
        <div style={{color:C.muted,fontSize:11,fontWeight:700,marginBottom:10,textTransform:"uppercase",letterSpacing:"0.07em"}}>Select Phase</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {rampData.map((r,i)=>{const ph=PHASES.find(p=>p.id===r.id);return(
            <button key={i} onClick={()=>setActivePhase(i)} style={{...btnSm,background:activePhase===i?(ph?.color||C.blue):C.surface,color:activePhase===i?"#fff":C.text,border:activePhase===i?"none":`1px solid ${C.border}`}}>{r.name}</button>
          );})}
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14}}>
        <KPI label="Phase Target" value={ramp?fmt(ramp.totalTasks):"—"} color={phase?.color||C.blue} icon="🎯"/>
        <KPI label="Weeks Tracked" value={`${weeksWithData}/${ramp?.weeks.length||0}`} color={C.muted} icon="📅"/>
        <KPI label="Cumulative Actual" value={lastActual?fmt(lastActual.cumulativeActual):"—"} color={C.blue} icon="✅"/>
        <KPI label="Variance vs Plan" value={variance!=null?`${variance>=0?"+":""}${fmt(variance)}`:"—"} color={variance!=null?(variance>=0?C.green:C.red):C.muted} icon={variance>=0?"📈":"📉"} delta={pctVariance}/>
      </div>
      {projectedFinal!=null&&(
        <div style={{background:projectedFinal>=ramp.totalTasks?C.greenSoft:C.redSoft,border:`1px solid ${projectedFinal>=ramp.totalTasks?C.green:C.red}30`,borderRadius:10,padding:18,display:"flex",gap:20,alignItems:"center"}}>
          <span style={{fontSize:28}}>{projectedFinal>=ramp.totalTasks?"✅":"⚠️"}</span>
          <div>
            <div style={{fontWeight:800,fontSize:15,color:projectedFinal>=ramp.totalTasks?C.greenText:C.redText}}>
              {projectedFinal>=ramp.totalTasks?"On track":"At risk — projected shortfall"}
            </div>
            <div style={{color:C.muted,fontSize:13,marginTop:4}}>
              Projected final: <strong>{fmt(Math.round(projectedFinal))}</strong> vs target <strong>{fmt(ramp.totalTasks)}</strong>
              {projectedFinal<ramp.totalTasks&&<span style={{color:C.red}}> — shortfall ~{fmt(Math.round(ramp.totalTasks-projectedFinal))}</span>}
            </div>
          </div>
        </div>
      )}
      <Card title="Cumulative: Actual vs Plan">
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
            <XAxis dataKey="week" tick={{fontSize:11}}/>
            <YAxis tick={{fontSize:10}}/>
            <Tooltip contentStyle={{borderRadius:8}}/>
            <Legend/>
            <Line type="monotone" dataKey="cumulativeTarget" name="Plan" stroke={C.faint} strokeWidth={2} strokeDasharray="5 5" dot={false}/>
            <Line type="monotone" dataKey="cumulativeActual" name="Actual" stroke={C.blue} strokeWidth={2.5} dot={{r:4}} connectNulls={false}/>
          </LineChart>
        </ResponsiveContainer>
      </Card>
      <Card title="Weekly Output: Actual vs Target">
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
            <XAxis dataKey="week" tick={{fontSize:11}}/>
            <YAxis tick={{fontSize:10}}/>
            <Tooltip contentStyle={{borderRadius:8}}/>
            <Legend/>
            <Bar dataKey="weeklyTarget" name="Target" fill={C.faint} radius={[4,4,0,0]}/>
            <Bar dataKey="weeklyActual" name="Actual" fill={C.blue} radius={[4,4,0,0]}/>
          </BarChart>
        </ResponsiveContainer>
      </Card>
    </div>
  );
}

// ─── QUALITY CONTROL ─────────────────────────────────────────────────────────
function QualityTab({experts,reviewers,financials}){
  const all=[...experts.map(x=>({...x,type:"Expert"})),...reviewers.map(x=>({...x,type:"Reviewer"}))];
  const threshold=financials.qualityThreshold||90;
  const withQ=all.filter(x=>x.qualityScore>0);
  const passing=withQ.filter(x=>x.qualityScore>=threshold);
  const failing=withQ.filter(x=>x.qualityScore<threshold);
  const avgQ=withQ.length?withQ.reduce((s,x)=>s+x.qualityScore,0)/withQ.length:0;
  const withAHT=all.filter(x=>x.avgSpeed>0);
  const avgAHT=withAHT.length?withAHT.reduce((s,x)=>s+x.avgSpeed,0)/withAHT.length:0;
  const slowCB=withAHT.filter(x=>x.avgSpeed>avgAHT*1.3);
  const fastCB=withAHT.filter(x=>x.avgSpeed<avgAHT*0.6);
  const declining=all.filter(x=>{const h=x.qualityHistory||[];return h.length>=2&&h[h.length-1].score<h[h.length-2].score;});
  const improving=all.filter(x=>{const h=x.qualityHistory||[];return h.length>=2&&h[h.length-1].score>h[h.length-2].score;});
  const annRev=experts.filter(x=>x.status==="active").length/(reviewers.filter(x=>x.status==="active").length||1);
  const buckets=[{label:"95–100",min:95,max:100},{label:"90–94",min:90,max:94},{label:"85–89",min:85,max:89},{label:"80–84",min:80,max:84},{label:"<80",min:0,max:79}];
  const distData=buckets.map(b=>({range:b.label,count:withQ.filter(x=>x.qualityScore>=b.min&&x.qualityScore<=b.max).length,color:b.min>=threshold?C.green:b.min>=80?C.yellow:C.red}));
  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14}}>
        <KPI label="Avg Quality" value={avgQ>0?fmtP(avgQ):"—"} color={avgQ>=threshold?C.green:C.red} icon="⭐" delta={avgQ>0?avgQ-threshold:null}/>
        <KPI label="Pass Rate" value={`${passing.length}/${withQ.length}`} sub={`${withQ.length>0?Math.round(passing.length/withQ.length*100):0}%`} color={C.green} icon="✅"/>
        <KPI label="Below Threshold" value={failing.length} color={failing.length>0?C.red:C.green} icon="⚠️"/>
        <KPI label="Ann:Rev Ratio" value={`${annRev.toFixed(1)}:1`} color={annRev>4?C.red:annRev>3?C.yellow:C.green} sub="target ≤4:1" icon="⚖️"/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
        <Card title="Quality Distribution">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={distData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
              <XAxis type="number" tick={{fontSize:10}}/>
              <YAxis type="category" dataKey="range" tick={{fontSize:11}} width={55}/>
              <Tooltip contentStyle={{borderRadius:8}}/>
              <Bar dataKey="count" name="Contributors" radius={[0,4,4,0]}>{distData.map((e,i)=><Cell key={i} fill={e.color}/>)}</Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="AHT vs Team Average">
          <div style={{marginBottom:12}}>
            {[["Team Avg AHT",avgAHT>0?`${avgAHT.toFixed(2)}h`:"—",C.blue],[`High AHT (>130% avg) — slow`,`${slowCB.length}`,slowCB.length>0?C.red:C.green],[`Low AHT (<60% avg) — fast`,`${fastCB.length}`,fastCB.length>0?C.yellow:C.green]].map(([label,val,color])=>(
              <div key={label} style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                <span style={{color:C.muted,fontSize:13}}>{label}</span>
                <span style={{fontFamily:"'DM Mono',monospace",fontWeight:700,color}}>{val}</span>
              </div>
            ))}
          </div>
          {withAHT.length>0&&<ResponsiveContainer width="100%" height={110}>
            <BarChart data={withAHT.map(x=>({name:x.name.split(" ")[0],aht:x.avgSpeed}))}>
              <XAxis dataKey="name" tick={{fontSize:9}}/><YAxis tick={{fontSize:9}}/>
              <ReferenceLine y={avgAHT} stroke={C.blue} strokeDasharray="4 4"/>
              <Tooltip contentStyle={{borderRadius:8}}/>
              <Bar dataKey="aht" name="AHT (h)" radius={[4,4,0,0]}>{withAHT.map((x,i)=><Cell key={i} fill={x.avgSpeed>avgAHT*1.3?C.red:x.avgSpeed<avgAHT*0.6?C.yellow:C.green}/>)}</Bar>
            </BarChart>
          </ResponsiveContainer>}
        </Card>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
        <Card title="📉 Declining Quality">
          {declining.length===0?<div style={{color:C.faint,textAlign:"center",padding:30}}>No declining trends ✓</div>:(
            declining.map(x=>{const h=x.qualityHistory||[];const drop=h[h.length-1].score-h[h.length-2].score;return(
              <div key={x.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",background:C.redSoft,borderRadius:8,marginBottom:8}}>
                <div><div style={{fontWeight:700}}>{x.name}</div><div style={{color:C.muted,fontSize:12}}>{x.type} · {x.region}</div></div>
                <Spark data={h.map(e=>e.score)} color={C.red} threshold={threshold}/>
                <span style={{color:C.red,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{drop.toFixed(1)}% ▼</span>
              </div>
            );})
          )}
        </Card>
        <Card title="📈 Improving Quality">
          {improving.length===0?<div style={{color:C.faint,textAlign:"center",padding:30}}>No improving trends yet</div>:(
            improving.map(x=>{const h=x.qualityHistory||[];const gain=h[h.length-1].score-h[h.length-2].score;return(
              <div key={x.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",background:C.greenSoft,borderRadius:8,marginBottom:8}}>
                <div><div style={{fontWeight:700}}>{x.name}</div><div style={{color:C.muted,fontSize:12}}>{x.type} · {x.region}</div></div>
                <Spark data={h.map(e=>e.score)} color={C.green} threshold={threshold}/>
                <span style={{color:C.green,fontFamily:"'DM Mono',monospace",fontWeight:700}}>+{gain.toFixed(1)}% ▲</span>
              </div>
            );})
          )}
        </Card>
      </div>
      <Card title="Quality Leaderboard">
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <TH cols={["#","Name","Type","Region","Quality %","AHT","Flag","Trend","History"]}/>
            <tbody>
              {withQ.sort((a,b)=>b.qualityScore-a.qualityScore).map((x,i)=>{
                const hist=(x.qualityHistory||[]).map(h=>h.score);
                const ahtFlag=avgAHT>0&&x.avgSpeed>0?(x.avgSpeed>avgAHT*1.3?"slow":x.avgSpeed<avgAHT*0.6?"fast":null):null;
                return(
                  <tr key={x.id} style={{borderTop:`1px solid ${C.border}`,background:i%2?"#fafafa":C.surface}}>
                    <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",color:i<3?C.yellow:C.faint,width:40}}>{i+1}</td>
                    <td style={{padding:"10px 14px",fontWeight:700}}>{x.name}</td>
                    <td style={{padding:"10px 14px"}}><Bdg color={x.type==="Expert"?C.blue:C.purple}>{x.type}</Bdg></td>
                    <td style={{padding:"10px 14px",color:C.muted,fontSize:13}}>{x.region}</td>
                    <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",fontWeight:700,color:x.qualityScore>=threshold?C.green:C.red}}>{fmtP(x.qualityScore)}</td>
                    <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace"}}>{x.avgSpeed>0?`${x.avgSpeed}h`:"—"}</td>
                    <td style={{padding:"10px 14px"}}>{ahtFlag?<Bdg color={ahtFlag==="slow"?C.red:C.yellow}>{ahtFlag}</Bdg>:<span style={{color:C.faint}}>—</span>}</td>
                    <td style={{padding:"10px 14px"}}><Spark data={hist} color={x.qualityScore>=threshold?C.green:C.red} threshold={threshold}/></td>
                    <td style={{padding:"10px 14px",fontSize:11,color:C.muted,fontFamily:"'DM Mono',monospace"}}>{hist.length>0?hist.join("→"):"—"}</td>
                  </tr>
                );
              })}
              {withQ.length===0&&<tr><td colSpan={9} style={{padding:40,textAlign:"center",color:C.faint}}>Add quality scores to see the leaderboard.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ─── STANDUP ─────────────────────────────────────────────────────────────────
function StandupTab({experts,reviewers,opsTeam,tickets,taskTracker,financials}){
  const threshold=financials.qualityThreshold||90;
  const todayStr=new Date().toLocaleDateString("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"});
  const activeExperts=experts.filter(e=>e.status==="active");
  const activeReviewers=reviewers.filter(r=>r.status==="active");
  const weeklyAttempts=experts.reduce((s,e)=>s+(e.tasksCompleted-(e.lastWeekCompleted||0)),0);
  const weeklyReviews=reviewers.reduce((s,r)=>s+(r.tasksReviewed-(r.lastWeekCompleted||0)),0);
  const overdue=tickets.filter(t=>t.deadline&&new Date(t.deadline)<new Date()&&t.status!=="COMPLETED");
  const highPri=tickets.filter(t=>t.priority==="High"&&t.status!=="COMPLETED");
  const stale=tickets.filter(t=>t.createdAt&&daysSince(t.createdAt)>7&&t.status!=="COMPLETED");
  const belowQ=()=> ([...experts,...reviewers]).filter(x=>x.status==="active"&&x.qualityScore>0&&x.qualityScore<threshold);
  const bq=belowQ();
  const zeroExperts=activeExperts.filter(e=>(e.tasksCompleted-(e.lastWeekCompleted||0))===0);
  const [copied,setCopied]=useState(false);
  const latestWeek=taskTracker[taskTracker.length-1];
  const report=`📋 WEEKLY STANDUP — ${todayStr}\n${"═".repeat(48)}\n\nTEAM\n  Active Experts:   ${activeExperts.length}\n  Active Reviewers: ${activeReviewers.length}\n  Ops Team:         ${opsTeam.length}\n\nTHIS WEEK'S OUTPUT\n  Attempts delta:  ${weeklyAttempts}\n  Reviews delta:   ${weeklyReviews}\n\nQUALITY\n  Below threshold: ${bq.length}${bq.length>0?"\n  → "+bq.map(x=>x.name+"("+x.qualityScore+"%)").join(", "):""}\n\nTICKETS\n  High Priority: ${highPri.length}\n  Overdue: ${overdue.length}${overdue.length>0?"\n  → "+overdue.slice(0,3).map(t=>t.id+": "+t.title).join("\n  → "):""}\n  Stale (>7d): ${stale.length}\n\n${latestWeek?`TASKS (${latestWeek.label})\n  Goal: ${latestWeek.goal} | SBQ: ${(latestWeek.sbqRate*100).toFixed(0)}%\n  Annotators: ${latestWeek.newAnnotators+latestWeek.oldAnnotators} | Reviewers: ${latestWeek.newReviewers+latestWeek.oldReviewers}`:"TASKS: No weeks tracked yet"}\n\n${"─".repeat(48)}\nGitHub NES Ops Center`;
  const copy=()=>{navigator.clipboard.writeText(report);setCopied(true);setTimeout(()=>setCopied(false),2000);};
  const Pill=({c,label})=><span style={{background:c==="green"?C.greenSoft:c==="yellow"?C.yellowSoft:C.redSoft,color:c==="green"?C.green:c==="yellow"?C.yellow:C.red,border:`1px solid ${c==="green"?C.green:c==="yellow"?C.yellow:C.red}40`,borderRadius:20,padding:"4px 14px",fontSize:12,fontWeight:700}}>{label.toUpperCase()}</span>;
  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <div style={{background:C.navy,borderRadius:12,padding:"20px 28px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div><div style={{color:"#94a3b8",fontSize:12,fontWeight:600,marginBottom:4}}>WEEKLY STANDUP</div><div style={{color:"#f1f5f9",fontWeight:800,fontSize:22}}>{todayStr}</div></div>
        <button onClick={copy} style={{...btnSm,background:copied?C.green:"#ffffff20",color:"#fff",border:"none"}}>{copied?"✓ Copied!":"📋 Copy Report"}</button>
      </div>
      <Card title="🚦 Project RAG Status">
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
          {[
            {label:"Quality",c:bq.length>2?"red":bq.length>0?"yellow":"green",detail:bq.length>0?`${bq.length} below ${threshold}%`:"All above threshold"},
            {label:"Delivery",c:overdue.length>3?"red":overdue.length>0?"yellow":"green",detail:overdue.length>0?`${overdue.length} overdue`:"No overdue tickets"},
            {label:"Capacity",c:zeroExperts.length>activeExperts.length*0.3?"red":zeroExperts.length>0?"yellow":"green",detail:`${zeroExperts.length} experts with 0 output this week`},
            {label:"Ticket Health",c:stale.length>5?"red":stale.length>0?"yellow":"green",detail:`${stale.length} stale tickets`},
            {label:"Review Queue",c:tickets.filter(t=>t.status==="PENDING REVIEW").length>10?"red":tickets.filter(t=>t.status==="PENDING REVIEW").length>4?"yellow":"green",detail:`${tickets.filter(t=>t.status==="PENDING REVIEW").length} pending review`},
            {label:"Team Coverage",c:activeExperts.length===0?"red":activeExperts.length<3?"yellow":"green",detail:`${activeExperts.length} active experts`},
          ].map(({label,c,detail})=>(
            <div key={label} style={{background:c==="green"?C.greenSoft:c==="yellow"?C.yellowSoft:C.redSoft,borderRadius:10,padding:16}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}><span style={{fontWeight:700}}>{label}</span><Pill c={c} label={c}/></div>
              <div style={{color:C.muted,fontSize:12}}>{detail}</div>
            </div>
          ))}
        </div>
      </Card>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
        <Card title="📊 This Week's Output (delta since Roll Week)">
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
            <div style={{background:C.blueSoft,borderRadius:10,padding:18,textAlign:"center"}}>
              <div style={{color:C.blue,fontWeight:800,fontSize:32,fontFamily:"'DM Mono',monospace"}}>{weeklyAttempts}</div>
              <div style={{color:C.blueText,fontWeight:600,fontSize:13,marginTop:4}}>Annotation Delta</div>
            </div>
            <div style={{background:C.purpleSoft,borderRadius:10,padding:18,textAlign:"center"}}>
              <div style={{color:C.purple,fontWeight:800,fontSize:32,fontFamily:"'DM Mono',monospace"}}>{weeklyReviews}</div>
              <div style={{color:C.purple,fontWeight:600,fontSize:13,marginTop:4}}>Review Delta</div>
            </div>
          </div>
          {zeroExperts.length>0&&(
            <div style={{marginTop:14,padding:12,background:C.yellowSoft,borderRadius:8}}>
              <div style={{color:C.yellowText,fontWeight:700,fontSize:13,marginBottom:6}}>⚠️ Zero-output Experts This Week</div>
              {zeroExperts.slice(0,5).map(e=><div key={e.id} style={{color:C.muted,fontSize:12}}>• {e.name}</div>)}
            </div>
          )}
        </Card>
        <Card title="🎫 Ticket Alerts">
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {highPri.length===0&&overdue.length===0?<div style={{color:C.faint,textAlign:"center",padding:20}}>No alerts ✓</div>:<>
              {highPri.slice(0,3).map(t=><div key={t.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:C.redSoft,borderRadius:7}}>
                <span style={{fontWeight:600,fontSize:13}}>{t.title.slice(0,38)}{t.title.length>38?"…":""}</span>
                <div style={{display:"flex",gap:6}}><Bdg color={C.red}>HIGH</Bdg>{t.assignee&&<Bdg color={C.muted}>{t.assignee.split(" ")[0]}</Bdg>}</div>
              </div>)}
              {overdue.slice(0,3).map(t=><div key={t.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:C.orangeSoft,borderRadius:7}}>
                <span style={{fontWeight:600,fontSize:13}}>{t.title.slice(0,38)}{t.title.length>38?"…":""}</span>
                <Bdg color={C.orange}>OVERDUE</Bdg>
              </div>)}
            </>}
          </div>
        </Card>
      </div>
      <Card title="📋 Standup Report">
        <pre style={{color:C.muted,fontSize:12,fontFamily:"'DM Mono',monospace",lineHeight:1.8,whiteSpace:"pre-wrap",margin:0,background:"#f8fafc",padding:16,borderRadius:8}}>{report}</pre>
      </Card>
    </div>
  );
}

// ─── RAMP PLAN ───────────────────────────────────────────────────────────────
function RampPlanTab({rampData,setRampData}){
  const [active,setActive]=useState(0);
  const s=rampData[active];

  const updS=(f,v)=>setRampData(p=>p.map((x,i)=>i===active?{...x,[f]:v}:x));
  const updNum=(f,v)=>updS(f,+v||0);
  const updTarget=(wi,v)=>setRampData(p=>p.map((x,i)=>{
    if(i!==active)return x;
    const t=[...x.taskTargets];t[wi]=+v||0;return{...x,taskTargets:t};
  }));
  const updWP=(f,v)=>setRampData(p=>p.map((x,i)=>{
    if(i!==active)return x;
    return{...x,weeklyProduction:{...(x.weeklyProduction||{}),[f]:+v||0}};
  }));

  // Auto-calculated values (used as defaults if user hasn't overridden)
  const aht=s.attemptAHT+s.reviewAHT;
  const autoCalc={
    tasksPerCB:aht>0?+(s.cbHoursPerWeek/aht).toFixed(1):0,
    totalHours:+(s.totalTasks*s.cbHoursPerWeek).toFixed(0),
    totalProduced:+(aht>0?(s.cbHoursPerWeek/aht)*s.totalTasks:0).toFixed(0),
    attemptsPerCB:s.attemptAHT>0?Math.round(s.cbHoursPerWeek/s.attemptAHT):0,
    reviewsPerCB:s.reviewAHT>0?Math.round(s.cbHoursPerWeek/s.reviewAHT):0,
    sbqAffected:Math.round((aht>0?(s.cbHoursPerWeek/aht)*s.totalTasks:0)*s.sbqDefault),
    effectiveProd:0,totalWithSBQ:0,effortHours:0,
  };
  const tp=autoCalc.totalProduced;
  autoCalc.sbqAffected=Math.round(tp*s.sbqDefault);
  autoCalc.effectiveProd=tp-autoCalc.sbqAffected;
  autoCalc.totalWithSBQ=tp+autoCalc.sbqAffected;
  autoCalc.effortHours=Math.round(autoCalc.totalWithSBQ*aht);

  // Use stored overrides if present, else auto-calc
  const wp=s.weeklyProduction||{};
  const getWP=(f)=>wp[f]||autoCalc[f]||0;

  const totalTargets=s.taskTargets.reduce((a,b)=>a+(b||0),0);
  const phase=PHASES.find(p=>p.id===s.id);

  // Dynamic weeks: if duration changes, resize weeks array
  const setDuration=(newWeeks)=>{
    setRampData(p=>p.map((x,i)=>{
      if(i!==active)return x;
      const wks=Array.from({length:newWeeks},(_,j)=>`W${j+1}`);
      const targets=Array.from({length:newWeeks},(_,j)=>x.taskTargets[j]||0);
      return{...x,weeks:wks,taskTargets:targets};
    }));
  };

  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:"14px 20px"}}>
        <div style={{color:C.muted,fontSize:11,fontWeight:700,marginBottom:10,textTransform:"uppercase",letterSpacing:"0.07em"}}>NES Project Phase</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          {rampData.map((x,i)=>{const ph=PHASES.find(p=>p.id===x.id);return(
            <button key={i} onClick={()=>setActive(i)} style={{...btnSm,background:active===i?(ph?.color||C.blue):C.surface,color:active===i?"#fff":C.text,border:active===i?"none":`1px solid ${C.border}`}}>{x.name}</button>
          );})}
          <ExBtn onClick={()=>{
            const sheets=rampData.map(rs=>{
              const a=rs.attemptAHT+rs.reviewAHT;const tCB=a>0?rs.cbHoursPerWeek/a:0;const tProd=tCB*rs.totalTasks;const sbq=Math.round(tProd*rs.sbqDefault);
              const configData=[{Field:"Total Tasks",Value:rs.totalTasks},{Field:"Attempt AHT (h)",Value:rs.attemptAHT},{Field:"Review AHT (h)",Value:rs.reviewAHT},{Field:"AHT E2E (h)",Value:a.toFixed(2)},{Field:"SBQ Rate %",Value:(rs.sbqDefault*100).toFixed(1)},{Field:"CB Hrs/Week",Value:rs.cbHoursPerWeek},{Field:"Tasks/CB/Week",Value:tCB.toFixed(1)},{Field:"SBQ Affected",Value:sbq},{Field:"Effective Prod",Value:Math.round(tProd-sbq)}];
              const sched={};rs.weeks.forEach((w,i)=>{sched[w]=rs.taskTargets[i]||0;});sched["TOTAL"]=rs.taskTargets.reduce((a,b)=>a+(b||0),0);
              return{name:rs.name.slice(0,31),data:[...configData,{},{Field:"--- Schedule ---",Value:""},sched]};
            });
            dlXLSX(sheets,"NES_Ramp_Plan");
          }} label="⬇ Export All Phases"/>
        </div>
      </div>

      {/* Editable phase header */}
      <div style={{background:(phase?.color||C.blue)+"12",border:`1px solid ${phase?.color||C.blue}30`,borderRadius:10,padding:"16px 20px"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16}}>
          <div>
            <div style={{color:C.muted,fontSize:11,fontWeight:700,marginBottom:6}}>PHASE TARGET TASKS</div>
            <InN value={s.totalTasks} onChange={v=>updNum("totalTasks",v)} width="100px"/>
          </div>
          <div>
            <div style={{color:C.muted,fontSize:11,fontWeight:700,marginBottom:6}}>DURATION (WEEKS)</div>
            <InN value={s.weeks.length} onChange={v=>setDuration(Math.max(1,Math.min(26,+v||1)))} width="80px"/>
          </div>
          <div>
            <div style={{color:C.muted,fontSize:11,fontWeight:700,marginBottom:6}}>RAMP TARGET (SCHEDULE TOTAL)</div>
            <div style={{fontFamily:"'DM Mono',monospace",fontWeight:800,fontSize:18,color:totalTargets===s.totalTasks?C.green:C.yellow}}>{fmt(totalTargets)} / {fmt(s.totalTasks)}</div>
          </div>
          <div>
            <div style={{color:C.muted,fontSize:11,fontWeight:700,marginBottom:6}}>AHT END-TO-END</div>
            <div style={{fontFamily:"'DM Mono',monospace",fontWeight:800,fontSize:18,color:phase?.color||C.blue}}>{fmt(aht,2)}h</div>
          </div>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
        <Card title="Task Configuration (Editable)">
          {[["Total Tasks","totalTasks",false],["Attempt AHT (hrs)","attemptAHT",false],["Review AHT (hrs)","reviewAHT",false],["AHT End-to-End",null,true,`${fmt(aht,2)} hrs`],["SBQ Rate","sbqDefault",false,"%",true],["CB Hours/Week","cbHoursPerWeek",false],["New Hires/Week","newHiresPerWeek",false],["Promotion Rate","promotionRate",false,"%",true],["1st Week Capacity","firstWeekCapacity",false,"%",true]].map(([label,field,calc,display,isPct])=>(
            <div key={label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:`1px solid ${C.border}`}}>
              <span style={{color:C.muted,fontSize:13}}>{label}</span>
              {calc?<span style={{fontFamily:"'DM Mono',monospace",fontWeight:700,color:C.blue}}>{display}</span>
                :<InN value={isPct?+(s[field]*100).toFixed(1):s[field]} onChange={v=>updNum(field,isPct?v/100:v)} suffix={isPct?"%":""} width="85px"/>}
            </div>
          ))}
        </Card>

        <Card title="Weekly Production (Editable — overrides auto-calc)">
          {[["Tasks per CB/Week","tasksPerCB"],["Total Hours","totalHours"],["Total Tasks Produced","totalProduced"],["Attempts per CB","attemptsPerCB"],["Reviews per CB","reviewsPerCB"],["Affected by SBQ","sbqAffected"],["Effective Production","effectiveProd"],["Total (Produced + SBQ)","totalWithSBQ"],["Effort to Full Prod (hrs)","effortHours"]].map(([label,field])=>(
            <div key={field} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:`1px solid ${C.border}`}}>
              <span style={{color:C.muted,fontSize:13}}>{label}</span>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{color:C.faint,fontSize:11}}>auto: {fmt(autoCalc[field],1)}</span>
                <InN value={getWP(field)} onChange={v=>updWP(field,v)} width="80px"/>
              </div>
            </div>
          ))}
          <button onClick={()=>setRampData(p=>p.map((x,i)=>i===active?{...x,weeklyProduction:{}}:x))} style={{...btnSm,marginTop:10,fontSize:12}}>↺ Reset to Auto-Calc</button>
        </Card>
      </div>

      <Card title="Weekly Schedule" extra={<span style={{color:C.muted,fontSize:13}}>Total: <strong style={{color:totalTargets===s.totalTasks?C.green:C.yellow}}>{fmt(totalTargets)} / {fmt(s.totalTasks)}</strong></span>}>
        <div style={{overflowX:"auto"}}>
          <table style={{borderCollapse:"collapse",width:"100%"}}>
            <thead><tr style={{background:"#f8fafc"}}>
              {s.weeks.map(w=><th key={w} style={{padding:"8px 12px",color:C.muted,fontSize:11,fontWeight:700,borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap"}}>{w}</th>)}
              <th style={{padding:"8px 12px",color:C.muted,fontSize:11,fontWeight:700,borderBottom:`1px solid ${C.border}`}}>TOTAL</th>
            </tr></thead>
            <tbody><tr>
              {s.taskTargets.map((t,wi)=>(
                <td key={wi} style={{padding:"10px 12px",textAlign:"center",borderBottom:`1px solid ${C.border}`}}>
                  <InN value={t} onChange={v=>updTarget(wi,v)} width="65px"/>
                </td>
              ))}
              <td style={{padding:"10px 12px",textAlign:"center",fontFamily:"'DM Mono',monospace",fontWeight:800,color:totalTargets===s.totalTasks?C.green:C.yellow}}>{fmt(totalTargets)}</td>
            </tr></tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ─── FINANCIALS ──────────────────────────────────────────────────────────────
function FinancialsTab({experts,reviewers,opsTeam,timeLogs,financials,setFinancials,phaseFinancials,setPhaseFinancials,taskTracker}){
  const [activePhase,setActivePhase]=useState("p0_unified");
  const updF=(f,v)=>setFinancials(p=>({...p,[f]:+v||0}));
  const updPF=(ph,f,v)=>setPhaseFinancials(p=>({...p,[ph]:{...(p[ph]||{}),[f]:+v||0}}));
  const pf=phaseFinancials[activePhase]||{};
  const phase=PHASES.find(p=>p.id===activePhase);
  const regionRates=financials.regionRates||{US:30,EU:22,LATAM:12,APAC:10,Other:15};
  const updRegion=(r,v)=>setFinancials(p=>({...p,regionRates:{...(p.regionRates||{}),[r]:+v||0}}));
  const opsMetrics=opsMetricsById(opsTeam,timeLogs||[],new Date());
  const opsTotals=opsTeam.reduce((acc,o)=>{
    const m=opsMetrics[o.id]||{};
    acc.approvedWeekHours+=(m.approvedWeekHours||0);
    acc.pendingWeekHours+=(m.pendingWeekHours||0);
    acc.approvedWeekPay+=(m.approvedWeekPay||0);
    acc.pendingWeekPay+=(m.pendingWeekPay||0);
    acc.totalApprovedPay+=(m.totalApprovedPay||0);
    return acc;
  },{approvedWeekHours:0,pendingWeekHours:0,approvedWeekPay:0,pendingWeekPay:0,totalApprovedPay:0});
  const totalRev=PHASES.reduce((s,p)=>s+(phaseFinancials[p.id]?.revenue||p.revenue),0);
  const totalCosts=experts.reduce((s,e)=>s+e.tasksCompleted*e.perTaskRate+e.bonusEarned,0)+reviewers.reduce((s,r)=>s+r.tasksReviewed*r.perTaskRate+r.bonusEarned,0)+(opsTotals.totalApprovedPay||0)+(financials.infrastructureCost||0)+(financials.otherOverhead||0);
  const margin=totalRev>0?(totalRev-totalCosts)/totalRev*100:0;
  const weeksTracked=taskTracker.length;
  const totalDoneAcrossTracker=taskTracker.reduce((s,w)=>s+w.newAnnotators*w.tasksPerWeekAnnotator,0);
  const costPerTask=totalDoneAcrossTracker>0?totalCosts/totalDoneAcrossTracker:0;
  const phaseRev=pf.revenue||phase?.revenue||0;
  const phaseTaskTarget=pf.taskCount||phase?.tasks||0;
  const forecastTotalCost=phaseTaskTarget>0&&costPerTask>0?costPerTask*phaseTaskTarget:null;
  const forecastMargin=forecastTotalCost&&phaseRev>0?((phaseRev-forecastTotalCost)/phaseRev*100):null;
  const avgTasksPerWeek=weeksTracked>0?totalDoneAcrossTracker/weeksTracked:0;
  const weeksToComplete=avgTasksPerWeek>0&&phaseTaskTarget>0?Math.ceil(phaseTaskTarget/avgTasksPerWeek):null;
  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14}}>
        <KPI label="Total Revenue" value={totalRev>0?fmtU(totalRev):"—"} color={C.blue} icon="💰"/>
        <KPI label="Total Costs" value={totalCosts>0?fmtU(totalCosts):"—"} color={C.orange} icon="💸"/>
        <KPI label="Gross Margin" value={totalRev>0?fmtP(margin):"—"} color={margin>=(financials.targetMargin||35)?C.green:C.red} icon="📊" delta={totalRev>0?margin-(financials.targetMargin||35):null}/>
        <KPI label="Net Profit" value={totalRev>0?fmtU(totalRev-totalCosts):"—"} color={(totalRev-totalCosts)>=0?C.green:C.red} icon="✨"/>
      </div>
      <div style={{display:"flex",justifyContent:"flex-end"}}>
        <ExBtn onClick={()=>{
          dlXLSX([{name:"Phase Summary",data:PHASES.map(p=>{const pf2=phaseFinancials[p.id]||{};const pc=["expertCost","reviewerCost","opsCost","infraCost","otherCost"].reduce((s,f)=>s+(pf2[f]||0),0);const pr=pf2.revenue||p.revenue;return{Phase:p.name,"Tasks":p.tasks,"Wks":p.weeks,"Revenue $":pr,"Budget $":pf2.budget||0,"Expert $":pf2.expertCost||0,"Reviewer $":pf2.reviewerCost||0,"Ops $":pf2.opsCost||0,"Infra $":pf2.infraCost||0,"Other $":pf2.otherCost||0,"Total Cost $":pc,"Margin %":pr>0?((pr-pc)/pr*100).toFixed(1):"—"};})},{name:"Regional Rates",data:["US","EU","LATAM","APAC","Other"].map(r=>({Region:r,"$/task":regionRates[r]||0,Experts:experts.filter(e=>e.region===r).length,Reviewers:reviewers.filter(x=>x.region===r).length,Ops:opsTeam.filter(x=>x.region===r).length}))},{name:"Ops Pay",data:opsTeam.map(o=>{const m=opsMetrics[o.id]||{};return{Name:o.name,Role:o.role,"$/h":o.hourlyRate||0,"Approved Hrs/Wk":+(m.approvedWeekHours||0).toFixed(2),"Pending Hrs/Wk":+(m.pendingWeekHours||0).toFixed(2),"Approved Pay/Wk $":+(m.approvedWeekPay||0).toFixed(2),"Pending Pay/Wk $":+(m.pendingWeekPay||0).toFixed(2),"Total Approved Pay $":+(m.totalApprovedPay||0).toFixed(2)};})}],"NES_Financials");
        }} label="⬇ Export Financials"/>
      </div>
      <Card title="Phase-by-Phase Financials">
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:20}}>
          {PHASES.map(p=>(
            <button key={p.id} onClick={()=>setActivePhase(p.id)} style={{...btnSm,background:activePhase===p.id?(p.color||C.blue):C.surface,color:activePhase===p.id?"#fff":C.text,border:activePhase===p.id?"none":`1px solid ${C.border}`}}>{p.name}</button>
          ))}
        </div>
        {forecastTotalCost!=null&&(
          <div style={{background:forecastMargin>=(financials.targetMargin||35)?C.greenSoft:C.redSoft,border:`1px solid ${forecastMargin>=(financials.targetMargin||35)?C.green:C.red}30`,borderRadius:8,padding:"12px 16px",marginBottom:20,display:"flex",gap:16,flexWrap:"wrap",alignItems:"center"}}>
            <span style={{fontSize:20}}>{forecastMargin>=(financials.targetMargin||35)?"✅":"⚠️"}</span>
            <div>
              <div style={{fontWeight:800,color:forecastMargin>=(financials.targetMargin||35)?C.greenText:C.redText,fontSize:14}}>Forecast to Completion — {phase?.name}</div>
              <div style={{color:C.muted,fontSize:13,marginTop:3}}>
                Projected cost: <strong>{fmtU(Math.round(forecastTotalCost))}</strong> · Margin: <strong style={{color:forecastMargin>=(financials.targetMargin||35)?C.green:C.red}}>{fmtP(forecastMargin||0)}</strong> · Est. weeks: <strong>{weeksToComplete??"—"}</strong>
                {forecastMargin<(financials.targetMargin||35)&&<span style={{color:C.red}}> · Margin at risk</span>}
              </div>
            </div>
          </div>
        )}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
          <div>
            <div style={{color:C.muted,fontSize:11,fontWeight:700,marginBottom:12,textTransform:"uppercase"}}>Revenue & Budget</div>
            {[["Revenue from Client","revenue",true],["Budget Allocated","budget",true],["Task Count","taskCount",false],["Duration (weeks)","durationWeeks",false]].map(([label,field,isMoney])=>{
              const def=field==="revenue"?phase?.revenue:field==="taskCount"?phase?.tasks:field==="durationWeeks"?phase?.weeks:0;
              return(
                <div key={field} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:`1px solid ${C.border}`}}>
                  <span style={{color:C.muted,fontSize:13}}>{label}</span>
                  <InN value={pf[field]??def??0} onChange={v=>updPF(activePhase,field,v)} prefix={isMoney?"$":""} width="100px"/>
                </div>
              );
            })}
          </div>
          <div>
            <div style={{color:C.muted,fontSize:11,fontWeight:700,marginBottom:12,textTransform:"uppercase"}}>Cost Tracking</div>
            {[["Expert Task Cost","expertCost"],["Reviewer Task Cost","reviewerCost"],["Ops Overhead","opsCost"],["Infrastructure","infraCost"],["Other","otherCost"]].map(([label,field])=>(
              <div key={field} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:`1px solid ${C.border}`}}>
                <span style={{color:C.muted,fontSize:13}}>{label}</span>
                <InN value={pf[field]||0} onChange={v=>updPF(activePhase,field,v)} prefix="$" width="100px"/>
              </div>
            ))}
            {(()=>{const pc=["expertCost","reviewerCost","opsCost","infraCost","otherCost"].reduce((s,f)=>s+(pf[f]||0),0);const pr=pf.revenue||phase?.revenue||0;const pm=pr>0?(pr-pc)/pr*100:0;return(<>
              <div style={{display:"flex",justifyContent:"space-between",padding:"12px 0"}}><span style={{fontWeight:800}}>Phase Total Cost</span><span style={{fontFamily:"'DM Mono',monospace",fontWeight:800,color:C.red}}>{fmtU(pc)}</span></div>
              <div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontWeight:800}}>Phase Margin</span><span style={{fontFamily:"'DM Mono',monospace",fontWeight:800,color:pm>=(financials.targetMargin||35)?C.green:C.red}}>{fmtP(pm)}</span></div>
            </>);})()} 
          </div>
        </div>
      </Card>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
        <Card title="Global Settings">
          {[["Infrastructure Cost ($)","infrastructureCost"],["Other Overhead ($)","otherOverhead"],["Target Margin %","targetMargin"],["Quality Threshold %","qualityThreshold"]].map(([label,field])=>(
            <div key={field} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:`1px solid ${C.border}`}}>
              <span style={{color:C.muted,fontSize:13}}>{label}</span>
              <InN value={financials[field]||0} onChange={v=>updF(field,v)} width="90px"/>
            </div>
          ))}
        </Card>
        <Card title="Regional Tiered Rates">
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <TH cols={["Region","$/task","Experts","Reviewers","Ops"]}/>
            <tbody>
              {["US","EU","LATAM","APAC","Other"].map(r=>(
                <tr key={r} style={{borderTop:`1px solid ${C.border}`}}>
                  <td style={{padding:"10px 14px",fontWeight:700}}>{r}</td>
                  <td style={{padding:"10px 14px"}}><InN value={regionRates[r]||0} onChange={v=>updRegion(r,v)} prefix="$" width="70px"/></td>
                  <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace"}}>{experts.filter(e=>e.region===r).length}</td>
                  <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace"}}>{reviewers.filter(x=>x.region===r).length}</td>
                  <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace"}}>{opsTeam.filter(x=>x.region===r).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      {/* Ops Pay Summary */}
      <Card title="Ops Team Pay Summary">
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <TH cols={["#","Name","Role","Approved Hrs/Wk","Pending Hrs/Wk","Hourly Rate","Approved Pay/Wk","Pending Pay/Wk","Total Approved Pay"]}/>
          <tbody>
            {opsTeam.length===0&&<tr><td colSpan={9} style={{padding:30,textAlign:"center",color:C.faint}}>Add ops members to see pay summary.</td></tr>}
            {opsTeam.map((o,i)=>{
              const m=opsMetrics[o.id]||{};
              return(
                <tr key={o.id} style={{borderTop:`1px solid ${C.border}`,background:i%2?"#fafafa":C.surface}}>
                  <td style={{padding:"10px 14px",color:C.faint,fontFamily:"'DM Mono',monospace",fontSize:12,width:40}}>{i+1}</td>
                  <td style={{padding:"10px 14px",fontWeight:700}}>{o.name}</td>
                  <td style={{padding:"10px 14px",color:C.muted,fontSize:13}}>{o.role}</td>
                  <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace"}}>{(m.approvedWeekHours||0).toFixed(1)}h</td>
                  <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",color:C.yellowText}}>{(m.pendingWeekHours||0).toFixed(1)}h</td>
                  <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace"}}>{o.hourlyRate>0?fmtU(o.hourlyRate)+"/h":"—"}</td>
                  <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",color:C.blue,fontWeight:700}}>{fmtU(m.approvedWeekPay||0)}</td>
                  <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",color:C.yellowText}}>{fmtU(m.pendingWeekPay||0)}</td>
                  <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",color:C.orange}}>{fmtU(m.totalApprovedPay||0)}</td>
                </tr>
              );
            })}
            {opsTeam.length>0&&<tr style={{borderTop:`2px solid ${C.border}`,background:"#f8fafc"}}>
              <td colSpan={6} style={{padding:"10px 14px",fontWeight:800,textAlign:"right"}}>Totals:</td>
              <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",fontWeight:800,color:C.blue}}>{fmtU(opsTotals.approvedWeekPay||0)}</td>
              <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",fontWeight:800,color:C.yellowText}}>{fmtU(opsTotals.pendingWeekPay||0)}</td>
              <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",fontWeight:800,color:C.orange}}>{fmtU(opsTotals.totalApprovedPay||0)}</td>
            </tr>}
          </tbody>
        </table>
      </Card>
      {financials.bonusTiers&&(
        <Card title="Bonus Structure">
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16}}>
            {financials.bonusTiers.map((tier,i)=>{
              const tc=[C.orange,C.muted,C.yellow][i];
              const q=experts.filter(e=>e.tasksCompleted>=tier.minTasks&&e.qualityScore>=tier.minQuality).length;
              return(
                <div key={tier.name} style={{background:tc+"10",border:`1px solid ${tc}30`,borderRadius:10,padding:18}}>
                  <div style={{color:tc,fontWeight:800,fontSize:16,marginBottom:12}}>{tier.name}</div>
                  {[["Min Tasks","minTasks"],["Min Quality %","minQuality"],["Bonus ($)","bonusAmt"]].map(([l,f])=>(
                    <div key={f} style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                      <span style={{color:C.muted,fontSize:12}}>{l}</span>
                      <InN value={tier[f]} onChange={v=>setFinancials(p=>{const t=[...p.bonusTiers];t[i]={...t[i],[f]:v};return{...p,bonusTiers:t};})} width="70px"/>
                    </div>
                  ))}
                  <div style={{marginTop:10,padding:10,background:tc+"20",borderRadius:8,textAlign:"center"}}>
                    <div style={{color:tc,fontWeight:800,fontSize:20}}>{q}</div>
                    <div style={{color:C.muted,fontSize:11}}>qualify → {fmtU(q*tier.bonusAmt)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
function DashboardTab({experts,reviewers,opsTeam,tickets,financials}){
  const threshold=financials.qualityThreshold||90;
  const weeklyAttempts=experts.reduce((s,e)=>s+(e.tasksCompleted-(e.lastWeekCompleted||0)),0);
  const weeklyReviews=reviewers.reduce((s,r)=>s+(r.tasksReviewed-(r.lastWeekCompleted||0)),0);
  const avgQ=[...experts,...reviewers].filter(x=>x.qualityScore>0);
  const avgQuality=avgQ.length?avgQ.reduce((s,x)=>s+x.qualityScore,0)/avgQ.length:0;
  const byStatus=TICKET_STATUSES.map(s=>({name:s,count:tickets.filter(t=>t.status===s).length}));
  const overdue=tickets.filter(t=>t.deadline&&new Date(t.deadline)<new Date()&&t.status!=="COMPLETED");
  const highPri=tickets.filter(t=>t.priority==="High"&&t.status!=="COMPLETED");
  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14}}>
        <KPI label="Active Experts" value={experts.filter(e=>e.status==="active").length} sub={`${experts.length} total`} color={C.blue} icon="👥"/>
        <KPI label="Active Reviewers" value={reviewers.filter(r=>r.status==="active").length} sub={`${reviewers.length} total`} color={C.purple} icon="🔍"/>
        <KPI label="Weekly Output" value={fmt(weeklyAttempts+weeklyReviews)} sub="attempts + reviews delta" color={C.green} icon="📈"/>
        <KPI label="Avg Quality" value={avgQuality>0?fmtP(avgQuality):"—"} color={avgQuality>=threshold?C.green:avgQuality>0?C.red:C.faint} icon="⭐"/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14}}>
        <KPI label="Total Completed" value={fmt(experts.reduce((s,e)=>s+e.tasksCompleted,0))} color={C.muted} icon="📊"/>
        <KPI label="Total Reviewed" value={fmt(reviewers.reduce((s,r)=>s+r.tasksReviewed,0))} color={C.purple} icon="📋"/>
        <KPI label="High Priority Tickets" value={highPri.length} color={highPri.length>0?C.red:C.green} icon="🚨"/>
        <KPI label="Overdue Tickets" value={overdue.length} color={overdue.length>0?C.red:C.green} icon="⏰"/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
        <Card title="Ticket Pipeline">
          {byStatus.map(({name,count})=>(
            <div key={name} style={{marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                <span style={{color:STATUS_COLORS[name],fontSize:11,fontWeight:700}}>{name}</span>
                <span style={{fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:13}}>{count}</span>
              </div>
              <div style={{background:C.border,borderRadius:4,height:7}}><div style={{background:STATUS_COLORS[name],height:7,borderRadius:4,width:tickets.length?`${count/tickets.length*100}%`:"0%",transition:"width 0.4s"}}/></div>
            </div>
          ))}
        </Card>
        <Card title="Team Composition">
          {[["Experts",experts.filter(e=>e.status==="active").length,experts.length,C.blue],["Reviewers",reviewers.filter(r=>r.status==="active").length,reviewers.length,C.purple],["Ops Team",opsTeam.filter(o=>o.status==="active").length,opsTeam.length,C.orange]].map(([label,active,total,color])=>(
            <div key={label} style={{marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{color,fontSize:12,fontWeight:700}}>{label}</span>
                <span style={{fontFamily:"'DM Mono',monospace",fontSize:13}}>{active}/{total} active</span>
              </div>
              <div style={{background:C.border,borderRadius:4,height:8}}><div style={{background:color,height:8,borderRadius:4,width:total?`${active/total*100}%`:"0%",transition:"width 0.4s"}}/></div>
            </div>
          ))}
          <div style={{marginTop:16,paddingTop:14,borderTop:`1px solid ${C.border}`,display:"flex",gap:20}}>
            <div><div style={{fontFamily:"'DM Mono',monospace",fontWeight:800,fontSize:22,color:C.blue}}>{weeklyAttempts}</div><div style={{color:C.muted,fontSize:12}}>Attempts This Week</div></div>
            <div><div style={{fontFamily:"'DM Mono',monospace",fontWeight:800,fontSize:22,color:C.purple}}>{weeklyReviews}</div><div style={{color:C.muted,fontSize:12}}>Reviews This Week</div></div>
          </div>
        </Card>
      </div>
      {overdue.length>0&&(
        <Card title="⏰ Overdue Tickets">
          {overdue.slice(0,5).map(t=>(
            <div key={t.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 16px",background:C.redSoft,borderRadius:8,marginBottom:8}}>
              <span style={{fontFamily:"'DM Mono',monospace",fontSize:12,color:C.muted}}>{t.id}</span>
              <span style={{fontWeight:700,flex:1,margin:"0 12px"}}>{t.title}</span>
              <div style={{display:"flex",gap:8}}><Bdg color={PRIORITY_COLORS[t.priority]}>{t.priority}</Bdg><span style={{color:C.red,fontSize:12}}>Due: {t.deadline}</span></div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// ─── VISUALIZATIONS ──────────────────────────────────────────────────────────
function VisualizationsTab({experts,reviewers,tickets,financials,taskTracker}){
  const ticketData=TICKET_STATUSES.map(s=>({name:s.split("/")[0],value:tickets.filter(t=>t.status===s).length,color:STATUS_COLORS[s]}));
  const qualityData=[...experts,...reviewers].filter(x=>x.qualityScore>0).map(x=>({name:x.name.split(" ")[0],quality:x.qualityScore,type:experts.includes(x)?"Expert":"Reviewer"}));
  const regionData=["US","EU","LATAM","APAC","Other"].map(r=>({region:r,experts:experts.filter(e=>e.region===r).length,reviewers:reviewers.filter(x=>x.region===r).length})).filter(x=>x.experts+x.reviewers>0);
  const priorityData=["High","Medium","Low"].map(p=>({priority:p,open:tickets.filter(t=>t.priority===p&&t.status!=="COMPLETED").length,done:tickets.filter(t=>t.priority===p&&t.status==="COMPLETED").length}));
  const typeData=["expert","ops","review","documentation","training","miscellaneous"].map(t=>({type:t,count:tickets.filter(tk=>tk.type===t).length})).filter(x=>x.count>0);
  const statusCounts=PERSON_STATUSES.map(s=>({status:s,experts:experts.filter(e=>e.status===s).length,reviewers:reviewers.filter(r=>r.status===s).length})).filter(x=>x.experts+x.reviewers>0);
  const weeklyTrend=taskTracker.map(w=>({week:w.label,attempts:w.newAnnotators*w.tasksPerWeekAnnotator,reviews:w.newReviewers*w.tasksPerWeekReviewer}));
  const ahtData=[...experts,...reviewers].filter(x=>x.avgSpeed>0).map(x=>({name:x.name.split(" ")[0],aht:x.avgSpeed,quality:x.qualityScore,type:experts.includes(x)?"Expert":"Reviewer"}));

  const chart={background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:22};
  const ct={color:C.muted,fontSize:11,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",marginBottom:16};
  const empty=(msg="Add data to see this chart")=><div style={{color:C.faint,textAlign:"center",padding:40,fontSize:14}}>{msg}</div>;
  const COLORS=[C.blue,C.purple,C.cyan,C.orange,C.green,C.teal,C.red,C.yellow];

  const exportPPTX=()=>{
    const pptx=new PptxGenJS();pptx.layout="LAYOUT_WIDE";
    const dateStr=new Date().toLocaleDateString();const NAVY="1e3a5f";
    const addSlide=(title,tableHead,tableRows)=>{
      const slide=pptx.addSlide();slide.background={color:"f0f4f8"};
      slide.addText("GitHub NES Ops Center",{x:0.4,y:0.15,w:9,h:0.35,fontSize:11,color:"64748b",fontFace:"Arial"});
      slide.addText(title,{x:0.4,y:0.5,w:12,h:0.55,fontSize:24,bold:true,color:NAVY,fontFace:"Arial"});
      slide.addText(`Exported ${dateStr}`,{x:0.4,y:1.05,w:9,h:0.28,fontSize:10,color:"94a3b8",fontFace:"Arial"});
      const rows=[tableHead.map(h=>({text:h,options:{bold:true,color:"ffffff",fill:NAVY,fontSize:11}})),...tableRows.map(row=>row.map(cell=>({text:String(cell??"—"),options:{fontSize:11,color:"0f172a"}})))];
      slide.addTable(rows,{x:0.4,y:1.4,w:12.2,colW:Array(tableHead.length).fill(12.2/tableHead.length),border:{type:"solid",color:"e2e8f0",pt:0.5},fill:"ffffff",rowH:0.35});
    };
    const title=pptx.addSlide();title.background={color:NAVY};
    title.addText("GitHub NES Ops Center",{x:1,y:2.2,w:11,h:0.8,fontSize:36,bold:true,color:"f1f5f9",align:"center",fontFace:"Arial"});
    title.addText("Visualizations Export",{x:1,y:3.1,w:11,h:0.5,fontSize:20,color:"94a3b8",align:"center",fontFace:"Arial"});
    title.addText(dateStr,{x:1,y:3.7,w:11,h:0.35,fontSize:13,color:"60a5fa",align:"center",fontFace:"Arial"});
    addSlide("Ticket Status",["Status","Count"],ticketData.map(d=>[d.name,d.value]));
    addSlide("Ticket Priority",["Priority","Open","Done"],priorityData.map(d=>[d.priority,d.open,d.done]));
    addSlide("Quality Scores",["Name","Type","Quality %"],qualityData.map(d=>[d.name,d.type,`${d.quality}%`]));
    addSlide("Team by Region",["Region","Experts","Reviewers"],regionData.map(d=>[d.region,d.experts,d.reviewers]));
    addSlide("Ticket Types",["Type","Count"],typeData.map(d=>[d.type,d.count]));
    addSlide("Contributor Status",["Status","Experts","Reviewers"],statusCounts.map(d=>[d.status,d.experts,d.reviewers]));
    pptx.writeFile({fileName:`NES_Visualizations_${today()}.pptx`});
  };

  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
        <ExBtn onClick={()=>dlXLSX([{name:"Ticket Status",data:ticketData.map(d=>({Status:d.name,Count:d.value}))},{name:"Ticket Priority",data:priorityData.map(d=>({Priority:d.priority,Open:d.open,Done:d.done}))},{name:"Ticket Types",data:typeData.map(d=>({Type:d.type,Count:d.count}))},{name:"Quality Scores",data:qualityData.map(d=>({Name:d.name,Type:d.type,"Quality %":d.quality}))},{name:"Team by Region",data:regionData},{name:"Weekly Trend",data:weeklyTrend},{name:"AHT Data",data:ahtData}],"NES_Visualizations")} label="⬇ Export as Excel"/>
        <ExBtn onClick={exportPPTX} label="⬇ Export as PowerPoint" color={C.orange}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
        <div style={chart}><div style={ct}>Ticket Status Distribution</div>{tickets.length===0?empty():<ResponsiveContainer width="100%" height={220}><PieChart><Pie data={ticketData.filter(d=>d.value>0)} cx="50%" cy="50%" outerRadius={80} dataKey="value" label={({name,value})=>`${name}(${value})`} labelLine={false}>{ticketData.map((e,i)=><Cell key={i} fill={e.color}/>)}</Pie><Tooltip/></PieChart></ResponsiveContainer>}</div>
        <div style={chart}><div style={ct}>Ticket Type Breakdown</div>{typeData.length===0?empty():<ResponsiveContainer width="100%" height={220}><PieChart><Pie data={typeData} cx="50%" cy="50%" outerRadius={80} dataKey="count" nameKey="type" label={({type,count})=>`${type}(${count})`} labelLine={false}>{typeData.map((e,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}</Pie><Tooltip/></PieChart></ResponsiveContainer>}</div>
        <div style={chart}><div style={ct}>Ticket Priority Breakdown</div>{tickets.length===0?empty():<ResponsiveContainer width="100%" height={220}><BarChart data={priorityData}><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="priority" tick={{fontSize:12}}/><YAxis tick={{fontSize:10}}/><Tooltip contentStyle={{borderRadius:8}}/><Legend/><Bar dataKey="open" name="Open" fill={C.red} radius={[4,4,0,0]}/><Bar dataKey="done" name="Done" fill={C.green} radius={[4,4,0,0]}/></BarChart></ResponsiveContainer>}</div>
        <div style={chart}><div style={ct}>Quality Scores (threshold line)</div>{qualityData.length===0?empty():<ResponsiveContainer width="100%" height={220}><BarChart data={qualityData}><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="name" tick={{fontSize:10}}/><YAxis domain={[80,100]} tick={{fontSize:10}}/><Tooltip contentStyle={{borderRadius:8}}/><ReferenceLine y={financials.qualityThreshold||90} stroke={C.red} strokeDasharray="4 4" label={{value:"threshold",fontSize:9,fill:C.red}}/><Bar dataKey="quality" name="Quality %" radius={[4,4,0,0]}>{qualityData.map((e,i)=><Cell key={i} fill={e.quality>=(financials.qualityThreshold||90)?C.green:C.red}/>)}</Bar></BarChart></ResponsiveContainer>}</div>
        <div style={chart}><div style={ct}>Team by Region</div>{regionData.length===0?empty():<ResponsiveContainer width="100%" height={220}><BarChart data={regionData}><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="region" tick={{fontSize:11}}/><YAxis tick={{fontSize:10}}/><Tooltip contentStyle={{borderRadius:8}}/><Legend/><Bar dataKey="experts" name="Experts" fill={C.blue} radius={[4,4,0,0]}/><Bar dataKey="reviewers" name="Reviewers" fill={C.purple} radius={[4,4,0,0]}/></BarChart></ResponsiveContainer>}</div>
        <div style={chart}><div style={ct}>Contributor Status Breakdown</div>{statusCounts.length===0?empty():<ResponsiveContainer width="100%" height={220}><BarChart data={statusCounts}><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="status" tick={{fontSize:10}}/><YAxis tick={{fontSize:10}}/><Tooltip contentStyle={{borderRadius:8}}/><Legend/><Bar dataKey="experts" name="Experts" fill={C.blue} radius={[4,4,0,0]}/><Bar dataKey="reviewers" name="Reviewers" fill={C.purple} radius={[4,4,0,0]}/></BarChart></ResponsiveContainer>}</div>
        <div style={chart}><div style={ct}>Weekly Annotation vs Review Trend</div>{weeklyTrend.length<2?empty("Add 2+ task weeks to see trend"):<ResponsiveContainer width="100%" height={220}><AreaChart data={weeklyTrend}><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="week" tick={{fontSize:11}}/><YAxis tick={{fontSize:10}}/><Tooltip contentStyle={{borderRadius:8}}/><Legend/><Area type="monotone" dataKey="attempts" name="Attempts" stroke={C.blue} fill={C.blueSoft} strokeWidth={2}/><Area type="monotone" dataKey="reviews" name="Reviews" stroke={C.purple} fill={C.purpleSoft} strokeWidth={2}/></AreaChart></ResponsiveContainer>}</div>
        <div style={chart}><div style={ct}>AHT Distribution (Speed vs Quality)</div>{ahtData.length<2?empty():<ResponsiveContainer width="100%" height={220}><ScatterChart><CartesianGrid strokeDasharray="3 3" stroke={C.border}/><XAxis dataKey="aht" name="AHT (h)" tick={{fontSize:10}} label={{value:"AHT (h)",position:"insideBottom",offset:-5,fontSize:10}}/><YAxis dataKey="quality" name="Quality %" domain={[80,100]} tick={{fontSize:10}}/><Tooltip cursor={{strokeDasharray:"3 3"}} contentStyle={{borderRadius:8}} formatter={(v,n)=>[v,n]}/><Scatter data={ahtData} name="Contributors">{ahtData.map((e,i)=><Cell key={i} fill={e.type==="Expert"?C.blue:C.purple}/>)}</Scatter></ScatterChart></ResponsiveContainer>}</div>
      </div>
    </div>
  );
}

// ─── RISK ────────────────────────────────────────────────────────────────────
function RiskTab({experts,reviewers,tickets,financials,opsTeam,timeLogs,taskTracker,rampData,phaseFinancials}){
  const threshold=financials.qualityThreshold||90;
  const targetMargin=financials.targetMargin||35;
  const all=[...experts,...reviewers];
  const active=all.filter(x=>x.status==="active");
  const withAHT=all.filter(x=>x.avgSpeed>0);
  const avgAHT=withAHT.length?withAHT.reduce((s,x)=>s+x.avgSpeed,0)/withAHT.length:0;
  const belowQ=active.filter(x=>x.qualityScore>0&&x.qualityScore<threshold);
  const noQData=active.filter(x=>x.qualityScore===0);
  const declining=active.filter(x=>{const h=x.qualityHistory||[];return h.length>=2&&h[h.length-1].score<h[h.length-2].score;});
  const slowCB=withAHT.filter(x=>x.avgSpeed>avgAHT*1.3);
  const fastCB=withAHT.filter(x=>x.avgSpeed<avgAHT*0.6);
  const overdue=tickets.filter(t=>t.deadline&&new Date(t.deadline)<new Date()&&t.status!=="COMPLETED");
  const backlog=tickets.filter(t=>t.status==="PENDING REVIEW");
  const rejected=tickets.filter(t=>t.status==="REJECTED/REWORK");
  const stale=tickets.filter(t=>t.createdAt&&daysSince(t.createdAt)>7&&t.status!=="COMPLETED"&&t.status!=="REJECTED/REWORK");
  const unownedHigh=tickets.filter(t=>t.priority==="High"&&!t.assignee&&t.status!=="COMPLETED");
  const inactiveRatio=experts.length>0?experts.filter(e=>e.status==="inactive"||e.status==="offboarded").length/experts.length:0;
  const zeroOutput=active.filter(x=>(isE=>isE?x.tasksCompleted-(x.lastWeekCompleted||0)===0:x.tasksReviewed-(x.lastWeekCompleted||0)===0)(experts.includes(x)));
  const annRevRatio=experts.filter(x=>x.status==="active").length/(reviewers.filter(x=>x.status==="active").length||1);
  const regionCount={};active.forEach(x=>{regionCount[x.region||"Other"]=(regionCount[x.region||"Other"]||0)+1;});
  const dominantRegion=Object.entries(regionCount).sort((a,b)=>b[1]-a[1])[0];
  const regionConc=dominantRegion&&active.length>0?dominantRegion[1]/active.length:0;
  const weeksTracked=taskTracker.length;
  const actualTotal=taskTracker.reduce((s,w)=>s+w.newAnnotators*w.tasksPerWeekAnnotator,0);
  const rampTarget=weeksTracked>0&&rampData[0]?rampData[0].taskTargets.slice(0,weeksTracked).reduce((s,v)=>s+(v||0),0):0;
  const velocityGap=rampTarget>0?(actualTotal-rampTarget)/rampTarget*100:null;
  const avgSBQ=taskTracker.length>0?taskTracker[taskTracker.length-1].sbqRate:null;
  const rampSBQ=rampData[0]?rampData[0].sbqDefault:null;
  const sbqDrift=avgSBQ&&rampSBQ?((avgSBQ-rampSBQ)/rampSBQ*100):null;
  const totalRev=PHASES.reduce((s,p)=>s+(phaseFinancials[p.id]?.revenue||p.revenue),0);
  const opsMetrics=opsMetricsById(opsTeam,timeLogs||[],new Date());
  const opsApprovedTotal=opsTeam.reduce((s,o)=>s+(opsMetrics[o.id]?.totalApprovedPay||0),0);
  const totalCosts=experts.reduce((s,e)=>s+e.tasksCompleted*e.perTaskRate+e.bonusEarned,0)+reviewers.reduce((s,r)=>s+r.tasksReviewed*r.perTaskRate+r.bonusEarned,0)+opsApprovedTotal+(financials.infrastructureCost||0)+(financials.otherOverhead||0);
  const margin=totalRev>0?(totalRev-totalCosts)/totalRev*100:null;
  const bonusPotential=(financials.bonusTiers||[]).reduce((s,tier)=>s+experts.filter(e=>e.tasksCompleted>=tier.minTasks&&e.qualityScore>=tier.minQuality).length*tier.bonusAmt,0);
  const toBeOffboarded=experts.filter(e=>e.status==="to-be-offboarded").length+reviewers.filter(r=>r.status==="to-be-offboarded").length;

  const risks=[
    {cat:"Quality",id:"q1",level:belowQ.length>3?"HIGH":belowQ.length>0?"MEDIUM":"LOW",title:"Contributors Below Quality Threshold",desc:`${belowQ.length} active contributor(s) below ${threshold}%`,detail:belowQ.map(x=>`${x.name}: ${x.qualityScore}%`).join(" · ")||"All above threshold ✓",action:belowQ.length>0?"Schedule 1:1 calibration sessions":null},
    {cat:"Quality",id:"q2",level:declining.length>2?"HIGH":declining.length>0?"MEDIUM":"LOW",title:"Declining Quality Trend",desc:`${declining.length} contributor(s) with downward trend`,detail:declining.map(x=>{const h=x.qualityHistory||[];return`${x.name}: ${h[h.length-2]?.score}%→${h[h.length-1]?.score}%`;}).join(" · ")||"No declining trends ✓",action:declining.length>0?"Intervene before scores fall below threshold":null},
    {cat:"Quality",id:"q3",level:noQData.length>active.length*0.3?"MEDIUM":"LOW",title:"Missing Quality Data",desc:`${noQData.length} active contributors without quality score`,detail:noQData.slice(0,5).map(x=>x.name).join(", ")||"All contributors have scores ✓",action:noQData.length>0?"Record quality scores for all active contributors":null},
    {cat:"AHT/Speed",id:"a1",level:slowCB.length>3?"HIGH":slowCB.length>0?"MEDIUM":"LOW",title:"High AHT — Slow Contributors",desc:`${slowCB.length} contributor(s) >130% of team avg AHT (${avgAHT.toFixed(2)}h)`,detail:slowCB.map(x=>`${x.name}: ${x.avgSpeed}h`).join(" · ")||"No slow outliers ✓",action:slowCB.length>0?"Review task assignment — may need retraining":null},
    {cat:"AHT/Speed",id:"a2",level:fastCB.length>2?"MEDIUM":"LOW",title:"Low AHT — Suspiciously Fast",desc:`${fastCB.length} contributor(s) <60% of team avg AHT`,detail:fastCB.map(x=>`${x.name}: ${x.avgSpeed}h`).join(" · ")||"No speed outliers ✓",action:fastCB.length>0?"Audit for quality — rushing often causes errors":null},
    {cat:"Workforce",id:"w1",level:annRevRatio>4?"HIGH":annRevRatio>3?"MEDIUM":"LOW",title:"Annotator:Reviewer Ratio Too High",desc:`${annRevRatio.toFixed(1)}:1 (target ≤4:1)`,detail:annRevRatio>4?"Review queue will grow faster than it can clear":"Ratio within range ✓",action:annRevRatio>4?"Add reviewers urgently — promote annotators if needed":null},
    {cat:"Workforce",id:"w2",level:inactiveRatio>0.2?"HIGH":inactiveRatio>0.1?"MEDIUM":"LOW",title:"High Inactivity/Offboarding Rate",desc:`${Math.round(inactiveRatio*100)}% of experts inactive or offboarded`,detail:`${experts.filter(e=>e.status==="inactive").length} inactive, ${experts.filter(e=>e.status==="offboarded").length} offboarded`,action:inactiveRatio>0.1?"Review pipeline — recruit replacements":null},
    {cat:"Workforce",id:"w3",level:toBeOffboarded>5?"MEDIUM":"LOW",title:"Pending Offboardings",desc:`${toBeOffboarded} contributor(s) marked 'to-be-offboarded'`,detail:toBeOffboarded>0?"Ensure knowledge transfer and replacement hiring":"No pending offboardings ✓",action:toBeOffboarded>0?"Initiate offboarding checklist for each pending case":null},
    {cat:"Workforce",id:"w4",level:zeroOutput.length>active.length*0.3?"HIGH":zeroOutput.length>active.length*0.15?"MEDIUM":"LOW",title:"Zero-Output Active Contributors",desc:`${zeroOutput.length} active contributor(s) with 0 output this week`,detail:zeroOutput.slice(0,5).map(x=>x.name).join(", ")||"All contributing ✓",action:zeroOutput.length>0?"Check for platform issues or communication gaps":null},
    {cat:"Workforce",id:"w5",level:regionConc>0.7?"HIGH":regionConc>0.5?"MEDIUM":"LOW",title:"Regional Concentration Risk",desc:dominantRegion?`${Math.round(regionConc*100)}% in ${dominantRegion[0]}`:"No data",detail:regionConc>0.5?"Over-reliance on one region":"Distribution healthy ✓",action:regionConc>0.5?"Diversify hiring across regions":null},
    {cat:"Tickets",id:"t1",level:overdue.length>5?"HIGH":overdue.length>0?"MEDIUM":"LOW",title:"Overdue Tickets",desc:`${overdue.length} ticket(s) past deadline`,detail:overdue.slice(0,3).map(t=>`${t.id}: ${t.title}`).join(" · ")||"No overdue ✓",action:overdue.length>0?"Reassign or escalate immediately":null},
    {cat:"Tickets",id:"t2",level:stale.length>5?"HIGH":stale.length>2?"MEDIUM":"LOW",title:"Stale Tickets (>7 days)",desc:`${stale.length} open for >7 days`,detail:stale.slice(0,3).map(t=>`${t.id}—${daysSince(t.createdAt)}d`).join(" · ")||"No stale tickets ✓",action:stale.length>0?"Close, reassign, or escalate":null},
    {cat:"Tickets",id:"t3",level:unownedHigh.length>0?"HIGH":"LOW",title:"Unassigned High-Priority Tickets",desc:`${unownedHigh.length} HIGH tickets with no assignee`,detail:unownedHigh.map(t=>t.title).join(" · ")||"All high-priority assigned ✓",action:unownedHigh.length>0?"Assign owners immediately":null},
    {cat:"Tickets",id:"t4",level:backlog.length>10?"HIGH":backlog.length>4?"MEDIUM":"LOW",title:"Review Bottleneck",desc:`${backlog.length} in Pending Review`,detail:backlog.length>4?"Queue growing — delays sign-off":"Manageable ✓",action:backlog.length>4?"Run a dedicated review sprint":null},
    {cat:"Tickets",id:"t5",level:rejected.length>5?"HIGH":rejected.length>2?"MEDIUM":"LOW",title:"High Rejection/Rework Rate",desc:`${rejected.length} rejected/rework`,detail:rejected.length>2?"Systemic quality issue suspected":"Normal ✓",action:rejected.length>2?"Hold calibration session — identify root assignees":null},
    {cat:"Velocity",id:"v1",level:velocityGap!=null&&velocityGap<-15?"HIGH":velocityGap!=null&&velocityGap<-5?"MEDIUM":"LOW",title:"Velocity Behind Ramp Plan",desc:velocityGap!=null?`${velocityGap.toFixed(1)}% vs plan through week ${weeksTracked}`:"No velocity data",detail:velocityGap!=null&&velocityGap<-5?"Phase deadline at risk":"On track ✓",action:velocityGap!=null&&velocityGap<-5?"Increase annotator count or hours":null},
    {cat:"Velocity",id:"v2",level:sbqDrift!=null&&sbqDrift>15?"HIGH":sbqDrift!=null&&sbqDrift>8?"MEDIUM":"LOW",title:"SBQ Rate Higher Than Planned",desc:sbqDrift!=null?`Actual ${((avgSBQ||0)*100).toFixed(1)}% vs plan ${((rampSBQ||0)*100).toFixed(1)}%`:"No data",detail:sbqDrift!=null&&sbqDrift>8?"Fewer effective tasks than planned":"Within range ✓",action:sbqDrift!=null&&sbqDrift>8?"Review guideline clarity and calibration":null},
    {cat:"Financial",id:"f1",level:margin!=null&&margin<targetMargin-10?"HIGH":margin!=null&&margin<targetMargin?"MEDIUM":"LOW",title:"Margin Below Target",desc:margin!=null?`${fmtP(margin)} vs target ${fmtP(targetMargin)}`:"No data",detail:margin!=null&&margin<targetMargin?"Review cost allocation":"On track ✓",action:margin!=null&&margin<targetMargin?"Audit per-task rates and overhead":null},
    {cat:"Financial",id:"f2",level:bonusPotential>50000?"MEDIUM":"LOW",title:"Large Bonus Payout Exposure",desc:`~${fmtU(bonusPotential)} in bonus payouts may be due`,detail:bonusPotential>0?`Based on current qualification counts`:"No significant exposure",action:bonusPotential>50000?"Ensure budgeted in phase allocation":null},
  ];

  const cats=[...new Set(risks.map(r=>r.cat))];
  const [selCat,setSelCat]=useState("All");
  const filtered=selCat==="All"?risks:risks.filter(r=>r.cat===selCat);
  const rc={HIGH:C.red,MEDIUM:C.yellow,LOW:C.green};
  const rb={HIGH:C.redSoft,MEDIUM:C.yellowSoft,LOW:C.greenSoft};

  return(
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14}}>
        <KPI label="HIGH Risks" value={risks.filter(r=>r.level==="HIGH").length} color={C.red} icon="🔴" sub="Immediate action needed"/>
        <KPI label="MEDIUM Risks" value={risks.filter(r=>r.level==="MEDIUM").length} color={C.yellow} icon="🟡" sub="Monitor closely"/>
        <KPI label="LOW / Clear" value={risks.filter(r=>r.level==="LOW").length} color={C.green} icon="🟢" sub="No action needed"/>
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {["All",...cats].map(c=>{
          const catHigh=c==="All"?risks.filter(r=>r.level==="HIGH").length:risks.filter(r=>r.cat===c&&r.level==="HIGH").length;
          return(
            <button key={c} onClick={()=>setSelCat(c)} style={{...btnSm,background:selCat===c?C.navy:C.surface,color:selCat===c?"#fff":C.text,border:selCat===c?"none":`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:6}}>
              {c}
              {catHigh>0&&<span style={{background:C.red,color:"#fff",borderRadius:10,padding:"1px 6px",fontSize:10,fontWeight:800}}>{catHigh}</span>}
            </button>
          );
        })}
      </div>
      {filtered.map(risk=>(
        <div key={risk.id} style={{background:rb[risk.level],border:`1px solid ${rc[risk.level]}30`,borderLeft:`4px solid ${rc[risk.level]}`,borderRadius:10,padding:20}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,flexWrap:"wrap",gap:8}}>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <Bdg color={rc[risk.level]}>{risk.level}</Bdg>
              <Bdg color={C.muted}>{risk.cat}</Bdg>
              <span style={{fontWeight:800,fontSize:15}}>{risk.title}</span>
            </div>
          </div>
          <div style={{color:C.muted,fontSize:13,marginBottom:6}}>{risk.desc}</div>
          <div style={{color:C.muted,fontSize:12,background:"#fff8",padding:"8px 12px",borderRadius:8,marginBottom:risk.action&&risk.level!=="LOW"?8:0}}>{risk.detail}</div>
          {risk.action&&risk.level!=="LOW"&&<div style={{color:rc[risk.level],fontSize:12,fontWeight:600}}>💡 {risk.action}</div>}
        </div>
      ))}
    </div>
  );
}

// ─── ACCESS ──────────────────────────────────────────────────────────────────
function AccessTab({accessUsers,setAccessUsers}){
  const [modal,setModal]=useState(false); const [editUser,setEditUser]=useState(null); const [showPins,setShowPins]=useState(false);
  const blank=()=>({name:"",email:"",role:"viewer",pin:"",tabs:{Dashboard:true,Standup:true,Experts:true,Reviewers:true,"Ops Team":false,Tickets:true,Tasks:true,Velocity:false,"Quality Control":false,"Ramp Plan":false,Visualizations:true,Risk:true}});
  const [form,setForm]=useState(blank());
  const presets={
    "View Only":{Dashboard:true,Standup:true,Experts:false,Reviewers:false,"Ops Team":false,Tickets:false,Tasks:false,Velocity:false,"Quality Control":false,"Ramp Plan":false,Visualizations:true,Risk:false},
    "Ops Member":{Dashboard:true,Standup:true,Experts:true,Reviewers:true,"Ops Team":true,Tickets:true,Tasks:true,Velocity:true,"Quality Control":true,"Ramp Plan":false,Visualizations:true,Risk:true},
    "Full Access":{Dashboard:true,Standup:true,Experts:true,Reviewers:true,"Ops Team":true,Tickets:true,Tasks:true,Velocity:true,"Quality Control":true,"Ramp Plan":true,Visualizations:true,Risk:true},
  };
  const save=()=>{
    if(!form.name.trim()||!form.pin.trim())return;
    if(editUser){setAccessUsers(p=>p.map(u=>u.id===editUser.id?{...form,id:u.id,addedAt:u.addedAt}:u));setEditUser(null);}
    else setAccessUsers(p=>{
      const nextId=uniqueIdForItems(p,"USR");
      return [...p,{...form,id:nextId,addedAt:today()}];
    });
    setForm(blank());setModal(false);
  };
  const openEdit=u=>{setForm({name:u.name,email:u.email||"",role:u.role,pin:u.pin||"",tabs:u.tabs||{}});setEditUser(u);setModal(true);};
  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <div style={{background:C.blueSoft,border:`1px solid ${C.blue}30`,borderRadius:12,padding:18}}>
        <div style={{color:C.blueText,fontWeight:700,marginBottom:6}}>🔐 PIN-based Access</div>
        <div style={{color:C.muted,fontSize:13,lineHeight:1.7}}>Each person gets a unique PIN. Admin PIN is <strong style={{fontFamily:"'DM Mono',monospace"}}>ADMIN</strong> (change in source before deploying). Financials and Access are always admin-only.</div>
      </div>
      <div style={{display:"flex",gap:10,justifyContent:"space-between"}}>
        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>{setForm(blank());setEditUser(null);setModal(true);}} style={{...btnSm,background:C.blue,color:"#fff",border:"none"}}>+ Add User</button>
          <button onClick={()=>setShowPins(p=>!p)} style={btnSm}>{showPins?"Hide PINs":"Reveal PINs"}</button>
        </div>
        <span style={{color:C.muted,fontSize:13}}>{accessUsers.length} user(s)</span>
      </div>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,overflow:"hidden"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <TH cols={["#","Name","Email","Role","PIN","Tab Access","Added","Actions"]}/>
          <tbody>
            {accessUsers.length===0&&<tr><td colSpan={8} style={{padding:40,textAlign:"center",color:C.faint}}>No users added yet.</td></tr>}
            {accessUsers.map((u,i)=>{
              const enabled=Object.entries(u.tabs||{}).filter(([,v])=>v).map(([k])=>k);
              return(
                <tr key={u.id} style={{borderTop:`1px solid ${C.border}`,background:i%2?"#fafafa":C.surface}}>
                  <td style={{padding:"12px 14px",color:C.faint,fontFamily:"'DM Mono',monospace",fontSize:12,width:40}}>{i+1}</td>
                  <td style={{padding:"12px 14px",fontWeight:700}}>{u.name}</td>
                  <td style={{padding:"12px 14px",color:C.muted,fontSize:13}}>{u.email||"—"}</td>
                  <td style={{padding:"12px 14px"}}><Bdg color={u.role==="admin"?C.red:C.blue}>{u.role}</Bdg></td>
                  <td style={{padding:"12px 14px",fontFamily:"'DM Mono',monospace",fontSize:13}}>{showPins?(u.pin||"—"):"••••"}</td>
                  <td style={{padding:"12px 14px"}}><div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{enabled.length===0?<span style={{color:C.faint,fontSize:12}}>No tabs</span>:enabled.map(t=><Bdg key={t} color={C.blue}>{t}</Bdg>)}</div></td>
                  <td style={{padding:"12px 14px",color:C.muted,fontSize:12}}>{u.addedAt}</td>
                  <td style={{padding:"12px 14px"}}><div style={{display:"flex",gap:6}}>
                    <button onClick={()=>openEdit(u)} style={{...btnSm,padding:"3px 10px",fontSize:12}}>Edit</button>
                    <button onClick={()=>setAccessUsers(p=>p.filter(x=>x.id!==u.id))} style={{...btnSm,padding:"3px 10px",fontSize:12,color:C.red,borderColor:C.red+"50"}}>Remove</button>
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {modal&&(
        <Modal title={editUser?"Edit User":"Add User"} onClose={()=>{setModal(false);setEditUser(null);}} width={600}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
            <FF label="Name"><input type="text" value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} style={iStyle}/></FF>
            <FF label="Email (optional)"><input type="email" value={form.email} onChange={e=>setForm(p=>({...p,email:e.target.value}))} style={iStyle}/></FF>
            <FF label="Role"><select value={form.role} onChange={e=>setForm(p=>({...p,role:e.target.value}))} style={selStyle}><option value="viewer">Viewer</option><option value="editor">Editor</option></select></FF>
            <FF label="PIN"><input type="text" value={form.pin} onChange={e=>setForm(p=>({...p,pin:e.target.value}))} style={{...iStyle,fontFamily:"'DM Mono',monospace"}} placeholder="e.g. NES2024"/></FF>
          </div>
          <div style={{marginBottom:14}}>
            <div style={{color:C.muted,fontSize:11,fontWeight:700,marginBottom:8,textTransform:"uppercase"}}>Quick Presets</div>
            <div style={{display:"flex",gap:8,marginBottom:14}}>{Object.entries(presets).map(([label,tabs])=><button key={label} onClick={()=>setForm(p=>({...p,tabs}))} style={{...btnSm,fontSize:12}}>{label}</button>)}</div>
            <div style={{color:C.muted,fontSize:11,fontWeight:700,marginBottom:8,textTransform:"uppercase"}}>Tab Access</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {CONTROLLABLE_TABS.map(tab=>(
                <label key={tab} style={{display:"flex",gap:10,alignItems:"center",cursor:"pointer",fontSize:13,padding:"8px 12px",background:form.tabs[tab]?C.blueSoft:"#f8fafc",border:`1px solid ${form.tabs[tab]?C.blue+"50":C.border}`,borderRadius:8}}>
                  <input type="checkbox" checked={!!form.tabs[tab]} onChange={()=>setForm(p=>({...p,tabs:{...p.tabs,[tab]:!p.tabs[tab]}}))}/>
                  <span style={{color:form.tabs[tab]?C.blueText:C.muted,fontWeight:form.tabs[tab]?700:500}}>{tab}</span>
                </label>
              ))}
            </div>
            <div style={{marginTop:10,padding:"8px 12px",background:"#f8fafc",borderRadius:8}}><span style={{color:C.faint,fontSize:12}}>🔒 Financials and Access are always admin-only.</span></div>
          </div>
          <button onClick={save} style={btnPri}>{editUser?"Save Changes":"Add User"}</button>
        </Modal>
      )}
    </div>
  );
}

// ─── TIME TRACKER ─────────────────────────────────────────────────────────────
function TimeTrackerTab({timeLogs,setTimeLogs,qmSettings,setQmSettings,setAvailEvents,opsTeam,accessUsers,currentUser,isAdmin}){
  const [subTab,setSubTab]=useState("log");
  const [viewTz,setViewTz]=useState(()=>readTimeTrackerTzPref(currentUser?.id,isAdmin));
  const [weekOffset,setWeekOffset]=useState(0);
  const [filterQm,setFilterQm]=useState("all");
  const [now,setNow]=useState(new Date());
  const [timer,setTimer]=useState({running:false,hasSession:false,sessionStartISO:null,adjustedStartISO:null,pausedElapsedMs:0,qmId:currentUser?.id||opsTeam[0]?.id||"",notes:"",activeLogId:null});
  const [addEventModal,setAddEventModal]=useState(false);
  const [eventForm,setEventForm]=useState({qmId:isAdmin?"all":(currentUser?.id||""),type:"available",label:"",startTime:"",endTime:""});
  const [colorPickerFor,setColorPickerFor]=useState(null);
  const [manualModal,setManualModal]=useState(false);
  const [manualForm,setManualForm]=useState({qmId:currentUser?.id||"",date:"",startAt:"",endAt:"",notes:""});
  const [editModal,setEditModal]=useState(false);
  const [editForm,setEditForm]=useState({id:"",qmId:"",startTime:"",endTime:"",notes:""});
  const [rejectModal,setRejectModal]=useState(false);
  const [rejectLogId,setRejectLogId]=useState(null);
  const [rejectReason,setRejectReason]=useState("");
  const [TAB_ID] = useState(() => {
    if (typeof window === "undefined") return "tab-ssr";
    const existing = sessionStorage.getItem("nesTabId");
    if (existing) return existing;
    const id = (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") ? crypto.randomUUID() : makeId("tab");
    sessionStorage.setItem("nesTabId", id);
    return id;
  });

  const isEditor=currentUser?.role==="editor";
  const myQmId=currentUser?.id||"";
  const myQmById=opsTeam.find(o=>o.id===myQmId);
  const myQmByName=opsTeam.find(o=>(o.name||"").trim().toLowerCase()===(currentUser?.name||"").trim().toLowerCase());
  const myQm=myQmById||myQmByName||null;
  const resolvedQmId=myQm?.id||myQmId;
  const fallbackMyQm=(!isAdmin&&isEditor&&resolvedQmId)?(myQm||{id:resolvedQmId,name:currentUser?.name||"My QM",role:"QM",region:"—",status:"active",hourlyRate:0}):null;
  const isScopedQM=!isAdmin&&isEditor;

  const logsInScope=isAdmin?timeLogs:timeLogs.filter(l=>l.qmId===myQmId||l.qmId===resolvedQmId);
  const qmsInScope=isAdmin?opsTeam:(fallbackMyQm?[fallbackMyQm]:[]);

  const logStatus=l=>l.approvalStatus||"approved";
  const toIsoFromDateAndTime=(d,t)=>{
    if(!d||!t) return "";
    const iso=wallClockToUTC(d,t,viewTz);
    if(iso) return iso;
    const dt=new Date(`${d}T${t}`);
    if(Number.isNaN(dt.getTime())) return "";
    return dt.toISOString();
  };
  const toLocalInputValue=iso=>{
    if(!iso) return "";
    const d=new Date(iso);
    if(Number.isNaN(d.getTime())) return "";
    const y=d.getFullYear();
    const m=String(d.getMonth()+1).padStart(2,"0");
    const day=String(d.getDate()).padStart(2,"0");
    const hh=String(d.getHours()).padStart(2,"0");
    const mm=String(d.getMinutes()).padStart(2,"0");
    return `${y}-${m}-${day}T${hh}:${mm}`;
  };
  const pushHistory=(log,action,note="")=>[
    ...(log.editHistory||[]),
    { at:new Date().toISOString(), by:isAdmin?"__admin__":(currentUser?.id||"unknown"), action, note }
  ];
  const hoursForLog=l=>{
    const ms=(new Date(l.endTime)-new Date(l.startTime));
    if(!l.endTime||ms<=0) return 0;
    return ms/3600000;
  };
  const payForLog=l=>{
    const qm=opsTeam.find(o=>o.id===l.qmId)||(l.qmId===myQmId?fallbackMyQm:null);
    const rate=l.hourlyRateSnapshot??(qm?.hourlyRate||0);
    return hoursForLog(l)*rate;
  };
  const canCurrentUserControlLog=log=>{
    if(!log||isAdmin) return false;
    return log.qmId===myQmId||log.qmId===resolvedQmId;
  };
  const claimLockIfAllowed=(log,options={})=>{
    const { allowTakeover=false, silent=false } = options;
    if(!log){
      if(!silent) alert("This timer session was not found.");
      return false;
    }
    if(log.endTime){
      if(!silent) alert("This timer has already been stopped in another tab.");
      return false;
    }
    if(!log.lockedBy||log.lockedBy===TAB_ID){
      if(log.lockedBy!==TAB_ID){
        const stamp=new Date().toISOString();
        setTimeLogs(prev=>prev.map(l=>l.id===log.id?{...l,lockedBy:TAB_ID,lastSeen:stamp}:l));
      }
      return true;
    }
    if(canCurrentUserControlLog(log)){
      if(!allowTakeover){
        if(!silent) alert("This timer is active in another tab. Use Resume, Pause, or Stop here to explicitly take over control.");
        return false;
      }
      if(!silent&&!confirm("This timer is active in another tab. Take over control in this tab?")) return false;
      const stamp=new Date().toISOString();
      setTimeLogs(prev=>prev.map(l=>l.id===log.id?{...l,lockedBy:TAB_ID,lastSeen:stamp}:l));
      return true;
    }
    if(!silent) alert("This session is active in another tab.");
    return false;
  };

  // Single interval drives both live clock and elapsed display
  useEffect(()=>{const t=setInterval(()=>setNow(new Date()),1000);return()=>clearInterval(t);},[]);

  // Restore any active (unfinished) session in current scope
  useEffect(()=>{
    if(isAdmin) return;
    const active=timeLogs.find(l=>!l.endTime&&(l.qmId===myQmId||l.qmId===resolvedQmId));
    if(!active){
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTimer(prev=>{
        if(!prev.hasSession&&!prev.activeLogId&&!prev.running) return prev;
        return {running:false,hasSession:false,sessionStartISO:null,adjustedStartISO:null,pausedElapsedMs:0,qmId:resolvedQmId||prev.qmId,notes:"",activeLogId:null};
      });
      return;
    }

    const ownsLock=claimLockIfAllowed(active,{silent:true});
    setTimer(prev=>{
      const sameSession=prev.activeLogId===active.id;
      const autoRunning=ownsLock||!active.lockedBy||active.lockedBy===TAB_ID;
      const running=sameSession?(active.lockedBy&&active.lockedBy!==TAB_ID?false:prev.running):autoRunning;
      const next={
        running,
        hasSession:true,
        sessionStartISO:active.startTime,
        adjustedStartISO:sameSession?(prev.adjustedStartISO||active.startTime):active.startTime,
        pausedElapsedMs:sameSession?prev.pausedElapsedMs:0,
        qmId:active.qmId,
        notes:sameSession?prev.notes:(active.notes||""),
        activeLogId:active.id,
      };
      return sameJSON(prev,next)?prev:next;
    });
  },[timeLogs,myQmId,isAdmin,resolvedQmId,TAB_ID]);// eslint-disable-line react-hooks/exhaustive-deps

  useEffect(()=>{
    if(!isAdmin&&resolvedQmId){
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFilterQm(resolvedQmId);
      setTimer(t=>({...t,qmId:t.hasSession?t.qmId:resolvedQmId}));
      setManualForm(f=>({...f,qmId:resolvedQmId}));
      setEventForm(f=>({...f,qmId:resolvedQmId}));
    }
  },[isAdmin,resolvedQmId]);

  const getQm=id=>opsTeam.find(o=>o.id===id)||(id===myQmId?fallbackMyQm:null);
  const getAccessUser=id=>(accessUsers||[]).find(u=>u.id===id);
  const getQmName=id=>getQm(id)?.name||getAccessUser(id)?.name||String(id);
  const getQmCfg=id=>qmSettings.find(s=>s.qmId===id)||{color:C.blue,homeTz:"UTC"};
  const tzAbbrFor=iana=>TZ_OPTIONS.find(t=>t.iana===iana)?.abbr||iana;
  const viewAbbr=tzAbbrFor(viewTz);
  const onViewTzChange=iana=>{
    setViewTz(iana);
    writeTimeTrackerTzPref(currentUser?.id,isAdmin,iana);
  };

  // Elapsed derived from `now` — no separate setInterval needed
  const elapsedMs=timer.running&&timer.adjustedStartISO?Math.max(0,now.getTime()-new Date(timer.adjustedStartISO).getTime()):timer.pausedElapsedMs;
  const elapsedSec=Math.floor(elapsedMs/1000);
  const activeTimerLog=timer.activeLogId?timeLogs.find(l=>l.id===timer.activeLogId):null;
  const lockHeldElsewhere=!!activeTimerLog&&!activeTimerLog.endTime&&!!activeTimerLog.lockedBy&&activeTimerLog.lockedBy!==TAB_ID;

  const startTimer=()=>{
    const nowISO=new Date().toISOString();
    if(!timer.hasSession){
      const newId=uniqueIdForItems(timeLogs,"TL");
      const rate=(getQm(timer.qmId)?.hourlyRate||0);
      setTimeLogs(prev=>[{id:newId,qmId:timer.qmId,startTime:nowISO,endTime:null,notes:timer.notes,source:"timer",approvalStatus:"pending",hourlyRateSnapshot:rate,lockedBy:TAB_ID,lastSeen:nowISO},...prev]);
      setTimer(t=>({...t,running:true,hasSession:true,sessionStartISO:nowISO,adjustedStartISO:nowISO,pausedElapsedMs:0,activeLogId:newId}));
    } else {
      const activeLog=timeLogs.find(l=>l.id===timer.activeLogId);
      if(!claimLockIfAllowed(activeLog,{allowTakeover:true})) return;
      const resumed=timer.pausedElapsedMs>0?new Date(now.getTime()-timer.pausedElapsedMs).toISOString():(activeLog?.startTime||timer.sessionStartISO||nowISO);
      setTimer(t=>({...t,running:true,adjustedStartISO:resumed}));
    }
  };
  const pauseTimer=()=>{
    const activeLog=timeLogs.find(l=>l.id===timer.activeLogId);
    if(!claimLockIfAllowed(activeLog,{allowTakeover:true})) return;
    const elapsed=Math.max(0,now.getTime()-new Date(timer.adjustedStartISO).getTime());
    setTimer(t=>({...t,running:false,pausedElapsedMs:elapsed}));
  };
  const stopTimer=()=>{
    const activeLog=timeLogs.find(l=>l.id===timer.activeLogId);
    if(!claimLockIfAllowed(activeLog,{allowTakeover:true})) return;
    if(!timer.notes||!timer.notes.trim()){alert("Please add session notes describing what you worked on before stopping.");return;}
    const endTime=new Date().toISOString();
    setTimeLogs(prev=>prev.map(l=>l.id===timer.activeLogId?{...l,endTime,notes:timer.notes,approvalStatus:"pending",lockedBy:null,lastSeen:endTime,editHistory:pushHistory(l,"timer_stop","Timer session completed — pending admin approval")}:l));
    setTimer({running:false,hasSession:false,sessionStartISO:null,adjustedStartISO:null,pausedElapsedMs:0,qmId:timer.qmId,notes:"",activeLogId:null});
  };

  // Admin force-stop: stop any active log regardless of lockedBy
  const adminForceStop=(logId)=>{
    if(!confirm("Force-stop this active timer? The log will be closed at the current time and marked pending approval.")) return;
    const endTime=new Date().toISOString();
    setTimeLogs(prev=>prev.map(l=>l.id===logId?{...l,endTime,approvalStatus:"pending",lockedBy:null,lastSeen:endTime,editHistory:pushHistory(l,"admin_force_stop","Admin force-stopped active timer")}:l));
  };

  // Keep a lightweight heartbeat on active timers so locks can be reclaimed after refresh.
  useEffect(()=>{
    if(!timer.running||!timer.activeLogId) return;
    const touch=()=>{
      const stamp=new Date().toISOString();
      setTimeLogs(prev=>{
        let changed=false;
        const next=prev.map(l=>{
          if(l.id!==timer.activeLogId) return l;
          if(l.endTime) return l;
          if(l.lockedBy&&l.lockedBy!==TAB_ID) return l;
          changed=true;
          return {...l,lastSeen:stamp,lockedBy:TAB_ID};
        });
        return changed?next:prev;
      });
    };
    touch();
    const t=setInterval(touch,30000);
    return()=>clearInterval(t);
  },[timer.running,timer.activeLogId,setTimeLogs,TAB_ID]);

  const updateQmCfg=(qmId,patch)=>setQmSettings(prev=>{
    const exists=prev.find(s=>s.qmId===qmId);
    if(exists)return prev.map(s=>s.qmId===qmId?{...s,...patch}:s);
    return[...prev,{qmId,color:C.blue,homeTz:"UTC",...patch}];
  });

  // Week boundaries (Mon–Sun) for calendar + KPIs
  const weekBase=new Date(now);
  weekBase.setDate(weekBase.getDate() + (weekOffset*7));
  const weekStart=new Date(weekBase);
  const dow=weekStart.getDay();
  weekStart.setDate(weekStart.getDate()-(dow===0?6:dow-1));
  weekStart.setHours(0,0,0,0);
  const weekEnd=new Date(weekStart);weekEnd.setDate(weekStart.getDate()+7);
  const weekDays=Array.from({length:7},(_,i)=>{const d=new Date(weekStart);d.setDate(weekStart.getDate()+i);return d;});

  const msToDur=ms=>{const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000);return h>0?`${h}h ${m}m`:`${m}m`;};
  const msClippedToDay = (log, dayDate, iana) => {
    if (!log.endTime) return 0;
    const dayStr = isoDateInTZ(dayDate.toISOString(), iana);
    const [y, m, d] = dayStr.split("-").map(Number);
    if (![y, m, d].every(Number.isFinite)) return 0;
    const pad = n => String(n).padStart(2, "0");
    const dayStartIso = wallClockToUTC(`${y}-${pad(m)}-${pad(d)}`, "00:00", iana);
    const dayAnchor = new Date(Date.UTC(y, m - 1, d));
    dayAnchor.setUTCDate(dayAnchor.getUTCDate() + 1);
    const ny = dayAnchor.getUTCFullYear();
    const nm = dayAnchor.getUTCMonth() + 1;
    const nd = dayAnchor.getUTCDate();
    const nextStartIso = wallClockToUTC(`${ny}-${pad(nm)}-${pad(nd)}`, "00:00", iana);

    const s = new Date(log.startTime).getTime();
    const e = new Date(log.endTime).getTime();
    const dayStart = new Date(dayStartIso || log.startTime).getTime();
    const nextStart = new Date(nextStartIso || log.endTime).getTime();
    if (![s, e, dayStart, nextStart].every(Number.isFinite)) return 0;

    return Math.max(0, Math.min(e, nextStart) - Math.max(s, dayStart));
  };
  const approvedLogsInScope=logsInScope.filter(l=>l.endTime&&logStatus(l)==="approved");
  const pendingLogsInScope=logsInScope.filter(l=>l.endTime&&logStatus(l)==="pending");

  const myHours=approvedLogsInScope.filter(l=>new Date(l.startTime)>=weekStart&&new Date(l.startTime)<weekEnd).reduce((s,l)=>s+(new Date(l.endTime)-new Date(l.startTime)),0);
  const pendingHours=pendingLogsInScope.filter(l=>new Date(l.startTime)>=weekStart&&new Date(l.startTime)<weekEnd).reduce((s,l)=>s+(new Date(l.endTime)-new Date(l.startTime)),0);
  const myPayWeek=approvedLogsInScope.filter(l=>new Date(l.startTime)>=weekStart&&new Date(l.startTime)<weekEnd).reduce((s,l)=>s+payForLog(l),0);
  const pendingPayWeek=pendingLogsInScope.filter(l=>new Date(l.startTime)>=weekStart&&new Date(l.startTime)<weekEnd).reduce((s,l)=>s+payForLog(l),0);
  const approvedPayTotal=approvedLogsInScope.reduce((s,l)=>s+payForLog(l),0);
  const pendingPayTotal=pendingLogsInScope.reduce((s,l)=>s+payForLog(l),0);

  const activeQMs=qmsInScope.filter(o=>o.status==="active");
  const filteredLogs=(isAdmin?(filterQm==="all"?logsInScope:logsInScope.filter(l=>l.qmId===filterQm)):logsInScope).slice().sort((a,b)=>new Date(b.startTime)-new Date(a.startTime));

  const openEditLog=(log)=>{
    setEditForm({id:log.id,qmId:log.qmId,startTime:toLocalInputValue(log.startTime),endTime:toLocalInputValue(log.endTime),notes:log.notes||""});
    setEditModal(true);
  };
  const saveEditedLog=()=>{
    if(!editForm.startTime||!editForm.endTime) return;
    const startIso=new Date(editForm.startTime).toISOString();
    const endIso=new Date(editForm.endTime).toISOString();
    if(new Date(endIso)<=new Date(startIso)) return;
    setTimeLogs(prev=>prev.map(l=>{
      if(l.id!==editForm.id) return l;
      const editedByAdmin=isAdmin;
      const nextStatus=editedByAdmin?logStatus(l):(logStatus(l)==="approved"?"pending":logStatus(l));
      const note=editedByAdmin?"Admin edited log entry":"QM edited own log entry";
      return {
        ...l,
        qmId:editedByAdmin?editForm.qmId:l.qmId,
        startTime:startIso,
        endTime:endIso,
        notes:editForm.notes,
        hourlyRateSnapshot:editedByAdmin&&editForm.qmId!==l.qmId?(getQm(editForm.qmId)?.hourlyRate||0):(l.hourlyRateSnapshot??(getQm(l.qmId)?.hourlyRate||0)),
        approvalStatus:nextStatus,
        rejectionReason:nextStatus==="pending"?"":(l.rejectionReason||""),
        editHistory:pushHistory(l,"edit",note)
      };
    }));
    setEditModal(false);
  };
  const approveManual=(id)=>{
    setTimeLogs(prev=>prev.map(l=>l.id===id?{
      ...l,
      approvalStatus:"approved",
      approvedAt:new Date().toISOString(),
      approvedBy:"__admin__",
      rejectionReason:"",
      editHistory:pushHistory(l,"approve","Manual time approved by admin")
    }:l));
  };
  const rejectManual=()=>{
    if(!rejectLogId) return;
    setTimeLogs(prev=>prev.map(l=>l.id===rejectLogId?{
      ...l,
      approvalStatus:"rejected",
      reviewedAt:new Date().toISOString(),
      reviewedBy:"__admin__",
      rejectionReason:rejectReason,
      editHistory:pushHistory(l,"reject",rejectReason||"Rejected by admin")
    }:l));
    setRejectModal(false);
    setRejectLogId(null);
    setRejectReason("");
  };
  const cancelManualRequest=(id)=>{
    setTimeLogs(prev=>prev.map(l=>{
      if(l.id!==id) return l;
      if(logStatus(l)!=="pending"||l.source!=="manual") return l;
      return {
        ...l,
        approvalStatus:"cancelled",
        cancelledAt:new Date().toISOString(),
        cancelledBy:currentUser?.id||"unknown",
        editHistory:pushHistory(l,"cancel_request","QM cancelled pending manual request")
      };
    }));
  };
  const submitManualTime=()=>{
    if(!manualForm.qmId||!manualForm.date||!manualForm.startAt||!manualForm.endAt) return;
    if(!manualForm.notes||!manualForm.notes.trim()){alert("Session notes are required. Please describe what you worked on during this time.");return;}
    const startIso=toIsoFromDateAndTime(manualForm.date,manualForm.startAt);
    const endIso=toIsoFromDateAndTime(manualForm.date,manualForm.endAt);
    if(!startIso||!endIso) return;
    if(new Date(endIso)<=new Date(startIso)) return;
    const isAdminSubmit=isAdmin;
    const status=isAdminSubmit?"approved":"pending";
    const newId=uniqueIdForItems(timeLogs,"TL");
    const rate=(getQm(manualForm.qmId)?.hourlyRate||0);
    setTimeLogs(prev=>[{id:newId,qmId:manualForm.qmId,startTime:startIso,endTime:endIso,notes:manualForm.notes,source:"manual",approvalStatus:status,hourlyRateSnapshot:rate,requestedAt:new Date().toISOString(),requestedBy:currentUser?.id||"__admin__",editHistory:[{at:new Date().toISOString(),by:currentUser?.id||"__admin__",action:"create_manual",note:isAdminSubmit?"Manual log added by admin":"Manual log submitted for approval"}]},...prev]);
    setManualModal(false);
    setManualForm({qmId:isAdmin?"":resolvedQmId,date:"",startAt:"",endAt:"",notes:""});
  };

  const auditRows=isAdmin
    ? timeLogs.flatMap(l=>(l.editHistory||[]).map(h=>({logId:l.id,qmId:l.qmId,at:h.at,by:h.by,action:h.action,note:h.note||""}))).sort((a,b)=>new Date(b.at)-new Date(a.at))
    : [];

  const navBtn=key=>({background:"none",border:"none",color:subTab===key?"#60a5fa":"#94a3b8",borderBottom:subTab===key?"2px solid #60a5fa":"2px solid transparent",padding:"10px 14px",cursor:"pointer",fontSize:13,fontWeight:subTab===key?700:500,fontFamily:"inherit",transition:"all 0.12s",whiteSpace:"nowrap"});

  if(!isAdmin&&!isScopedQM){
    return <Card title="Time Tracker"><div style={{color:C.muted,fontSize:14,lineHeight:1.7}}>Time Tracker is available only for editor users.</div></Card>;
  }

  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      {/* Sub-nav + timezone bar */}
      <div style={{background:C.navy,borderRadius:12,overflow:"hidden"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 16px",flexWrap:"wrap",gap:8}}>
          <div style={{display:"flex"}}>
            <button style={navBtn("log")} onClick={()=>setSubTab("log")}>⏱ Time Log</button>
            <button style={navBtn("daily")} onClick={()=>setSubTab("daily")}>📅 Daily Log</button>
            <button style={navBtn("settings")} onClick={()=>setSubTab("settings")}>⚙ QM Settings</button>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:12,padding:"8px 0"}}>
            <span style={{fontFamily:"'DM Mono',monospace",fontSize:12,color:"#94a3b8"}}>{fmtTimeTZ(now.toISOString(),viewTz)} {viewAbbr}</span>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <span style={{color:"#64748b",fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em"}}>View in</span>
              <select value={viewTz} onChange={e=>onViewTzChange(e.target.value)} style={{background:"#0f172a",color:"#e2e8f0",border:"1px solid #334155",borderRadius:7,padding:"5px 10px",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>
                {TZ_OPTIONS.map(t=><option key={t.iana} value={t.iana}>{t.label}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* ── TIME LOG ──────────────────────────────────────────────────────── */}
      {subTab==="log"&&(
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14}}>
            <KPI label="Approved Time This Week" value={myHours>0?msToDur(myHours):"0h"} color={C.blue} icon="⏱"/>
            <KPI label="Approved Pay This Week" value={fmtU(myPayWeek)} color={C.green} icon="💵"/>
            <KPI label="Pending Time This Week" value={pendingHours>0?msToDur(pendingHours):"0h"} color={C.yellow} icon="🕒"/>
            <KPI label="Pending Pay This Week" value={fmtU(pendingPayWeek)} color={C.orange} icon="🧾" sub={isAdmin?`${pendingLogsInScope.length} pending request(s)`:"awaiting admin approval"}/>
          </div>

          <Card title="Payments Summary">
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
              <div style={{background:C.greenSoft,border:`1px solid ${C.green}40`,borderRadius:10,padding:14}}>
                <div style={{color:C.greenText,fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:6}}>Approved Payments</div>
                <div style={{fontFamily:"'DM Mono',monospace",fontWeight:800,fontSize:24,color:C.green}}>{fmtU(approvedPayTotal)}</div>
                <div style={{color:C.muted,fontSize:12,marginTop:4}}>{approvedLogsInScope.length} approved log(s)</div>
              </div>
              <div style={{background:C.yellowSoft,border:`1px solid ${C.yellow}40`,borderRadius:10,padding:14}}>
                <div style={{color:C.yellowText,fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:6}}>Pending Payments</div>
                <div style={{fontFamily:"'DM Mono',monospace",fontWeight:800,fontSize:24,color:C.orange}}>{fmtU(pendingPayTotal)}</div>
                <div style={{color:C.muted,fontSize:12,marginTop:4}}>{pendingLogsInScope.length} pending request(s)</div>
              </div>
            </div>
          </Card>

          {/* Timer card — only for non-admin QMs */}
          {!isAdmin&&(
          <Card title="Active Timer" extra={<button onClick={()=>{setManualForm({qmId:isAdmin?"":resolvedQmId,date:today(),startAt:"09:00",endAt:"17:00",notes:""});setManualModal(true);}} style={{...btnSm,background:C.blue,color:"#fff",border:"none",fontSize:12}}>+ Add Manual Time</button>}>
            <div style={{display:"flex",alignItems:"center",gap:20,flexWrap:"wrap"}}>
              <div style={{fontSize:38,fontFamily:"'DM Mono',monospace",fontWeight:600,letterSpacing:3,color:timer.running?C.blue:timer.hasSession?C.yellow:C.faint,minWidth:165}}>{fmtElapsed(elapsedSec)}</div>
              <div style={{display:"flex",gap:10,alignItems:"flex-end",flexWrap:"wrap"}}>
                <div>
                  <div style={{color:C.muted,fontSize:11,fontWeight:700,marginBottom:5,textTransform:"uppercase",letterSpacing:"0.05em"}}>Queue Manager</div>
                  <select value={timer.qmId} onChange={e=>!timer.hasSession&&setTimer(t=>({...t,qmId:e.target.value}))} style={{...selStyle,width:160,opacity:timer.hasSession||!isAdmin?0.6:1,cursor:timer.hasSession||!isAdmin?"not-allowed":"pointer"}} disabled={!isAdmin}>
                    <option value="">Select QM...</option>
                    {qmsInScope.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </div>
                <div>
                  <div style={{color:C.muted,fontSize:11,fontWeight:700,marginBottom:5,textTransform:"uppercase",letterSpacing:"0.05em"}}>Notes</div>
                  <input value={timer.notes} onChange={e=>setTimer(t=>({...t,notes:e.target.value}))} placeholder="Session notes..." style={{...iStyle,width:220}}/>
                </div>
              </div>
              <div style={{display:"flex",gap:8,marginLeft:"auto",flexWrap:"wrap"}}>
                {!timer.running&&<button onClick={startTimer} disabled={!timer.qmId} style={{...btnSm,background:C.blue,color:"#fff",border:"none",opacity:!timer.qmId?0.5:1}}>{timer.hasSession?"▶ Resume":"▶ Start"}</button>}
                {timer.running&&<button onClick={pauseTimer} style={{...btnSm,background:C.yellow,color:"#fff",border:"none"}}>⏸ Pause</button>}
                {timer.hasSession&&<button onClick={stopTimer} style={{...btnSm,background:C.red,color:"#fff",border:"none"}}>⏹ Stop & Log</button>}
              </div>
            </div>
            {timer.running&&timer.sessionStartISO&&(
              <div style={{marginTop:12,padding:"10px 14px",background:C.tealSoft,border:`1px solid ${C.teal}30`,borderRadius:8,color:C.teal,fontSize:13,lineHeight:1.5}}>
                Started at <strong style={{fontFamily:"'DM Mono',monospace"}}>{fmtTimeTZ(timer.sessionStartISO,viewTz)} {viewAbbr}</strong> · Logging for <strong>{getQm(timer.qmId)?.name||"—"}</strong>
              </div>
            )}
            {lockHeldElsewhere&&(
              <div style={{marginTop:12,padding:"10px 14px",background:C.yellowSoft,border:`1px solid ${C.yellow}40`,borderRadius:8,color:C.yellowText,fontSize:13,lineHeight:1.5}}>
                This timer is currently controlled in another tab. Use Resume, Pause, or Stop here and confirm takeover to force control in this tab.
              </div>
            )}
          </Card>
          )}

          {/* Admin gets a simple manual time add button instead of timer */}
          {isAdmin&&(
            <div style={{display:"flex",justifyContent:"flex-end"}}>
              <button onClick={()=>{setManualForm({qmId:"",date:today(),startAt:"09:00",endAt:"17:00",notes:""});setManualModal(true);}} style={{...btnSm,background:C.blue,color:"#fff",border:"none"}}>+ Add Manual Time Entry</button>
            </div>
          )}

          {/* Team clocks */}
          {activeQMs.length>0&&(
            <Card>
              <div style={{display:"flex",gap:24,alignItems:"center",flexWrap:"wrap"}}>
                <span style={{color:C.muted,fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.07em",flexShrink:0}}>{isAdmin?"Team Now":"Your Clock"}</span>
                {activeQMs.map(qm=>{
                  const cfg=getQmCfg(qm.id);
                  return(
                    <div key={qm.id} style={{display:"flex",alignItems:"center",gap:8}}>
                      <div style={{width:8,height:8,borderRadius:"50%",background:cfg.color,flexShrink:0}}/>
                      <span style={{fontSize:13,color:C.muted,fontWeight:600}}>{qm.name}</span>
                      <span style={{fontFamily:"'DM Mono',monospace",fontSize:13,fontWeight:700,color:C.text}}>{fmtTimeTZ(now.toISOString(),cfg.homeTz)}</span>
                      <span style={{fontSize:10,color:C.faint,background:"#f1f5f9",borderRadius:4,padding:"1px 5px",fontFamily:"'DM Mono',monospace"}}>{tzAbbrFor(cfg.homeTz)}</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Pending Approvals — admin sees all, QM sees their own */}
          {(()=>{
            const pending=filteredLogs.filter(l=>l.endTime&&logStatus(l)==="pending");
            const activeLogs=filteredLogs.filter(l=>!l.endTime);
            if(!pending.length&&!activeLogs.length) return null;
            return(
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {activeLogs.length>0&&(
                  <Card title="🔴 Active Timers" color={C.red+"40"}>
                    <div style={{display:"flex",flexDirection:"column",gap:8}}>
                      {activeLogs.map(log=>(
                        <div key={log.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",background:C.redSoft,borderRadius:8,flexWrap:"wrap",gap:8}}>
                          <div>
                            <div style={{fontWeight:700}}>{getQmName(log.qmId)}</div>
                            <div style={{color:C.muted,fontSize:12}}>Started: {fmtTimeTZ(log.startTime,viewTz)} {viewAbbr} · Running for {durStr(log.startTime,now.toISOString())}</div>
                            {log.notes&&<div style={{color:C.muted,fontSize:12,marginTop:2}}>📝 {log.notes}</div>}
                          </div>
                          <div style={{display:"flex",gap:8}}>
                            <Bdg color={C.red}>LIVE</Bdg>
                            {isAdmin&&<button onClick={()=>adminForceStop(log.id)} style={{...btnSm,background:C.red,color:"#fff",border:"none",fontSize:12}}>⏹ Force Stop</button>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
                {pending.length>0&&(
                  <Card title={`⏳ Pending Approvals (${pending.length})`} color={C.yellow+"60"}>
                    <div style={{display:"flex",flexDirection:"column",gap:8}}>
                      {pending.map(log=>(
                        <div key={log.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",background:C.yellowSoft,borderRadius:8,flexWrap:"wrap",gap:8}}>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontWeight:700}}>{getQmName(log.qmId)}</div>
                            <div style={{color:C.muted,fontSize:12}}>{fmtTZ(log.startTime,viewTz)} · {fmtTimeTZ(log.startTime,viewTz)}–{fmtTimeTZ(log.endTime,viewTz)} {viewAbbr} · <strong>{durStr(log.startTime,log.endTime)}</strong></div>
                            {log.notes&&<div style={{color:C.text,fontSize:13,marginTop:4,padding:"6px 10px",background:"#fff8",borderRadius:6}}>📝 {log.notes}</div>}
                            <div style={{color:C.faint,fontSize:11,marginTop:2}}>{log.source==="manual"?"Manual entry":"Timer session"}</div>
                          </div>
                          {isAdmin&&(
                            <div style={{display:"flex",gap:8,flexShrink:0}}>
                              <button onClick={()=>approveManual(log.id)} style={{...btnSm,background:C.green,color:"#fff",border:"none",fontSize:12}}>✓ Approve</button>
                              <button onClick={()=>{setRejectLogId(log.id);setRejectModal(true);}} style={{...btnSm,background:C.red,color:"#fff",border:"none",fontSize:12}}>✕ Reject</button>
                            </div>
                          )}
                          {!isAdmin&&<Bdg color={C.yellow}>Awaiting approval</Bdg>}
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
              </div>
            );
          })()}

          {/* Log table */}
          <Card title="Log Entries" extra={
            <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
              {isAdmin&&<select value={filterQm} onChange={e=>setFilterQm(e.target.value)} style={{...selStyle,width:150,fontSize:12}}>
                <option value="all">All QMs</option>
                {qmsInScope.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}
              </select>}
              <span style={{color:C.faint,fontSize:11,whiteSpace:"nowrap"}}>Showing in <strong style={{color:C.muted}}>{viewAbbr}</strong></span>
              <ExBtn onClick={()=>dlXLSX([{name:"Time Logs",data:filteredLogs.filter(l=>l.endTime).map(l=>({QM:getQmName(l.qmId),Date:fmtTZ(l.startTime,viewTz),Start:fmtTimeTZ(l.startTime,viewTz),End:fmtTimeTZ(l.endTime,viewTz),Duration:durStr(l.startTime,l.endTime),Status:logStatus(l),Notes:l.notes||"","Day Shift":hasDayShift(l.startTime,getQmCfg(l.qmId).homeTz,viewTz)?"Yes":"No"}))}],"NES_TimeLogs")} label="⬇ Export"/>
            </div>
          }>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",minWidth:700}}>
                <TH cols={["QM","Date","Start","End","Duration","Status","Notes","Actions"]}/>
                <tbody>
                  {filteredLogs.length===0&&<tr><td colSpan={8} style={{padding:40,textAlign:"center",color:C.faint}}>No log entries yet. Start a timer above.</td></tr>}
                  {filteredLogs.map((log,i)=>{
                    const qm=getQm(log.qmId);
                    const cfg=getQmCfg(log.qmId);
                    const shift=hasDayShift(log.startTime,cfg.homeTz,viewTz);
                    const isLive=!log.endTime;
                    const status=logStatus(log);
                    const ownsLog=log.qmId===myQmId||log.qmId===resolvedQmId;
                    const canEdit=!isLive&&(isAdmin||ownsLog);
                    const canDelete = !isLive && (isAdmin || (ownsLog && status !== "approved"));
                    const canCancelPending=!isAdmin&&!isLive&&status==="pending"&&log.source==="manual"&&(ownsLog||log.requestedBy===currentUser?.id);
                    return(
                      <tr key={log.id} style={{borderTop:`1px solid ${C.border}`,background:i%2?"#fafafa":C.surface}}>
                        <td style={{padding:"10px 14px"}}>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <div style={{width:8,height:8,borderRadius:"50%",background:cfg.color,flexShrink:0}}/>
                            <span style={{fontWeight:700,fontSize:13}}>{getQmName(log.qmId)}</span>
                          </div>
                        </td>
                        <td style={{padding:"10px 14px"}}>
                          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                            <span style={{color:C.muted,fontSize:13}}>{fmtTZ(log.startTime,viewTz)}</span>
                            {shift&&<span title={`${qm?.name||"QM"}'s home TZ (${tzAbbrFor(cfg.homeTz)}): ${fmtTZ(log.startTime,cfg.homeTz)} — View TZ (${viewAbbr}): ${fmtTZ(log.startTime,viewTz)}`} style={{background:C.yellowSoft,color:C.yellowText,fontSize:10,padding:"1px 6px",borderRadius:5,fontWeight:700,cursor:"help",border:`1px solid ${C.yellow}40`}}>⚠ day shift</span>}
                          </div>
                        </td>
                        <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",fontSize:13,color:C.muted}}>{fmtTimeTZ(log.startTime,viewTz)}</td>
                        <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",fontSize:13,color:C.muted}}>{isLive?<Bdg color={C.green}>Live</Bdg>:fmtTimeTZ(log.endTime,viewTz)}</td>
                        <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",fontWeight:700,color:C.text}}>{isLive?fmtElapsed(elapsedSec):durStr(log.startTime,log.endTime)}</td>
                        <td style={{padding:"10px 14px"}}><Bdg color={status==="approved"?C.green:status==="pending"?C.yellow:status==="cancelled"?C.faint:C.red}>{status.toUpperCase()}</Bdg></td>
                        <td style={{padding:"10px 14px",color:C.muted,fontSize:13,maxWidth:180}}>{log.notes||"—"}</td>
                        <td style={{padding:"10px 14px"}}>
                          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                            {canEdit&&<button onClick={()=>openEditLog(log)} style={{...btnSm,padding:"3px 10px",fontSize:12}}>Edit</button>}
                            {canDelete&&<button onClick={()=>setTimeLogs(prev=>prev.filter(l=>l.id!==log.id))} style={{...btnSm,padding:"3px 10px",fontSize:12,color:C.red,borderColor:C.red+"40"}}>Delete</button>}
                            {isAdmin&&status==="pending"&&<>
                              <button onClick={()=>approveManual(log.id)} style={{...btnSm,padding:"3px 10px",fontSize:12,background:C.green,color:"#fff",border:"none"}}>Approve</button>
                              <button onClick={()=>{setRejectLogId(log.id);setRejectReason("");setRejectModal(true);}} style={{...btnSm,padding:"3px 10px",fontSize:12,background:C.red,color:"#fff",border:"none"}}>Reject</button>
                            </>}
                            {canCancelPending&&<button onClick={()=>cancelManualRequest(log.id)} style={{...btnSm,padding:"3px 10px",fontSize:12,background:C.faint,color:"#fff",border:"none"}}>Cancel Request</button>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {isAdmin&&(
            <Card title="Edit Audit Log">
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",minWidth:700}}>
                  <TH cols={["When","QM","Action","By","Note","Log ID"]}/>
                  <tbody>
                    {auditRows.length===0&&<tr><td colSpan={6} style={{padding:30,textAlign:"center",color:C.faint}}>No edit activity yet.</td></tr>}
                    {auditRows.slice(0,100).map((a,i)=>(
                      <tr key={a.logId+a.at+i} style={{borderTop:`1px solid ${C.border}`,background:i%2?"#fafafa":C.surface}}>
                        <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",fontSize:12,color:C.muted}}>{fmtTZ(a.at,viewTz)} {fmtTimeTZ(a.at,viewTz)}</td>
                        <td style={{padding:"10px 14px",fontWeight:700,fontSize:13}}>{getQmName(a.qmId)}</td>
                        <td style={{padding:"10px 14px"}}><Bdg color={C.blue}>{a.action}</Bdg></td>
                        <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",fontSize:12,color:C.muted}}>{a.by}</td>
                        <td style={{padding:"10px 14px",fontSize:13,color:C.muted}}>{a.note||"—"}</td>
                        <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",fontSize:12,color:C.faint}}>{a.logId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ── DAILY LOG ─────────────────────────────────────────────────────── */}
      {subTab==="daily"&&(
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <Card title={`Daily Hours · Week of ${weekDays[0].toLocaleDateString("en-GB",{day:"numeric",month:"short"})} – ${weekDays[6].toLocaleDateString("en-GB",{day:"numeric",month:"short"})}`} extra={<div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <button onClick={()=>setWeekOffset(w=>w-1)} style={{...btnSm,padding:"4px 10px",fontSize:12}}>◀ Prev Week</button>
            <button onClick={()=>setWeekOffset(0)} disabled={weekOffset===0} style={{...btnSm,padding:"4px 10px",fontSize:12,opacity:weekOffset===0?0.5:1,cursor:weekOffset===0?"not-allowed":"pointer"}}>Current Week</button>
            <button onClick={()=>setWeekOffset(w=>w+1)} style={{...btnSm,padding:"4px 10px",fontSize:12}}>Next Week ▶</button>
            {isAdmin&&<select value={filterQm} onChange={e=>setFilterQm(e.target.value)} style={{...selStyle,width:150,fontSize:12}}>
              <option value="all">All QMs</option>
              {opsTeam.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}
            </select>}
            <ExBtn onClick={()=>{
              const scoped=(isAdmin&&filterQm!=="all")?logsInScope.filter(l=>l.qmId===filterQm):logsInScope;
              const rows=weekDays.map(d=>{
                const ds=isoDateInTZ(d.toISOString(),viewTz);
                const dayLogs=scoped.filter(l=>l.endTime&&isoDateInTZ(l.startTime,viewTz)===ds);
                const approvedMs=dayLogs.filter(l=>logStatus(l)==="approved").reduce((s,l)=>s+msClippedToDay(l,d,viewTz),0);
                const pendingMs=dayLogs.filter(l=>logStatus(l)==="pending").reduce((s,l)=>s+msClippedToDay(l,d,viewTz),0);
                return {Day:d.toLocaleDateString("en-GB",{weekday:"short"}),Date:d.toLocaleDateString("en-GB",{day:"2-digit",month:"short"}),"Approved Hrs":+(approvedMs/3600000).toFixed(2),"Pending Hrs":+(pendingMs/3600000).toFixed(2),"Total Hrs":+((approvedMs+pendingMs)/3600000).toFixed(2),Entries:dayLogs.length};
              });
              dlXLSX([{name:"Daily Hours",data:rows}],"NES_Daily_Time_Log");
            }} label="⬇ Export"/>
          </div>}>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",minWidth:700}}>
                <TH cols={["Day","Date","Approved Hours","Pending Hours","Total Hours","Entries"]}/>
                <tbody>
                  {weekDays.map((day,i)=>{
                    const ds=isoDateInTZ(day.toISOString(),viewTz);
                    const scoped=(isAdmin&&filterQm!=="all")?logsInScope.filter(l=>l.qmId===filterQm):logsInScope;
                    const dayLogs=scoped.filter(l=>l.endTime&&isoDateInTZ(l.startTime,viewTz)===ds);
                    const approvedMs=dayLogs.filter(l=>logStatus(l)==="approved").reduce((s,l)=>s+msClippedToDay(l,day,viewTz),0);
                    const pendingMs=dayLogs.filter(l=>logStatus(l)==="pending").reduce((s,l)=>s+msClippedToDay(l,day,viewTz),0);
                    const totalMs=approvedMs+pendingMs;
                    const isToday=isoDateInTZ(now.toISOString(),viewTz)===ds;
                    const hasCrossMidnight=dayLogs.some(l=>l.endTime&&isoDateInTZ(l.endTime,viewTz)!==isoDateInTZ(l.startTime,viewTz));
                    return(
                      <tr key={ds} style={{borderTop:`1px solid ${C.border}`,background:isToday?C.blueSoft:(i%2?"#fafafa":C.surface)}}>
                        <td style={{padding:"10px 14px",fontWeight:700}}>{day.toLocaleDateString("en-GB",{weekday:"short"})}</td>
                        <td style={{padding:"10px 14px",color:C.muted,fontSize:13}}>{day.toLocaleDateString("en-GB",{day:"2-digit",month:"short"})}</td>
                        <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",color:C.green}}>{(approvedMs/3600000).toFixed(2)}h</td>
                        <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",color:C.yellowText}}>{(pendingMs/3600000).toFixed(2)}h</td>
                        <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",fontWeight:700,color:C.text}}>{(totalMs/3600000).toFixed(2)}h</td>
                        <td style={{padding:"10px 14px",fontFamily:"'DM Mono',monospace",color:C.muted}}>
                          <span>{dayLogs.length}</span>
                          {hasCrossMidnight&&<span style={{marginLeft:8}}><Bdg color={C.yellow}>⚠ cross-midnight</Bdg></span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{marginTop:10,fontSize:11,color:C.faint}}>Hours are clipped to each calendar day boundary in {viewAbbr}. Cross-midnight logs are split across days and flagged with ⚠.</div>
          </Card>
        </div>
      )}

      {/* ── QM SETTINGS ───────────────────────────────────────────────────── */}
      {subTab==="settings"&&(
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {qmsInScope.length===0&&<div style={{color:C.faint,textAlign:"center",padding:40,background:C.surface,border:`1px solid ${C.border}`,borderRadius:12}}>No mapped Ops Team member found for this account.</div>}
          {qmsInScope.map(qm=>{
            const cfg=getQmCfg(qm.id);
            const isOpen=colorPickerFor===qm.id;
            return(
              <div key={qm.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:"14px 20px",display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
                <div style={{position:"relative",flexShrink:0}}>
                  <div onClick={()=>setColorPickerFor(isOpen?null:qm.id)} title="Click to change colour" style={{width:28,height:28,borderRadius:8,background:cfg.color,cursor:"pointer",border:"2px solid #fff",boxShadow:`0 0 0 1px ${C.border}`}}/>
                  {isOpen&&(
                    <div style={{position:"absolute",top:36,left:0,background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:10,display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6,zIndex:200,boxShadow:"0 8px 24px #0002"}}>
                      {QM_COLORS.map(c=><div key={c} onClick={()=>{updateQmCfg(qm.id,{color:c});setColorPickerFor(null);}} style={{width:22,height:22,borderRadius:6,background:c,cursor:"pointer",border:cfg.color===c?`2px solid ${C.text}`:"2px solid transparent",boxSizing:"border-box"}}/>)}
                    </div>
                  )}
                </div>
                <div style={{flex:1,minWidth:100}}>
                  <div style={{fontWeight:700,fontSize:14}}>{qm.name}</div>
                  <div style={{color:C.muted,fontSize:12,marginTop:2}}>{qm.role||"Ops"} · {qm.region||"—"}</div>
                </div>
                <div>
                  <div style={{color:C.muted,fontSize:11,fontWeight:700,marginBottom:5,textTransform:"uppercase",letterSpacing:"0.05em"}}>Home Timezone</div>
                  <select value={cfg.homeTz} onChange={e=>updateQmCfg(qm.id,{homeTz:e.target.value})} style={{...selStyle,width:185,fontSize:13}}>
                    {TZ_OPTIONS.map(t=><option key={t.iana} value={t.iana}>{t.label}</option>)}
                  </select>
                </div>
                <div style={{textAlign:"center"}}>
                  <div style={{color:C.muted,fontSize:11,fontWeight:700,marginBottom:5,textTransform:"uppercase",letterSpacing:"0.05em"}}>Status</div>
                  <Bdg color={STATUS_COLOR_MAP[qm.status]||C.faint}>{qm.status||"—"}</Bdg>
                </div>
              </div>
            );
          })}
          <div style={{padding:"12px 16px",background:C.tealSoft,border:`1px solid ${C.teal}30`,borderRadius:10}}>
            <div style={{color:C.teal,fontSize:13,lineHeight:1.7}}><strong>Day shift badge:</strong> The ⚠ badge in the Time Log flags entries where the calendar date differs between a QM's home timezone and the current view timezone — e.g. your Monday 00:00 BST appears as Sunday 19:00 EST. Hover the badge in the log to see both dates side by side.</div>
          </div>
        </div>
      )}

      {/* Add Event Modal */}
      {addEventModal&&(
        <Modal title="Add Availability Event" onClose={()=>setAddEventModal(false)}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
            <FF label="Queue Manager">
              <select value={eventForm.qmId} onChange={e=>setEventForm(p=>({...p,qmId:e.target.value}))} style={selStyle}>
                {isAdmin&&<option value="all">All team</option>}
                {activeQMs.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </FF>
            <FF label="Type">
              <select value={eventForm.type} onChange={e=>setEventForm(p=>({...p,type:e.target.value}))} style={selStyle}>
                <option value="available">Available</option>
                <option value="deadline">Deadline</option>
                <option value="ooo">Out of Office</option>
              </select>
            </FF>
            <FF label="Label (optional)"><input type="text" value={eventForm.label} onChange={e=>setEventForm(p=>({...p,label:e.target.value}))} placeholder={eventForm.type==="deadline"?"e.g. Batch 4 deadline":"e.g. Available for tasks"} style={iStyle}/></FF>
            <FF label="Start Time"><input type="datetime-local" value={eventForm.startTime} onChange={e=>setEventForm(p=>({...p,startTime:e.target.value}))} style={iStyle}/></FF>
            {eventForm.type!=="deadline"&&<FF label="End Time"><input type="datetime-local" value={eventForm.endTime} onChange={e=>setEventForm(p=>({...p,endTime:e.target.value}))} style={iStyle}/></FF>}
          </div>
          <button onClick={()=>{
            if(!eventForm.startTime)return;
            const si=new Date(eventForm.startTime).toISOString();
            const ei=eventForm.type==="deadline"?si:(eventForm.endTime?new Date(eventForm.endTime).toISOString():si);
            setAvailEvents(prev=>{
              const nextId=uniqueIdForItems(prev,"AV");
              return [...prev,{id:nextId,qmId:eventForm.qmId||(isAdmin?"all":myQmId),type:eventForm.type,startTime:si,endTime:ei,label:eventForm.label}];
            });
            setAddEventModal(false);
          }} style={btnPri}>Add Event</button>
        </Modal>
      )}

      {manualModal&&(
        <Modal title="Add Manual Time" onClose={()=>setManualModal(false)}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
            <FF label="Queue Manager">
              <select value={manualForm.qmId} onChange={e=>setManualForm(p=>({...p,qmId:e.target.value}))} style={{...selStyle,opacity:isAdmin?1:0.65,cursor:isAdmin?"pointer":"not-allowed"}} disabled={!isAdmin}>
                <option value="">Select QM...</option>
                {qmsInScope.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </FF>
            <FF label="Date"><input type="date" value={manualForm.date} onChange={e=>setManualForm(p=>({...p,date:e.target.value}))} style={iStyle}/></FF>
            <FF label="Start Time"><input type="time" step="900" value={manualForm.startAt} onChange={e=>setManualForm(p=>({...p,startAt:e.target.value}))} style={iStyle}/></FF>
            <FF label="End Time"><input type="time" step="900" value={manualForm.endAt} onChange={e=>setManualForm(p=>({...p,endAt:e.target.value}))} style={iStyle}/></FF>
            <FF label="Session Notes (required — describe what you worked on)"><input type="text" value={manualForm.notes} onChange={e=>setManualForm(p=>({...p,notes:e.target.value}))} style={{...iStyle,borderColor:!manualForm.notes?.trim()?C.red:C.border}} placeholder="e.g. Reviewed 45 tasks, onboarding call with new annotators..."/></FF>
          </div>
          <div style={{marginBottom:12,padding:"10px 12px",background:C.blueSoft,border:`1px solid ${C.blue}30`,borderRadius:8,color:C.blueText,fontSize:12}}>Time inputs are interpreted in {viewAbbr}.</div>
          {!isAdmin&&<div style={{marginBottom:12,padding:"10px 12px",background:C.yellowSoft,border:`1px solid ${C.yellow}40`,borderRadius:8,color:C.yellowText,fontSize:12}}>Manual time is submitted as pending and requires admin approval before it appears in approved pay.</div>}
          <button onClick={submitManualTime} style={btnPri}>{isAdmin?"Add Approved Log":"Submit for Approval"}</button>
        </Modal>
      )}

      {editModal&&(
        <Modal title="Edit Time Log" onClose={()=>setEditModal(false)}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
            <FF label="Queue Manager">
              <select value={editForm.qmId} onChange={e=>setEditForm(p=>({...p,qmId:e.target.value}))} style={{...selStyle,opacity:isAdmin?1:0.65,cursor:isAdmin?"pointer":"not-allowed"}} disabled={!isAdmin}>
                {qmsInScope.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </FF>
            <FF label="Start Time"><input type="datetime-local" value={editForm.startTime} onChange={e=>setEditForm(p=>({...p,startTime:e.target.value}))} style={iStyle}/></FF>
            <FF label="End Time"><input type="datetime-local" value={editForm.endTime} onChange={e=>setEditForm(p=>({...p,endTime:e.target.value}))} style={iStyle}/></FF>
            <FF label="Notes"><input type="text" value={editForm.notes} onChange={e=>setEditForm(p=>({...p,notes:e.target.value}))} style={iStyle}/></FF>
          </div>
          {!isAdmin&&<div style={{marginBottom:12,padding:"10px 12px",background:C.yellowSoft,border:`1px solid ${C.yellow}40`,borderRadius:8,color:C.yellowText,fontSize:12}}>Edits to approved logs move them back to pending for admin review.</div>}
          <button onClick={saveEditedLog} style={btnPri}>Save Changes</button>
        </Modal>
      )}

      {rejectModal&&(
        <Modal title="Reject Manual Time" onClose={()=>setRejectModal(false)} width={480}>
          <FF label="Reason (optional)">
            <textarea value={rejectReason} onChange={e=>setRejectReason(e.target.value)} rows={4} style={{...iStyle,resize:"vertical"}} placeholder="Add a reason visible in log history"/>
          </FF>
          <button onClick={rejectManual} style={{...btnPri,background:C.red}}>Reject Request</button>
        </Modal>
      )}
    </div>
  );
}

// ─── APP ROOT ────────────────────────────────────────────────────────────────
export default function App(){
  const [userId,setUserId]=useState(null);
  const [activeTab,setActiveTab]=useState("Dashboard");
  const idsRepairedRef=useRef(false);

  const [experts,setExperts,l1]=useSupabase("experts",EMPTY_LIST);
  const [reviewers,setReviewers,l2]=useSupabase("reviewers",EMPTY_LIST);
  const [opsTeam,setOpsTeam,l3]=useSupabase("ops_team",EMPTY_LIST);
  const [tickets,setTickets,l4]=useSupabaseRows("tickets",EMPTY_LIST,"TKT");
  const [financials,setFinancials,l5]=useSupabase("financials",DEFAULT_FIN);
  const [phaseFinancials,setPhaseFinancials,l6]=useSupabase("phase_financials",EMPTY_OBJECT);
  const [taskTracker,setTaskTracker,l7]=useSupabase("task_tracker",EMPTY_LIST);
  const [rampData,setRampData,l8]=useSupabase("ramp_data",RAMP_DEFAULT);
  const [accessUsers,setAccessUsers,l9]=useSupabase("access_users",EMPTY_LIST);
  const [timeLogs,setTimeLogs,l10]=useSupabaseRows("time_logs",EMPTY_LIST,"TL");
  const [qmSettings,setQmSettings,l11]=useSupabase("qm_settings",EMPTY_LIST);
  const [_availEvents,setAvailEvents,l12]=useSupabase("availability_events",EMPTY_LIST);

  const allLoaded=l1&&l2&&l3&&l4&&l5&&l6&&l7&&l8&&l9&&l10&&l11&&l12;

  const isAdmin=userId==="__admin__";
  const currentUser=accessUsers.find(u=>u.id===userId);
  const visibleTabs=isAdmin?ALL_TABS:currentUser?CONTROLLABLE_TABS.filter(t=>currentUser.tabs?.[t]):[];
  const resolvedActiveTab=visibleTabs.includes(activeTab)?activeTab:(visibleTabs[0]||"Dashboard");

  useEffect(()=>{
    if(!allLoaded||idsRepairedRef.current) return;
    idsRepairedRef.current=true;

    const ticketFix=normalizeIdCollection(tickets,"TKT");
    if(ticketFix.changed) setTickets(ticketFix.items);

    const timeLogFix=normalizeIdCollection(timeLogs,"TL");
    if(timeLogFix.changed) setTimeLogs(timeLogFix.items);
  },[allLoaded,tickets,timeLogs,setTickets,setTimeLogs]);

  const resetAll=()=>{ if(confirm("Reset ALL data? Cannot be undone.")){
    setExperts([]);setReviewers([]);setOpsTeam([]);setTickets([]);
    setFinancials(DEFAULT_FIN);setPhaseFinancials({});setTaskTracker([]);
    setRampData(RAMP_DEFAULT);setAccessUsers([]);
    setTimeLogs([]);setQmSettings([]);setAvailEvents([]);
  }};

  if(!allLoaded) return(
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:20}}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{width:48,height:48,border:`4px solid ${C.border}`,borderTop:`4px solid ${C.blue}`,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
      <div style={{color:C.muted,fontSize:14,fontFamily:"'IBM Plex Sans',sans-serif"}}>Loading dashboard...</div>
      <div style={{color:C.faint,fontSize:12,fontFamily:"'DM Mono',monospace"}}>Connecting to Supabase</div>
    </div>
  );

  if(!userId) return <PinLogin accessUsers={accessUsers} onLogin={setUserId}/>;

  const p={experts,reviewers,opsTeam,tickets,financials,phaseFinancials,taskTracker,rampData};

  const tabContent={
    Dashboard:<DashboardTab {...p}/>,
    Standup:<StandupTab experts={experts} reviewers={reviewers} opsTeam={opsTeam} tickets={tickets} taskTracker={taskTracker} financials={financials}/>,
    Experts:<PersonTab items={experts} setItems={setExperts} type="expert" financials={financials}/>,
    Reviewers:<PersonTab items={reviewers} setItems={setReviewers} type="reviewer" financials={financials}/>,
    "Ops Team":<PersonTab items={opsTeam} setItems={setOpsTeam} type="ops" financials={financials} timeLogs={timeLogs}/>,
    Tickets:<TicketsTab tickets={tickets} setTickets={setTickets} experts={experts} reviewers={reviewers} opsTeam={opsTeam}/>,
    Tasks:<TasksTab taskTracker={taskTracker} setTaskTracker={setTaskTracker}/>,
    Velocity:<VelocityTab taskTracker={taskTracker} rampData={rampData}/>,
    "Quality Control":<QualityTab experts={experts} reviewers={reviewers} financials={financials}/>,
    "Ramp Plan":<RampPlanTab rampData={rampData} setRampData={setRampData}/>,
    Financials:<FinancialsTab experts={experts} reviewers={reviewers} opsTeam={opsTeam} timeLogs={timeLogs} financials={financials} setFinancials={setFinancials} phaseFinancials={phaseFinancials} setPhaseFinancials={setPhaseFinancials} taskTracker={taskTracker}/>,
    Visualizations:<VisualizationsTab experts={experts} reviewers={reviewers} tickets={tickets} financials={financials} taskTracker={taskTracker}/>,
    Risk:<RiskTab experts={experts} reviewers={reviewers} tickets={tickets} financials={financials} opsTeam={opsTeam} timeLogs={timeLogs} taskTracker={taskTracker} rampData={rampData} phaseFinancials={phaseFinancials}/>,
    "Time Tracker":<TimeTrackerTab timeLogs={timeLogs} setTimeLogs={setTimeLogs} qmSettings={qmSettings} setQmSettings={setQmSettings} setAvailEvents={setAvailEvents} opsTeam={opsTeam} accessUsers={accessUsers} currentUser={currentUser} isAdmin={isAdmin}/>,
    Access:<AccessTab accessUsers={accessUsers} setAccessUsers={setAccessUsers}/>,
  };

  return(
    <div style={{minHeight:"100vh",width:"100%",background:C.bg,color:C.text,fontFamily:"'IBM Plex Sans','Segoe UI',system-ui,sans-serif"}}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
      <style>{`
        *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
        html,body,#root{width:100%;overflow-x:hidden;}
        @media(max-width:768px){
          .kpi-grid{grid-template-columns:repeat(2,1fr)!important;}
          .kpi-grid-4{grid-template-columns:repeat(2,1fr)!important;}
          .hide-mobile{display:none!important;}
          .modal-inner{padding:18px!important;width:98vw!important;margin:0 auto;}
          .tab-content{padding:12px 10px!important;}
          .header-stats{display:none!important;}
          table{font-size:12px!important;display:block;overflow-x:auto;-webkit-overflow-scrolling:touch;}
          td,th{padding:7px 8px!important;white-space:nowrap;}
          .two-col-grid{grid-template-columns:1fr!important;}
          .three-col-grid{grid-template-columns:1fr!important;}
          .kanban-grid{grid-template-columns:1fr!important;overflow-x:auto!important;}
          input,select,textarea{font-size:16px!important;}
        }
        @media(max-width:480px){
          .kpi-grid{grid-template-columns:1fr 1fr!important;}
          .kpi-grid-4{grid-template-columns:1fr 1fr!important;}
        }
      `}</style>
      <div style={{background:C.navy,borderBottom:"1px solid #1e40af",position:"sticky",top:0,zIndex:100,width:"100%"}}>
        <div style={{padding:"0 16px",display:"flex",alignItems:"center",justifyContent:"space-between",height:52}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:"#4ade80",boxShadow:"0 0 8px #4ade80",flexShrink:0}}/>
            <span style={{fontWeight:800,fontSize:14,color:"#f1f5f9",whiteSpace:"nowrap"}}>NES Ops Center</span>
            {isAdmin&&<span style={{background:"#dc262620",color:"#fca5a5",borderRadius:6,padding:"2px 8px",fontSize:11,fontWeight:700,flexShrink:0}}>ADMIN</span>}
            {!isAdmin&&currentUser&&<span style={{background:"#ffffff20",color:"#94a3b8",borderRadius:6,padding:"2px 8px",fontSize:11,flexShrink:0,maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{currentUser.name}</span>}
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <span className="header-stats" style={{color:"#94a3b8",fontSize:12,fontFamily:"'DM Mono',monospace"}}>{experts.filter(e=>e.status==="active").length}E · {reviewers.filter(r=>r.status==="active").length}R · {tickets.filter(t=>t.status!=="COMPLETED").length} open</span>
            {isAdmin&&<button onClick={resetAll} style={{background:"transparent",border:"1px solid #334155",borderRadius:7,color:"#94a3b8",padding:"4px 10px",cursor:"pointer",fontSize:11}}>Reset</button>}
            <button onClick={()=>setUserId(null)} style={{background:"transparent",border:"1px solid #334155",borderRadius:7,color:"#94a3b8",padding:"4px 10px",cursor:"pointer",fontSize:11}}>Log Out</button>
          </div>
        </div>
        <div style={{padding:"0 16px",display:"flex",gap:0,overflowX:"auto",width:"100%",boxSizing:"border-box",WebkitOverflowScrolling:"touch"}}>
          {visibleTabs.map(tab=>(
            <button key={tab} onClick={()=>setActiveTab(tab)} style={{background:"none",border:"none",color:resolvedActiveTab===tab?"#60a5fa":"#94a3b8",padding:"9px 12px",cursor:"pointer",fontSize:12,fontWeight:resolvedActiveTab===tab?700:500,borderBottom:resolvedActiveTab===tab?"2px solid #60a5fa":"2px solid transparent",transition:"all 0.12s",whiteSpace:"nowrap",fontFamily:"inherit"}}>
              {tab}
            </button>
          ))}
        </div>
      </div>
      <div className="tab-content" style={{padding:"20px 16px",width:"100%",boxSizing:"border-box"}}>
        {tabContent[resolvedActiveTab]||<div style={{color:C.muted,textAlign:"center",padding:60}}>Access denied.</div>}
      </div>
    </div>
  );
}
