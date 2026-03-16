/**
 * analysis.js — прогноз по вес/час и подбор персонала
 */

import { el, normalizeFio, getCompanyByFio } from './utils.js';
import * as api from './api.js';

function nowDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function parseNum(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function formatHours(h) {
  const totalMin = Math.round(h * 60);
  if (!Number.isFinite(totalMin) || totalMin <= 0) return '—';
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours <= 0) return `${mins}м`;
  return `${hours}ч ${String(mins).padStart(2, '0')}м`;
}

function formatTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function buildDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [hh, mm] = String(timeStr).split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const d = new Date(dateStr + 'T00:00:00');
  d.setHours(hh, mm, 0, 0);
  return d;
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getBreakMinutesBetween(start, end, breaks) {
  if (!start || !end || !breaks || !breaks.length) return 0;
  if (end <= start) return 0;
  let minutes = 0;
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  for (let d = new Date(day); d <= endDay; d.setDate(d.getDate() + 1)) {
    const dateStr = toDateStr(d);
    for (const br of breaks) {
      if (!br || !br.start || !br.duration) continue;
      const dur = Number(br.duration) || 0;
      if (dur <= 0) continue;
      const bStart = buildDateTime(dateStr, br.start);
      if (!bStart) continue;
      const bEnd = new Date(bStart.getTime() + dur * 60 * 1000);
      const from = Math.max(start.getTime(), bStart.getTime());
      const to = Math.min(end.getTime(), bEnd.getTime());
      if (to > from) minutes += (to - from) / 60000;
    }
  }
  return minutes;
}

function computeFinishWithBreaks(start, workHours, breaks) {
  if (!start || !Number.isFinite(workHours) || workHours <= 0) return null;
  let finish = new Date(start.getTime() + workHours * 60 * 60 * 1000);
  let prevBreak = -1;
  for (let i = 0; i < 3; i += 1) {
    const breakMinutes = getBreakMinutesBetween(start, finish, breaks);
    if (breakMinutes === prevBreak) break;
    prevBreak = breakMinutes;
    finish = new Date(start.getTime() + workHours * 60 * 60 * 1000 + breakMinutes * 60 * 1000);
  }
  return finish;
}

function getHoursAvailable(start, target) {
  if (!start || !target) return null;
  let diff = target.getTime() - start.getTime();
  if (diff <= 0) diff += 24 * 60 * 60 * 1000;
  return diff / (60 * 60 * 1000);
}

function updateRow(row, ctx) {
  const volume = parseNum(row.querySelector('.analysis-volume')?.value);
  const avgRate = parseNum(row.querySelector('.analysis-peak')?.value);
  const people = parseNum(row.querySelector('.analysis-people')?.value);
  const targetTime = row.querySelector('.analysis-target')?.value || '';
  const rowStartTime = row.querySelector('.analysis-start')?.value || '';

  const durationCell = row.querySelector('.analysis-duration');
  const finishCell = row.querySelector('.analysis-finish');
  const needPeopleCell = row.querySelector('.analysis-need-people');
  const requiredCell = row.querySelector('.analysis-required');

  const start = buildDateTime(ctx.dateStr, rowStartTime || ctx.startTime) || ctx.start;
  const target = buildDateTime(ctx.dateStr, targetTime);
  const hoursAvailableRaw = getHoursAvailable(start, target);
  const breakMinutes = hoursAvailableRaw ? getBreakMinutesBetween(start, target, ctx.breaks) : 0;
  const hoursAvailable = hoursAvailableRaw ? Math.max(0, hoursAvailableRaw - breakMinutes / 60) : null;
  const canCalc = volume > 0 && avgRate > 0;
  const workHoursNeeded = canCalc && people > 0 ? volume / (avgRate * people) : (canCalc ? volume / avgRate : 0);
  const finish = (canCalc && people > 0 && start)
    ? computeFinishWithBreaks(start, workHoursNeeded, ctx.breaks)
    : null;

  if (durationCell) {
    if (canCalc && people > 0 && finish && start) {
      durationCell.textContent = formatHours((finish.getTime() - start.getTime()) / (60 * 60 * 1000));
    } else {
      durationCell.textContent = '—';
    }
  }

  if (finishCell) {
    finishCell.textContent = finish ? formatTime(finish) : '—';
  }

  if (requiredCell) {
    if (volume > 0 && hoursAvailable && hoursAvailable > 0) {
      requiredCell.textContent = String(Math.ceil(volume / hoursAvailable));
    } else {
      requiredCell.textContent = '—';
    }
  }

  if (needPeopleCell) {
    if (canCalc && hoursAvailable && hoursAvailable > 0) {
      const need = Math.ceil(volume / (avgRate * hoursAvailable));
      needPeopleCell.textContent = String(need);
    } else {
      needPeopleCell.textContent = '—';
    }
  }
}

function updateAll() {
  const dateStr = el('analysis-date')?.value || nowDateStr();
  const startTime = el('analysis-start-time')?.value || '09:00';
  const start = buildDateTime(dateStr, startTime);
  const breaks = readBreakRules();

  const rows = document.querySelectorAll('#analysis-rows tr');
  rows.forEach(row => updateRow(row, { start, dateStr, startTime, breaks }));
  savePlanToStorage(dateStr, startTime);
}

function getOpsFromTable(dateStr, defaultStartTime, breaks) {
  const rows = document.querySelectorAll('#analysis-rows tr');
  const ops = [];
  rows.forEach(row => {
    const name = row.querySelector('td')?.textContent || '';
    const key = row.dataset.op || '';
    const volume = parseNum(row.querySelector('.analysis-volume')?.value);
    const avgRate = parseNum(row.querySelector('.analysis-peak')?.value);
    const manualPeople = parseNum(row.querySelector('.analysis-people')?.value);
    const targetTime = row.querySelector('.analysis-target')?.value || '';
    const startTime = row.querySelector('.analysis-start')?.value || '';
    const start = buildDateTime(dateStr, startTime || defaultStartTime);
    const target = buildDateTime(dateStr, targetTime);
    const hoursAvailableRaw = getHoursAvailable(start, target);
    const breakMinutes = hoursAvailableRaw ? getBreakMinutesBetween(start, target, breaks) : 0;
    const hoursAvailable = hoursAvailableRaw ? Math.max(0, hoursAvailableRaw - breakMinutes / 60) : null;
    const requiredWeightPerHour = (volume > 0 && hoursAvailable && hoursAvailable > 0)
      ? Math.ceil(volume / hoursAvailable)
      : 0;
    const calcPeople = (volume > 0 && hoursAvailable && hoursAvailable > 0 && avgRate > 0)
      ? Math.ceil(volume / (avgRate * hoursAvailable))
      : 0;
    // используем ручное кол-во людей если расчётное = 0
    const requiredPeople = calcPeople > 0 ? calcPeople : manualPeople;
    ops.push({
      name,
      key,
      volume,
      avgRate,
      manualPeople,
      targetTime,
      startTime,
      requiredWeightPerHour,
      requiredPeople,
    });
  });
  return ops;
}

// Зоны для каждого типа операции
const OP_ZONES = {
  storage_dry:  ['SH'],
  storage_cold: ['HH'],
  crossdock_dry:  ['KDS'],
  crossdock_cold: ['KDH'],
};

function calcZoneAffinity(emp, zones) {
  if (!zones || !zones.length) return 0;
  const bz = emp.byZone && typeof emp.byZone === 'object' ? emp.byZone : {};
  let totalCount = 0;
  let totalWg = 0;
  let zoneCount = 0;
  let zoneWg = 0;
  for (const [zk, zv] of Object.entries(bz)) {
    const cnt = Number(zv.count) || 0;
    const wg = Number(zv.weightGrams) || 0;
    totalCount += cnt;
    totalWg += wg;
    if (zones.includes(zk)) {
      zoneCount += cnt;
      zoneWg += wg;
    }
  }
  if (totalCount === 0) return 0;
  const scoreCnt = zoneCount / totalCount;
  const scoreWg = totalWg > 0 ? zoneWg / totalWg : scoreCnt;
  return (scoreCnt + scoreWg) / 2;
}

function pickStaffForOperations(ops, employees, dateStr, defaultStartTime) {
  const opOrder = ops
    .filter(o => o.requiredPeople > 0)
    .map(o => {
      const start = buildDateTime(dateStr, o.startTime || defaultStartTime);
      const target = buildDateTime(dateStr, o.targetTime || '');
      const hoursAvailable = getHoursAvailable(start, target);
      return { ...o, hoursAvailable: hoursAvailable || null };
    })
    .sort((a, b) => {
      const aStorage = String(a.key || '').startsWith('storage');
      const bStorage = String(b.key || '').startsWith('storage');
      if (aStorage !== bStorage) return aStorage ? -1 : 1;
      const ta = a.hoursAvailable || Infinity;
      const tb = b.hoursAvailable || Infinity;
      if (ta !== tb) return ta - tb;
      return b.requiredWeightPerHour - a.requiredWeightPerHour;
    });

  const assigned = new Set();
  const results = [];

  for (const op of opOrder) {
    const zones = OP_ZONES[op.key] || [];
    const hasZoneData = employees.some(e => e.byZone && Object.keys(e.byZone).length > 0);

    // Сортируем оставшихся кандидатов: сначала по affinity к зонам, потом по szPerHour
    const candidates = employees
      .filter(e => !assigned.has(e.name))
      .map(e => {
        const affinity = hasZoneData ? calcZoneAffinity(e, zones) : 0;
        return { ...e, _affinity: affinity };
      })
      .sort((a, b) => {
        if (Math.abs(b._affinity - a._affinity) > 0.01) return b._affinity - a._affinity;
        return b.szPerHour - a.szPerHour;
      });

    const picked = [];
    for (const emp of candidates) {
      if (picked.length >= op.requiredPeople) break;
      assigned.add(emp.name);
      picked.push({ ...emp });
    }
    const sumPeople = picked.length;
    results.push({
      name: op.name,
      requiredPeople: op.requiredPeople,
      requiredWeightPerHour: op.requiredWeightPerHour,
      picked,
      sumPeople,
      ok: sumPeople >= op.requiredPeople,
    });
  }
  return results;
}

function renderAssignments(assignments) {
  const body = el('analysis-assign-body');
  if (!body) return;
  if (!assignments || !assignments.length) {
    body.innerHTML = '<tr><td colspan="5" class="analysis-empty">Нет данных для подбора</td></tr>';
    return;
  }
  body.innerHTML = assignments.map(a => {
    const requiredKgPerPerson = (a.requiredWeightPerHour > 0 && a.sumPeople > 0)
      ? a.requiredWeightPerHour / a.sumPeople
      : 0;

    const list = a.picked.map(p => {
      const aff = Number(p._affinity || 0);
      const affStr = aff > 0 ? ` · з${Math.round(aff * 100)}%` : '';
      const empKg = Number(p.kgPerHour || 0);
      const behindStr = (!a.ok && requiredKgPerPerson > 0 && empKg > 0 && empKg < requiredKgPerPerson)
        ? ` <span class="analysis-chip-warn">нужно ${requiredKgPerPerson.toFixed(1)}</span>`
        : '';
      return `<span class="analysis-chip">${p.name} · ${empKg > 0 ? empKg.toFixed(1) + ' кг/ч' : Number(p.szPerHour || 0).toFixed(1)}${affStr}</span>${behindStr}`;
    }).join('') || '—';

    let statusHtml;
    if (a.ok) {
      statusHtml = '<span class="analysis-status-ok">Хватает</span>';
    } else {
      const behind = a.picked.filter(p => {
        const empKg = Number(p.kgPerHour || 0);
        return requiredKgPerPerson > 0 && empKg > 0 && empKg < requiredKgPerPerson;
      });
      const behindNames = behind.length
        ? `<div class="analysis-status-detail">Ускорить: ${behind.map(p => `${p.name.split(' ')[0]} (нужно ${requiredKgPerPerson.toFixed(1)} кг/ч)`).join(', ')}</div>`
        : '';
      statusHtml = `<span class="analysis-status-warn">Не хватает</span>${behindNames}`;
    }

    return `
      <tr>
        <td>${a.name}</td>
        <td>${a.requiredPeople}</td>
        <td>${list}</td>
        <td>${a.sumPeople}</td>
        <td>${statusHtml}</td>
      </tr>`;
  }).join('');
}

function buildTransferBuckets(assignment, normSzPerHour, weakMovePercent) {
  const people = assignment.picked || [];
  const passed = people.filter(p => (Number(p.szPerHour) || 0) >= normSzPerHour);
  const weak = people.filter(p => (Number(p.szPerHour) || 0) < normSzPerHour);
  const moveWeakCount = Math.max(0, Math.floor(weak.length * (Math.max(0, Math.min(100, weakMovePercent)) / 100)));
  const weakSorted = weak.slice().sort((x, y) => (y.szPerHour - x.szPerHour));
  const weakMove = weakSorted.slice(0, moveWeakCount);
  const weakStay = weakSorted.slice(moveWeakCount);
  return {
    passed,
    weakMove,
    weakStay,
    move: [...passed, ...weakMove],
    stay: weakStay,
  };
}

function renderTransferPlan(plan) {
  const body = el('analysis-transfer-body');
  if (!body) return;
  if (!plan || !plan.length) {
    body.innerHTML = '<tr><td colspan="5" class="analysis-empty">Нет данных для подбора</td></tr>';
    return;
  }
  body.innerHTML = plan.map(p => {
    const passedText = `${p.passedCount}/${p.totalCount}`;
    const stayList = p.stay.map(x => `<div class="analysis-chip analysis-chip--muted">${x.name}</div>`).join('') || '—';
    const moveList = p.move.map(x => `<div class="analysis-chip">${x.name}</div>`).join('') || '—';
    return `
      <tr>
        <td>${p.name}</td>
        <td>${p.finishTime || '—'}</td>
        <td>${passedText}</td>
        <td>${stayList}</td>
        <td>${moveList}</td>
      </tr>`;
  }).join('');
}

function renderScheduleChart(timeline, ops) {
  const wrap = el('analysis-schedule-chart');
  if (!wrap) return;
  if (!timeline || !timeline.length) {
    wrap.innerHTML = '<div class="analysis-empty">Нет данных</div>';
    return;
  }
  const opOrder = ops.map(o => o.name);
  const maxCount = timeline.reduce((m, t) => {
    const vals = opOrder.map(n => Number(t.counts?.[n] || 0));
    return Math.max(m, ...vals, 1);
  }, 1);

  const hourLabels = timeline.map(t => {
    const d = t.time;
    const h = String(d.getHours()).padStart(2, '0');
    return `${h}:00`;
  });

  wrap.innerHTML = opOrder.map(opName => {
    const bars = timeline.map((t, idx) => {
      const v = Number(t.counts?.[opName] || 0);
      const pct = Math.round((v / maxCount) * 100);
      return `
        <div class="analysis-hour">
          <div class="analysis-hour-label">${hourLabels[idx]}</div>
          <div class="analysis-hour-bar">
            <div class="analysis-hour-fill" style="width:${pct}%"></div>
            <div class="analysis-hour-value">${v}</div>
          </div>
        </div>`;
    }).join('');
    return `
      <div class="analysis-schedule-row">
        <div class="analysis-schedule-op">${opName}</div>
        <div class="analysis-schedule-bars">${bars}</div>
      </div>`;
  }).join('');
}

function buildTransferPlan(assignments, ops, dateStr, defaultStartTime, normSzPerHour, weakMovePercent, breaks) {
  const opsByName = new Map(ops.map(o => [o.name, o]));
  const plan = [];
  for (const a of assignments) {
    const op = opsByName.get(a.name);
    const people = a.picked || [];
    const totalCount = people.length;
    const buckets = buildTransferBuckets(a, normSzPerHour, weakMovePercent);

    const start = buildDateTime(dateStr, (op?.startTime || '') || defaultStartTime);
    let finishTime = '';
    if (op && op.volume > 0 && start && totalCount > 0 && op.avgRate > 0) {
      const hours = op.volume / (op.avgRate * totalCount);
      const finish = computeFinishWithBreaks(start, hours, breaks);
      finishTime = finish ? formatTime(finish) : '';
    }

    const move = buckets.move.map(x => ({ name: x.name }));
    const stay = buckets.stay.map(x => ({ name: x.name }));
    plan.push({
      name: a.name,
      finishTime,
      passedCount: buckets.passed.length,
      totalCount,
      stay,
      move,
    });
  }
  return plan;
}

function computeFinishTime(op, assignment, dateStr, defaultStartTime, breaks) {
  const peopleCount = assignment?.picked?.length || 0;
  if (!op || !assignment || !op.volume || !op.avgRate || peopleCount <= 0) return null;
  const start = buildDateTime(dateStr, (op.startTime || '') || defaultStartTime);
  if (!start) return null;
  const hours = op.volume / (op.avgRate * peopleCount);
  return computeFinishWithBreaks(start, hours, breaks);
}

function getAllowedTargets(sourceKey) {
  if (sourceKey === 'storage_dry') return new Set(['crossdock_dry', 'crossdock_cold']);
  if (sourceKey === 'storage_cold') return new Set(['crossdock_cold']);
  return new Set();
}

function simulatePlan(assignments, ops, dateStr, defaultStartTime, normSzPerHour, weakMovePercent, breaks) {
  const opsByName = new Map(ops.map(o => [o.name, o]));
  const state = new Map();
  const peopleByOp = new Map();
  const finishTimes = new Map();
  const timeline = [];

  // личная цель каждого сотрудника: равная доля объёма его операции
  const empPersonalTarget = new Map(); // empName -> { target, accumulated, sourceOpName }

  for (const a of assignments) {
    const op = opsByName.get(a.name);
    const volume = Number(op?.volume) || 0;
    const numPeople = (a.picked || []).length;
    const perPerson = numPeople > 0 && volume > 0 ? volume / numPeople : Infinity;
    state.set(a.name, {
      remaining: volume,
      start: buildDateTime(dateStr, (op?.startTime || '') || defaultStartTime),
      target: buildDateTime(dateStr, op?.targetTime || ''),
      rate: Number(op?.avgRate) || 0,
      key: op?.key || '',
    });
    peopleByOp.set(a.name, [...(a.picked || [])]);
    for (const emp of (a.picked || [])) {
      empPersonalTarget.set(emp.name, { target: perPerson, accumulated: 0, sourceOpName: a.name });
    }
  }

  const lunchRules = readLunchRules();
  const startTimes = [...state.values()].map(s => s.start).filter(Boolean);
  const simStart = startTimes.length ? new Date(Math.min(...startTimes.map(d => d.getTime()))) : buildDateTime(dateStr, defaultStartTime) || new Date();
  const simEnd = new Date(simStart.getTime() + 24 * 60 * 60 * 1000);

  const getAllowedTargets = (sourceKey) => {
    if (sourceKey === 'storage_dry') return new Set(['crossdock_dry', 'crossdock_cold']);
    if (sourceKey === 'storage_cold') return new Set(['crossdock_cold']);
    return new Set();
  };

  const prioritizeOps = (remainingNames) => {
    const list = [];
    for (const name of remainingNames) {
      const st = state.get(name);
      const hoursAvailable = getHoursAvailable(st?.start, st?.target) || Infinity;
      list.push({ name, hoursAvailable, isStorage: String(st?.key || '').startsWith('storage') });
    }
    list.sort((a, b) => {
      if (a.isStorage !== b.isStorage) return a.isStorage ? -1 : 1;
      if (a.hoursAvailable !== b.hoursAvailable) return a.hoursAvailable - b.hoursAvailable;
      const aa = assignments.find(x => x.name === a.name)?.requiredWeightPerHour || 0;
      const bb = assignments.find(x => x.name === b.name)?.requiredWeightPerHour || 0;
      return bb - aa;
    });
    return list.map(x => x.name);
  };

  let t = new Date(simStart);
  while (t <= simEnd) {
    // snapshot counts at hour start
    const counts = {};
    for (const [name, list] of peopleByOp) {
      counts[name] = (list || []).length;
    }
    timeline.push({ time: new Date(t), counts });

    // 1) производительность за час — отслеживаем вклад каждого сотрудника
    const hourEnd = new Date(t.getTime() + 60 * 60 * 1000);
    const breakMinutes = getBreakMinutesBetween(t, hourEnd, breaks);
    const breakFactor = Math.max(0, 1 - breakMinutes / 60);
    for (const [name, st] of state) {
      if (st.remaining <= 0 || !st.start) continue;
      if (t < st.start) continue;
      const people = peopleByOp.get(name) || [];
      let sum = 0;
      for (const p of people) {
        const company = getCompanyByFio(analysisEmplMap, normalizeFio(p.name || '')) || '';
        const rule = company ? lunchRules.get(company) : null;
        let factor = 1;
        if (rule) {
          const lunchStart = buildDateTime(dateStr, rule.start);
          const lunchEnd = lunchStart ? new Date(lunchStart.getTime() + rule.duration * 60 * 1000) : null;
          if (lunchStart && lunchEnd && t >= lunchStart && t < lunchEnd) {
            factor = 1 - (rule.percent / 100);
          }
        }
        const contrib = st.rate * factor * breakFactor;
        sum += contrib;
        // накапливаем личный прогресс
        const ep = empPersonalTarget.get(p.name);
        if (ep && ep.sourceOpName === name) ep.accumulated += contrib;
      }
      st.remaining = Math.max(0, st.remaining - sum);
      if (st.remaining <= 0 && !finishTimes.has(name)) {
        finishTimes.set(name, new Date(t.getTime() + 60 * 60 * 1000));
      }
    }

    // 2) перевод сотрудников выполнивших личную цель в КДК
    for (const [name, st] of state) {
      if (!st.start || t < st.start) continue;
      const allowedTargets = getAllowedTargets(st.key);
      if (!allowedTargets.size) continue; // только хранение может отдавать людей

      const people = peopleByOp.get(name) || [];
      const toKeep = [];
      const toTransfer = [];

      for (const emp of people) {
        const ep = empPersonalTarget.get(emp.name);
        if (ep && ep.target < Infinity && ep.accumulated >= ep.target) {
          toTransfer.push(emp);
        } else {
          toKeep.push(emp);
        }
      }

      if (!toTransfer.length) continue;
      peopleByOp.set(name, toKeep);

      // распределяем высвободившихся по КДК (приоритет — КДК с ближайшей целью)
      const kdkNames = [...state.keys()].filter(n => {
        const kst = state.get(n);
        return n !== name && (kst?.remaining || 0) > 0 && allowedTargets.has(kst?.key || '');
      });
      const order = prioritizeOps(kdkNames);
      let pool = [...toTransfer];
      for (const opName of order) {
        if (!pool.length) break;
        const targetList = peopleByOp.get(opName);
        if (!targetList) continue;
        while (pool.length) {
          const emp = pool.shift();
          targetList.push({ ...emp });
          // обнуляем личный счётчик для новой операции
          const ep = empPersonalTarget.get(emp.name);
          if (ep) { ep.accumulated = 0; ep.target = Infinity; ep.sourceOpName = opName; }
        }
      }
    }

    // 3) перевод всей команды когда вся операция завершена (fallback)
    for (const [name, st] of state) {
      if (st.remaining > 0) continue;
      if (!finishTimes.has(name)) continue;
      const finishedAt = finishTimes.get(name);
      if (finishedAt && finishedAt.getTime() !== t.getTime() + 60 * 60 * 1000) continue;
      if (st.target && finishedAt && finishedAt > st.target) continue;
      const currentPeople = peopleByOp.get(name) || [];
      if (!currentPeople.length) continue;
      const buckets = buildTransferBuckets({ picked: currentPeople }, normSzPerHour, weakMovePercent);
      const allowedTargets = getAllowedTargets(st.key);
      if (!allowedTargets.size) continue;
      const pool = [...buckets.move];
      const remainingNames = [...state.keys()].filter(n => n !== name && (state.get(n)?.remaining || 0) > 0);
      const order = prioritizeOps(remainingNames);
      for (const opName of order) {
        const targetState = state.get(opName);
        if (!targetState || !allowedTargets.has(targetState.key)) continue;
        if (!pool.length) break;
        while (pool.length) {
          const emp = pool.shift();
          peopleByOp.get(opName)?.push({ ...emp });
          if (!pool.length) break;
        }
      }
    }

    t = new Date(t.getTime() + 60 * 60 * 1000);
    const unfinished = [...state.values()].some(s => s.remaining > 0);
    if (!unfinished) break;
  }

  const results = new Map();
  for (const [name, st] of state) {
    const finish = finishTimes.get(name) || null;
    const okByTarget = st.target ? (finish && finish <= st.target) : (st.remaining <= 0);
    results.set(name, { finish, okByTarget });
  }
  return { results, timeline };
}

function autoRedistribute(assignments, ops, dateStr, defaultStartTime, normSzPerHour, weakMovePercent, breaks) {
  const opsByName = new Map(ops.map(o => [o.name, o]));
  const work = assignments.map(a => ({ ...a, picked: [...(a.picked || [])], sumPeople: (a.picked || []).length }));
  const finishList = work.map(a => {
    const op = opsByName.get(a.name);
    return { name: a.name, finish: computeFinishTime(op, a, dateStr, defaultStartTime, breaks) };
  }).filter(x => x.finish);
  finishList.sort((a, b) => a.finish - b.finish);

  const byName = new Map(work.map(w => [w.name, w]));
  const remaining = new Set(work.map(w => w.name));

  const prioritizeOps = () => {
    const list = [];
    for (const name of remaining) {
      const op = opsByName.get(name);
      const start = buildDateTime(dateStr, (op?.startTime || '') || defaultStartTime);
      const target = buildDateTime(dateStr, op?.targetTime || '');
      const hoursAvailable = getHoursAvailable(start, target) || Infinity;
      list.push({ name, hoursAvailable });
    }
    list.sort((a, b) => {
      if (a.hoursAvailable !== b.hoursAvailable) return a.hoursAvailable - b.hoursAvailable;
      const aa = byName.get(a.name)?.requiredWeightPerHour || 0;
      const bb = byName.get(b.name)?.requiredWeightPerHour || 0;
      return bb - aa;
    });
    return list.map(x => x.name);
  };

  for (const done of finishList) {
    const finished = byName.get(done.name);
    if (!finished) continue;
    remaining.delete(done.name);
    const sourceOp = opsByName.get(done.name);
    const allowedTargets = getAllowedTargets(sourceOp?.key || '');
    if (!allowedTargets.size) continue;
    // перевод только если цель выполнена вовремя
    const sourceTarget = buildDateTime(dateStr, sourceOp?.targetTime || '');
    if (sourceTarget && done.finish && done.finish > sourceTarget) continue;
    const buckets = buildTransferBuckets(finished, normSzPerHour, weakMovePercent);
    const transferable = [...buckets.move];

    const order = prioritizeOps();
    for (const opName of order) {
      const targetOp = opsByName.get(opName);
      if (!targetOp || !allowedTargets.has(targetOp.key)) continue;
      const targetAssign = byName.get(opName);
      if (!targetAssign) continue;
      const need = Math.max(0, (targetAssign.requiredPeople || 0) - (targetAssign.sumPeople || 0));
      if (need <= 0) continue;
      while (transferable.length && targetAssign.sumPeople < targetAssign.requiredPeople) {
        const emp = transferable.shift();
        targetAssign.picked.push({ ...emp });
        targetAssign.sumPeople = (targetAssign.sumPeople || 0) + 1;
      }
    }
  }
  return work;
}

async function handlePickStaff() {
  const dateStr = el('analysis-date')?.value || nowDateStr();
  const startTime = el('analysis-start-time')?.value || '09:00';
  const breaks = readBreakRules();
  const from = el('analysis-history-from')?.value || dateStr;
  const to = el('analysis-history-to')?.value || dateStr;
  const shift = el('analysis-history-shift')?.value || 'day';
  const idleThreshold = parseNum(el('analysis-history-idle')?.value || 15);
  const res = await api.getAnalysisEmployeeRates({
    dateFrom: from,
    dateTo: to,
    shift,
    idleThresholdMinutes: idleThreshold,
  });
  const statusEl = el('analysis-pick-status');
  const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };
  if (!res || res.error) {
    setStatus(`Ошибка API: ${res?.error || 'нет ответа'}`);
    renderAssignments([]);
    return;
  }
  let employees = Array.isArray(res.employees) ? res.employees : [];
  if (!employees.length) {
    setStatus(`Нет данных о сотрудниках за период ${from} — ${to} (смена: ${shift})`);
    renderAssignments([]);
    renderTransferPlan([]);
    return;
  }
  const selectedCompanies = Array.from(document.querySelectorAll('.analysis-company-check'))
    .filter(chk => chk.checked)
    .map(chk => chk.value)
    .filter(Boolean);
  if (selectedCompanies.length && analysisEmplMap && analysisEmplMap.size) {
    const allowed = new Set(selectedCompanies.map(s => s.trim().toLowerCase()));
    employees = employees.filter(emp => {
      const name = emp.name || '';
      const company = getCompanyByFio(analysisEmplMap, normalizeFio(name)) || '';
      return company && allowed.has(company.trim().toLowerCase());
    });
  }
  if (!employees.length) {
    setStatus('Нет сотрудников после фильтра по компании');
    renderAssignments([]);
    renderTransferPlan([]);
    return;
  }
  // определяем доминантную зону каждого сотрудника → привязываем к операции
  const ZONE_TO_OP = { SH: 'storage_dry', HH: 'storage_cold', KDS: 'crossdock_dry', KDH: 'crossdock_cold' };
  const empCountByOp = {};
  const ratesByOp = {};
  for (const emp of employees) {
    let domZone = null;
    let domKg = 0;
    if (emp.kgPerHourByZone) {
      for (const [zk, kg] of Object.entries(emp.kgPerHourByZone)) {
        if (Number(kg) > domKg) { domKg = Number(kg); domZone = zk; }
      }
    }
    const opKey = domZone ? (ZONE_TO_OP[domZone] || null) : null;
    if (!opKey) continue;
    empCountByOp[opKey] = (empCountByOp[opKey] || 0) + 1;
    if (!ratesByOp[opKey]) ratesByOp[opKey] = [];
    const zoneKg = Number(emp.kgPerHourByZone?.[domZone]) || Number(emp.kgPerHour) || 0;
    if (zoneKg > 0) ratesByOp[opKey].push(zoneKg);
  }

  document.querySelectorAll('#analysis-rows tr').forEach(row => {
    const key = row.dataset.op || '';
    const volume = parseNum(row.querySelector('.analysis-volume')?.value);
    const targetTime = row.querySelector('.analysis-target')?.value || '';
    const rowStartTime = row.querySelector('.analysis-start')?.value || '';
    const rowStart = buildDateTime(dateStr, rowStartTime || startTime);
    const rowTarget = buildDateTime(dateStr, targetTime);
    const hoursAvailableRaw = getHoursAvailable(rowStart, rowTarget);
    const brkMin = hoursAvailableRaw ? getBreakMinutesBetween(rowStart, rowTarget, breaks) : 0;
    const hoursAvailable = hoursAvailableRaw ? Math.max(0, hoursAvailableRaw - brkMin / 60) : null;

    // авто-кол-во людей (если не задано)
    const peopleInput = row.querySelector('.analysis-people');
    if (peopleInput && parseNum(peopleInput.value) === 0) {
      const count = empCountByOp[key] || 0;
      if (count > 0) peopleInput.value = String(count);
    }

    // авто-темп: считаем сколько нужно кг/час чтобы успеть
    const peakInput = row.querySelector('.analysis-peak');
    if (peakInput && parseNum(peakInput.value) === 0) {
      const people = parseNum(peopleInput?.value);
      if (volume > 0 && people > 0 && hoursAvailable && hoursAvailable > 0) {
        const requiredRate = volume / (people * hoursAvailable);
        peakInput.value = requiredRate.toFixed(1);
      }
    }
  });
  updateAll();

  const ops = getOpsFromTable(dateStr, startTime, breaks);
  const opsWithPeople = ops.filter(o => o.requiredPeople > 0);
  if (!opsWithPeople.length) {
    setStatus('Не заданы операции: укажите объём и кол-во человек (или цель и темп)');
    renderAssignments([]);
    renderTransferPlan([]);
    return;
  }
  setStatus(`Подобрано из ${employees.length} сотрудников`);
  const assignments = pickStaffForOperations(ops, employees, dateStr, startTime);
  const normSz = Math.max(0, parseNum(el('analysis-norm-sz')?.value || 0));
  const weakMovePercent = Math.max(0, parseNum(el('analysis-weak-move')?.value || 0));
  const redistributed = autoRedistribute(assignments, ops, dateStr, startTime, normSz, weakMovePercent, breaks);
  const sim = simulatePlan(redistributed, ops, dateStr, startTime, normSz, weakMovePercent, breaks);
  const withStatus = redistributed.map(a => {
    const s = sim.results.get(a.name);
    return { ...a, ok: s ? !!s.okByTarget : a.ok };
  });
  renderAssignments(withStatus);
  window.__analysisAssignments = withStatus;
  const transferPlan = buildTransferPlan(assignments, ops, dateStr, startTime, normSz, weakMovePercent, breaks);
  renderTransferPlan(transferPlan);
  renderScheduleChart(sim.timeline, ops);
}

async function fillPlanFromDayStats() {
  try {
    const dateStr = el('analysis-date')?.value || nowDateStr();
    const shift = el('analysis-history-shift')?.value || 'day';
    const idleThreshold = parseNum(el('analysis-history-idle')?.value || 15);
    const summary = await api.getDateSummary(dateStr, { shift, idleThresholdMinutes: idleThreshold });
    if (!summary || summary.error) return;
    const hourly = Array.isArray(summary.hourly) ? summary.hourly : [];
    const totalStorage = hourly.reduce((s, h) => s + (Number(h.storageOps) || 0), 0);
    const totalKdk = hourly.reduce((s, h) => s + (Number(h.kdkOps) || 0), 0);
    const rows = document.querySelectorAll('#analysis-rows tr');
    rows.forEach(row => {
      const key = row.dataset.op || '';
      if (key === 'storage_dry') {
        const inp = row.querySelector('.analysis-volume');
        if (inp) inp.value = String(totalStorage);
      }
      if (key === 'crossdock_dry') {
        const inp = row.querySelector('.analysis-volume');
        if (inp) inp.value = String(totalKdk);
      }
    });
    updateAll();
  } catch (_) { /* ignore */ }
}

let historyTouched = false;
let analysisEmplMap = new Map();
let analysisCompanies = [];
let analysisBreaks = [];
let analysisBreakTemplates = [];

function setHistoryDatesIfEmpty(dateStr) {
  const historyFrom = el('analysis-history-from');
  const historyTo = el('analysis-history-to');
  if (historyFrom && !historyFrom.value) historyFrom.value = dateStr;
  if (historyTo && !historyTo.value) historyTo.value = dateStr;
}

function bindHistoryTouched() {
  const historyFrom = el('analysis-history-from');
  const historyTo = el('analysis-history-to');
  if (historyFrom) historyFrom.addEventListener('input', () => { historyTouched = true; });
  if (historyTo) historyTo.addEventListener('input', () => { historyTouched = true; });
}

async function loadCompaniesForAnalysis() {
  try {
    const res = await api.getEmployees();
    const list = Array.isArray(res.employees) ? res.employees : [];
    const map = new Map();
    const companies = new Set();
    for (const e of list) {
      const fio = (e.fio || '').trim();
      const company = (e.company || '').trim();
      if (fio) map.set(normalizeFio(fio), company);
      if (company) companies.add(company);
    }
    analysisEmplMap = map;
    analysisCompanies = [...companies].sort((a, b) => a.localeCompare(b, 'ru'));
    const listEl = el('analysis-companies-list');
    if (listEl) {
      listEl.innerHTML = analysisCompanies.length
        ? analysisCompanies.map(c => `
          <label class="analysis-company-item">
            <input type="checkbox" class="analysis-company-check" value="${c}">
            ${c}
          </label>`).join('')
        : '<span class="analysis-empty">Нет компаний</span>';
    }
    renderLunchList();
  } catch (_) { /* ignore */ }
}

function renderLunchList() {
  const wrap = el('analysis-lunch-list');
  if (!wrap) return;
  if (!analysisCompanies.length) {
    wrap.innerHTML = '<div class="analysis-empty">Нет компаний</div>';
    return;
  }
  const head = `
    <div class="analysis-lunch-head">Компания</div>
    <div class="analysis-lunch-head">Старт</div>
    <div class="analysis-lunch-head">Длительность, мин</div>
    <div class="analysis-lunch-head">Доля, %</div>
    <div class="analysis-lunch-head">Вкл</div>`;
  const rows = analysisCompanies.map(c => `
    <div class="analysis-lunch-row">
      <div>${c}</div>
      <input type="time" class="form-control analysis-lunch-start" data-company="${c}">
      <input type="number" class="form-control analysis-lunch-duration" data-company="${c}" min="0" step="5" value="60">
      <input type="number" class="form-control analysis-lunch-percent" data-company="${c}" min="0" max="100" step="10" value="100">
      <label class="analysis-company-item"><input type="checkbox" class="analysis-lunch-enabled" data-company="${c}"> включить</label>
    </div>`).join('');
  wrap.innerHTML = head + rows;
}

function renderBreakList(breaks) {
  const listEl = el('analysis-breaks-list');
  if (!listEl) return;
  const items = Array.isArray(breaks) ? breaks : [];
  analysisBreaks = items.map(b => ({
    start: String(b?.start || ''),
    duration: Number(b?.duration) || 0,
  }));
  if (!analysisBreaks.length) {
    listEl.innerHTML = '<div class="analysis-empty">Нет перекуров</div>';
    return;
  }
  listEl.innerHTML = analysisBreaks.map((b, idx) => `
    <div class="analysis-break-row" data-idx="${idx}">
      <input type="time" class="form-control analysis-break-start" value="${b.start}">
      <input type="number" class="form-control analysis-break-duration" min="0" step="5" value="${b.duration}">
      <button type="button" class="btn btn-secondary btn-sm analysis-break-remove" data-idx="${idx}">Удалить</button>
    </div>`).join('');
}

function getBreakTemplatesStorageKey() {
  return 'analysis_break_templates';
}

function loadBreakTemplates() {
  try {
    const raw = localStorage.getItem(getBreakTemplatesStorageKey());
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function saveBreakTemplates(list) {
  try {
    localStorage.setItem(getBreakTemplatesStorageKey(), JSON.stringify(list || []));
  } catch (_) { /* ignore */ }
}

function renderBreakTemplateOptions(list) {
  const select = el('analysis-break-template');
  if (!select) return;
  const items = Array.isArray(list) ? list : [];
  analysisBreakTemplates = items;
  if (!items.length) {
    select.innerHTML = '<option value="">Нет шаблонов</option>';
    return;
  }
  select.innerHTML = items
    .map((t, i) => `<option value="${i}">${t.name || `Шаблон ${i + 1}`}</option>`)
    .join('');
}

function readBreakRules() {
  const rows = document.querySelectorAll('.analysis-break-row');
  const breaks = [];
  rows.forEach(row => {
    const start = row.querySelector('.analysis-break-start')?.value || '';
    const duration = parseNum(row.querySelector('.analysis-break-duration')?.value || 0);
    if (!start || duration <= 0) return;
    breaks.push({ start, duration });
  });
  return breaks;
}

function readLunchRules() {
  const rules = new Map();
  const enabled = document.querySelectorAll('.analysis-lunch-enabled');
  enabled.forEach(chk => {
    if (!chk.checked) return;
    const company = chk.dataset.company || '';
    const start = document.querySelector(`.analysis-lunch-start[data-company="${company}"]`)?.value || '';
    const duration = parseNum(document.querySelector(`.analysis-lunch-duration[data-company="${company}"]`)?.value || 0);
    const percent = Math.max(0, Math.min(100, parseNum(document.querySelector(`.analysis-lunch-percent[data-company="${company}"]`)?.value || 0)));
    if (!company || !start || duration <= 0 || percent <= 0) return;
    rules.set(company, { start, duration, percent });
  });
  return rules;
}

function getPlanStorageKey(dateStr) {
  return `analysis_plan_${dateStr}`;
}

function savePlanToStorage(dateStr, startTime) {
  try {
    const rows = [];
    document.querySelectorAll('#analysis-rows tr').forEach(row => {
      rows.push({
        volume: row.querySelector('.analysis-volume')?.value || '',
        peak: row.querySelector('.analysis-peak')?.value || '',
        people: row.querySelector('.analysis-people')?.value || '',
        start: row.querySelector('.analysis-start')?.value || '',
        target: row.querySelector('.analysis-target')?.value || '',
      });
    });
    const payload = { startTime, rows, breaks: readBreakRules() };
    localStorage.setItem(getPlanStorageKey(dateStr), JSON.stringify(payload));
  } catch (_) { /* ignore */ }
}

function loadPlanFromStorage(dateStr) {
  try {
    const raw = localStorage.getItem(getPlanStorageKey(dateStr));
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && typeof data.startTime === 'string') {
      const startInput = el('analysis-start-time');
      if (startInput && !startInput.value) startInput.value = data.startTime;
    }
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const trList = document.querySelectorAll('#analysis-rows tr');
    trList.forEach((tr, i) => {
      const r = rows[i];
      if (!r) return;
      const setVal = (sel, val) => {
        const inp = tr.querySelector(sel);
        if (inp) inp.value = val || '';
      };
      setVal('.analysis-volume', r.volume);
      setVal('.analysis-peak', r.peak);
      setVal('.analysis-people', r.people);
      setVal('.analysis-start', r.start);
      setVal('.analysis-target', r.target);
    });
    if (Array.isArray(data.breaks)) {
      renderBreakList(data.breaks);
    }
  } catch (_) { /* ignore */ }
}

export function initAnalysis() {
  const dateInput = el('analysis-date');
  if (dateInput && !dateInput.value) dateInput.value = nowDateStr();
  const historyFrom = el('analysis-history-from');
  const historyTo = el('analysis-history-to');
  const baseDate = dateInput?.value || nowDateStr();
  if (historyFrom && !historyFrom.value) historyFrom.value = baseDate;
  if (historyTo && !historyTo.value) historyTo.value = baseDate;
  const inputs = document.querySelectorAll('#tab-analysis input');
  inputs.forEach(inp => {
    inp.addEventListener('input', updateAll);
    inp.addEventListener('change', updateAll);
  });
  const breaksList = el('analysis-breaks-list');
  if (breaksList) {
    breaksList.addEventListener('input', updateAll);
    breaksList.addEventListener('change', updateAll);
    breaksList.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.classList.contains('analysis-break-remove')) return;
      const idx = Number(target.dataset.idx);
      const current = readBreakRules();
      if (Number.isFinite(idx) && idx >= 0) current.splice(idx, 1);
      renderBreakList(current);
      updateAll();
    });
  }
  el('analysis-add-break')?.addEventListener('click', () => {
    const current = readBreakRules();
    current.push({ start: '', duration: 10 });
    renderBreakList(current);
    updateAll();
  });
  el('analysis-save-break-template')?.addEventListener('click', () => {
    const name = (el('analysis-break-template-name')?.value || '').trim();
    if (!name) return;
    const breaks = readBreakRules();
    const list = loadBreakTemplates().filter(t => t && t.name !== name);
    list.push({ name, breaks });
    saveBreakTemplates(list);
    renderBreakTemplateOptions(list);
  });
  el('analysis-apply-break-template')?.addEventListener('click', () => {
    const select = el('analysis-break-template');
    if (!select) return;
    const idx = Number(select.value);
    const list = analysisBreakTemplates;
    const tpl = Number.isFinite(idx) ? list[idx] : null;
    if (!tpl || !Array.isArray(tpl.breaks)) return;
    renderBreakList(tpl.breaks);
    updateAll();
  });
  if (dateInput) {
    dateInput.addEventListener('change', () => {
      const newDate = dateInput.value || nowDateStr();
      if (!historyTouched) setHistoryDatesIfEmpty(newDate);
      loadPlanFromStorage(newDate);
      updateAll();
    });
  }
  bindHistoryTouched();
  el('analysis-pick-staff')?.addEventListener('click', handlePickStaff);
  el('btn-analysis-fill-from-stats')?.addEventListener('click', fillPlanFromDayStats);
  loadCompaniesForAnalysis();
  renderBreakList([]);
  renderBreakTemplateOptions(loadBreakTemplates());
  loadPlanFromStorage(baseDate);
  updateAll();
}
