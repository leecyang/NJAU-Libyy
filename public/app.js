const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { me: null, page: "overview", room: null, teams: [], contacts: [], invitableUsers: [], reservationsSynced: false, taskAvailability: null };
const titles = { overview: "今天，从一间合适的研讨室开始", rooms: "查找研讨室", tasks: "自动预约", teams: "我的小队", reservations: "预约历史", admin: "管理后台" };
const pickerSelections = new Map();
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: "same-origin", headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({ ok: false, error: { message: "响应格式异常" } }));
  if (!response.ok || !body.ok) { const error = new Error(body.error?.message || "请求失败"); error.code = body.error?.code; throw error; }
  return body.data;
}
function toast(message, error = false) { const node = $("#toast"); node.textContent = message; node.classList.toggle("error", error); node.classList.remove("hidden"); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.add("hidden"), 3800); }
function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
async function busy(button, work) { const label = button?.textContent; if (button) { button.disabled = true; button.textContent = "处理中..."; } try { return await work(); } finally { if (button) { button.disabled = false; button.textContent = label; } } }
function today(offset = 0) { const date = new Date(); date.setDate(date.getDate() + offset); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function credentialActive() { return state.me?.credential?.credential_status === "ACTIVE"; }
function minutes(value) { const [hour = 0, minute = 0] = String(value || "").split(":").map(Number); return hour * 60 + minute; }
function formatTime(value) { return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`; }
function validateReservationTime(startTime, endTime) {
  if (!/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(startTime) || !/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(endTime)) throw new Error("预约时间必须位于整点或半点");
  const start = minutes(startTime), end = minutes(endTime), duration = end - start;
  if (start < 480 || end > 1320) throw new Error("预约时间需位于 08:00 至 22:00");
  if (duration <= 0 || duration > 120) throw new Error("单次预约时长必须大于 0 且不超过 120 分钟");
}
function dateLabel(date, label) { return `${label || date} ${date}`; }
function emptyAvailability() { return ["今天", "明天", "后天"].map((label, index) => ({ date: today(index), label, availableRanges: [] })); }
function fullAvailability() {
  const now = new Date();
  const nextHalfHour = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 30) * 30;
  return ["今天", "明天", "后天"].map((label, index) => ({
    date: today(index),
    label,
    availableRanges: [{ startTime: formatTime(index === 0 ? Math.max(480, Math.min(nextHalfHour, 1320)) : 480), endTime: "22:00" }].filter((range) => range.startTime < range.endTime),
  }));
}
function normalizedAvailability(dailyAvailability) {
  const fallback = emptyAvailability();
  const byDate = new Map((dailyAvailability || []).map((day) => [day.date, day]));
  return fallback.map((day) => ({ ...day, ...(byDate.get(day.date) || {}) }));
}
function rangeText(ranges, limit = 4) {
  const text = (ranges || []).slice(0, limit).map((range) => `${range.startTime}-${range.endTime}`).join("、");
  if (!text) return "暂无可用时段";
  return (ranges || []).length > limit ? `${text} 等` : text;
}
function availabilityMarkup(dailyAvailability) {
  return normalizedAvailability(dailyAvailability).map((day) => `<div class="daily-slot-row"><strong>${escapeHtml(dateLabel(day.date, day.label))}</strong><span>${escapeHtml(rangeText(day.availableRanges))}</span></div>`).join("");
}
function slotAvailable(day, minute) {
  return (day.availableRanges || []).some((range) => minutes(range.startTime) <= minute && minutes(range.endTime) >= minute + 30);
}
function selectionValid(day, start, end) {
  if (end <= start || end - start > 120) return false;
  for (let minute = start; minute < end; minute += 30) {
    if (!slotAvailable(day, minute)) return false;
  }
  return true;
}
function firstSelection(dailyAvailability) {
  for (const day of normalizedAvailability(dailyAvailability)) {
    for (let minute = 480; minute < 1320; minute += 30) {
      if (slotAvailable(day, minute)) return { date: day.date, start: minute, end: minute + 30 };
    }
  }
  return null;
}
function renderTimePicker(target, options) {
  const root = typeof target === "string" ? $(target) : target;
  if (!root) return;
  const id = options.id;
  const availability = normalizedAvailability(options.dailyAvailability);
  if (!pickerSelections.get(id) || !availability.some((day) => day.date === pickerSelections.get(id).date && selectionValid(day, pickerSelections.get(id).start, pickerSelections.get(id).end))) {
    pickerSelections.set(id, firstSelection(availability));
  }
  const selection = pickerSelections.get(id);
  const fields = options.fields;
  const hidden = `<input type="hidden" name="${fields.date}" value="${escapeHtml(selection?.date || "")}" required /><input type="hidden" name="${fields.start}" value="${selection ? formatTime(selection.start) : ""}" required /><input type="hidden" name="${fields.end}" value="${selection ? formatTime(selection.end) : ""}" required />`;
  const summary = selection ? `${selection.date} ${formatTime(selection.start)}-${formatTime(selection.end)}` : "请选择可用时段";
  const rows = availability.map((day) => {
    const buttons = [];
    for (let minute = 480; minute < 1320; minute += 30) {
      const available = slotAvailable(day, minute);
      const selected = Boolean(selection && selection.date === day.date && minute >= selection.start && minute < selection.end);
      const hour = minute % 60 === 0;
      buttons.push(`<button class="time-slot${selected ? " selected" : ""}${hour ? " hour-start" : ""}" type="button" data-picker="${id}" data-date="${day.date}" data-minute="${minute}" ${available ? "" : "disabled"} aria-pressed="${selected ? "true" : "false"}"><span>${hour ? formatTime(minute) : ":30"}</span></button>`);
    }
    return `<div class="time-day-row"><div class="time-day-label"><strong>${escapeHtml(day.label || day.date)}</strong><small>${escapeHtml(day.date)}</small></div><div class="time-slot-scroll"><div class="time-slot-grid">${buttons.join("")}</div></div></div>`;
  }).join("");
  root.innerHTML = `<section class="time-picker" data-time-picker="${id}"><div class="time-picker-head"><div><strong>${escapeHtml(options.title || "选择预约时间")}</strong><small>半小时粒度，单次最多 2 小时</small></div><span class="badge">${escapeHtml(summary)}</span></div>${hidden}<div class="time-picker-body">${rows}</div></section>`;
}
function handleTimeSlotClick(button) {
  const pickerId = button.dataset.picker;
  const root = $(`[data-time-picker='${pickerId}']`)?.parentElement;
  const day = normalizedAvailability(pickerId === "manual" ? state.room?.dailyAvailability : state.taskAvailability || fullAvailability()).find((item) => item.date === button.dataset.date);
  if (!day) return;
  const minute = Number(button.dataset.minute);
  const current = pickerSelections.get(pickerId);
  let next = { date: day.date, start: minute, end: minute + 30 };
  if (current?.date === day.date) {
    const start = Math.min(current.start, minute);
    const end = Math.max(current.end, minute + 30);
    if (selectionValid(day, start, end)) next = { date: day.date, start, end };
    else if (end - start > 120) toast("单次预约最多选择 2 小时", true);
    else toast("只能选择连续可用的时间段", true);
  }
  pickerSelections.set(pickerId, next);
  renderTimePicker(root, {
    id: pickerId,
    title: pickerId === "manual" ? "选择手动预约时间" : "选择自动预约时间",
    dailyAvailability: pickerId === "manual" ? state.room?.dailyAvailability : state.taskAvailability || fullAvailability(),
    fields: pickerId === "manual" ? { date: "date", start: "startTime", end: "endTime" } : { date: "targetDate", start: "startTime", end: "endTime" },
  });
}
function renderTaskTimePicker() {
  renderTimePicker("#task-time-picker", {
    id: "task",
    title: state.taskAvailability ? "选择自动预约时间" : "选择自动预约时间",
    dailyAvailability: state.taskAvailability || fullAvailability(),
    fields: { date: "targetDate", start: "startTime", end: "endTime" },
  });
}
function clearTaskAvailabilityIfRoomChanged() {
  if (!state.taskAvailability || !state.room) return;
  const form = $("#task-form");
  const roomId = $("input[name=roomId]", form)?.value;
  const roomName = $("input[name=roomName]", form)?.value;
  if (roomId === String(state.room.id) && roomName === state.room.name) return;
  state.taskAvailability = null;
  pickerSelections.delete("task");
  renderTaskTimePicker();
}

function renderSession() {
  const ready = Boolean(state.me && credentialActive());
  $("#setup-view").classList.toggle("hidden", ready);
  $("#app-shell").classList.toggle("hidden", !ready);
  $("#setup-logout").classList.toggle("hidden", !state.me);
  $$("[data-step-indicator]").forEach((node) => node.classList.toggle("complete", Number(node.dataset.stepIndicator) < (state.me ? 3 : 1)));
  $("[data-step-complete='1']").classList.toggle("hidden", !state.me);
  $$("#login-form, #register-form, #reset-form, .segmented").forEach((node) => node.classList.toggle("hidden", Boolean(state.me)));
  if (!ready) return;
  $("#user-label").textContent = state.me.user.realName || state.me.user.email;
  $("#welcome-title").textContent = `${state.me.user.realName || "你好"}，欢迎回来`;
  $("#credential-hint").textContent = `官方凭证状态：${state.me.credential.credential_status}`;
  $("#account-detail").innerHTML = `<p><strong>${escapeHtml(state.me.user.realName)}</strong></p><p class="muted">${escapeHtml(state.me.user.email)} · ${escapeHtml(state.me.user.studentId)}</p>`;
  $$(".admin-only").forEach((node) => node.classList.toggle("hidden", state.me.user.role !== "ADMIN"));
}
async function refreshMe() { try { state.me = await api("/api/v1/me"); } catch { state.me = null; } renderSession(); if (credentialActive() && state.page === "overview") loadOverview(); }
function setPage(page) {
  state.page = page; $$(".page").forEach((view) => view.classList.toggle("hidden", view.dataset.pageView !== page)); $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === page)); $("#page-title").textContent = titles[page] || "Libyy"; $(".sidebar").classList.remove("open");
  ({ overview: loadOverview, rooms: loadRooms, tasks: loadTasks, teams: loadTeams, reservations: () => loadReservations(true), admin: loadAdmin }[page] || (() => {}))();
}

async function loadRooms() {
  try {
    const data = await api("/api/v1/rooms");
    $("#room-list").innerHTML = data.rooms.map((room) => `<button class="room-card room-open" data-room-id="${room.id}"><div class="list-card-row"><h3>${escapeHtml(room.name)}</h3><span class="badge">查看</span></div><p class="muted">容量 ${room.maxNum} 人 · 最少 ${room.minReservationNum} 人</p><div class="slot-preview">${availabilityMarkup(room.dailyAvailability)}</div></button>`).join("") || "<p>三天内没有可展示的研讨室。</p>";
  } catch (error) { toast(error.message, true); }
}
function choiceMarkup(prefix) {
  const led = state.teams.filter((team) => Number(team.is_leader) === 1).flatMap((team) => (JSON.parse(team.members || "[]")).filter(Boolean).map((member) => ({ ...member, teamName: team.name })));
  const contacts = prefix === "manual" ? `<fieldset><legend>最近联系人（官方手动确认）</legend>${state.contacts.map((item) => `<label class="check-row"><input type="checkbox" name="${prefix}Contact" value="${escapeHtml(item.id)}" />${escapeHtml(item.realName || item.realname)} <small>${escapeHtml(item.studentId || item.studentid)}</small></label>`).join("") || "<small>暂无最近联系人</small>"}</fieldset>` : "";
  return `<fieldset><legend>小队成员</legend>${led.map((member) => `<label class="check-row"><input type="checkbox" name="${prefix}TeamMember" value="${escapeHtml(member.id)}" />${escapeHtml(member.realName)} <small>${escapeHtml(member.teamName)}</small></label>`).join("") || "<small>暂无可选队员</small>"}</fieldset>${contacts}`;
}
async function openRoom(roomId) {
  try {
    await Promise.all([loadTeams(false), loadContacts()]);
    state.room = await api(`/api/v1/rooms/${roomId}`);
    pickerSelections.delete("manual");
    $("#room-dialog-content").innerHTML = `<p class="eyebrow">ROOM ${state.room.id}</p><h2>${escapeHtml(state.room.name)}</h2><div class="slot-preview dialog-slots">${availabilityMarkup(state.room.dailyAvailability)}</div><button class="button soft task-prefill" type="button">用这个房间创建自动预约</button><form id="manual-form" class="form section-block"><div id="manual-time-picker"></div><div class="contact-search"><label>查询非站内联系人<input id="manual-contact-query" placeholder="输入学号" /></label><button id="manual-contact-search" class="button ghost" type="button">查询并保存</button></div><div id="manual-members" class="choice-stack">${choiceMarkup("manual")}</div><button class="button primary">提交预约</button></form>`;
    renderTimePicker("#manual-time-picker", { id: "manual", title: "选择手动预约时间", dailyAvailability: state.room.dailyAvailability, fields: { date: "date", start: "startTime", end: "endTime" } });
    $("#room-dialog").showModal();
  } catch (error) { toast(error.message, true); }
}
async function submitManual(event) {
  event.preventDefault();
  const form = event.target, values = formData(form);
  const selected = (name) => $$(`input[name='${name}']:checked`, form).map((node) => node.value);
  await busy($("button[type=submit]", form), async () => {
    try {
      if (!values.date || !values.startTime || !values.endTime) throw new Error("请选择可用预约时间");
      validateReservationTime(values.startTime, values.endTime);
      const result = await api("/api/v1/reservations/manual", { method: "POST", body: JSON.stringify({ date: values.date, roomId: state.room.id, startTime: values.startTime, endTime: values.endTime, teamMemberUserIds: selected("manualTeamMember"), contactIds: selected("manualContact") }) });
      $("#room-dialog").close(); toast(`预约成功：${result.status}`);
    } catch (error) { toast(error.message, true); }
  });
}
async function searchContact(studentId, targetSelector, prefix) { if (!studentId.trim()) throw new Error("请输入学号"); await api(`/api/v1/official-users/search?q=${encodeURIComponent(studentId.trim())}`); await loadContacts(); $(targetSelector).innerHTML = choiceMarkup(prefix); toast("联系人已保存"); }

async function loadTasks() {
  try {
    await loadTeams(false);
    renderTaskTimePicker();
    $("#task-members").innerHTML = choiceMarkup("task");
    const tasks = await api("/api/v1/reservation-tasks");
    $("#task-list").innerHTML = tasks.map((task) => `<article class="list-card"><div class="list-card-row"><strong>${escapeHtml(task.target_date)} ${escapeHtml(task.start_time)}-${escapeHtml(task.end_time)}</strong><span class="badge">${escapeHtml(task.status)}</span></div><p class="muted">候选房间：${escapeHtml(JSON.parse(task.candidate_rooms || "[]").map((room) => room.roomName).join("、") || "未设置")}</p><div class="button-row">${task.status === "DRAFT" ? `<button class="button soft task-action" data-id="${task.id}" data-action="enable">启用</button>` : ""}${["DRAFT", "WAITING_WINDOW", "WAITING_MEMBERS", "READY"].includes(task.status) ? `<button class="button ghost task-action" data-id="${task.id}" data-action="cancel">取消</button>` : ""}</div></article>`).join("") || "<p>暂无自动预约任务。</p>";
  } catch (error) { toast(error.message, true); }
}
async function loadInvitableUsers() { try { state.invitableUsers = await api("/api/v1/users/invitable"); } catch { state.invitableUsers = []; } }
async function loadContacts() { try { state.contacts = await api("/api/v1/recent-contacts"); } catch { state.contacts = []; } }
function openTeamInviteDialog(teamId) {
  const users = state.invitableUsers.map((user) => `<article class="invite-user-card"><div><strong>${escapeHtml(user.realName || user.real_name)}</strong><p class="muted">${escapeHtml(user.studentIdMasked || user.student_id_masked || "已完成绑定")}</p></div><button class="button soft team-invite-send" data-id="${teamId}" data-user="${escapeHtml(user.id)}">邀请</button></article>`).join("") || "<p>暂无可邀请用户。</p>";
  $("#team-invite-dialog-content").innerHTML = `<p class="eyebrow">邀请成员</p><h2>选择站内用户</h2><div class="invite-user-grid">${users}</div>`;
  $("#team-invite-dialog").showModal();
}
async function loadTeams(render = true) {
  try {
    const data = await api("/api/v1/teams/mine"); state.teams = data.teams;
    if (!render) return;
    const own = state.teams.find((team) => Number(team.is_leader) === 1); $("#team-form").classList.toggle("hidden", Boolean(own));
    $("#team-invitations").innerHTML = data.invitations.filter((item) => item.status === "PENDING").map((item) => `<article class="list-card"><strong>${escapeHtml(item.team_name)}</strong><p class="muted">${escapeHtml(item.inviter_name)} 邀请你加入</p><button class="button soft team-invitation-action" data-id="${item.id}" data-action="accept">接受</button><button class="button ghost team-invitation-action" data-id="${item.id}" data-action="reject">拒绝</button></article>`).join("");
    await loadInvitableUsers();
    $("#team-list").innerHTML = state.teams.map((team) => { const members = JSON.parse(team.members || "[]").filter(Boolean); const leader = Number(team.is_leader) === 1; return `<article class="list-card"><div class="list-card-row"><strong>${escapeHtml(team.name)}</strong><span class="badge">${leader ? "我创建的" : "已加入"}</span></div><p class="muted">${escapeHtml(team.description || "暂无简介")} · 领队 ${escapeHtml(team.leader_name)}</p><div class="member-list">${members.map((member) => `<span>${escapeHtml(member.realName)}${leader ? ` <button class="text-button team-remove" data-team="${team.id}" data-user="${member.id}">移除</button>` : ""}</span>`).join("") || "<small>暂无成员</small>"}</div>${leader ? `<div class="button-row"><button class="button soft team-invite-open" data-id="${team.id}">邀请成员</button><button class="button danger team-delete" data-id="${team.id}">解散小队</button></div>` : `<button class="button ghost team-leave" data-id="${team.id}">退出小队</button>`}</article>`; }).join("") || "<p>尚未创建或加入小队。</p>";
  } catch (error) { toast(error.message, true); }
}
async function loadReservations(sync = false) { try { const shouldSync = sync || !state.reservationsSynced; const rows = await api(shouldSync ? "/api/v1/reservations/sync" : "/api/v1/reservations/history", shouldSync ? { method: "POST" } : {}); state.reservationsSynced = true; $("#reservation-list").innerHTML = rows.map((item) => { const waiting = item.status === "WAITING_MEMBER_CONFIRMATION" ? "<p class=\"muted\">正在等待副预约人同意；小队成员会由系统自动尝试确认。</p>" : ""; const label = item.statusLabel || item.status_label || item.status; return `<article class="list-card"><div class="list-card-row"><strong>${escapeHtml(item.room_name_snapshot)} · ${escapeHtml(item.date)} ${escapeHtml(item.start_time)}-${escapeHtml(item.end_time)}</strong><span class="badge">${escapeHtml(label)}</span></div><p class="muted">官方订单 ${escapeHtml(item.official_reservation_id || "同步中")}</p>${waiting}<div class="button-row">${item.status === "SCHEDULED" ? `<button class="button soft reservation-action" data-id="${item.id}" data-action="sign-link">获取签到入口</button>` : ""}${item.canCancel || item.can_cancel ? `<button class="button ghost reservation-action" data-id="${item.id}" data-action="cancel">取消预约</button>` : ""}${item.status === "SIGNED_IN" ? `<button class="button ghost reservation-action" data-id="${item.id}" data-action="signout">立即签退</button>` : ""}</div></article>`; }).join("") || "<p>暂无预约记录。</p>"; } catch (error) { toast(error.message, true); } }
async function loadSimpleList(path, selector) { try { const rows = await api(path); $(selector).innerHTML = rows.map((item) => { let detail = ""; try { const parsed = item.official_response_redacted ? JSON.parse(item.official_response_redacted) : null; detail = parsed?.reason ? ` · ${parsed.reason}` : ""; } catch { detail = ""; } return `<article class="list-card"><div class="list-card-row"><strong>${escapeHtml(item.reservation_id)}</strong><span class="badge">${escapeHtml(item.status)}</span></div><p class="muted">计划时间：${new Date(item.scheduled_at).toLocaleString()} · 尝试 ${escapeHtml(item.attempt_count ?? 0)} 次${detail}</p>${item.executed_at ? `<p class="muted">执行时间：${new Date(item.executed_at).toLocaleString()}</p>` : ""}</article>`; }).join("") || "<p>暂无记录。</p>"; } catch (error) { toast(error.message, true); } }
async function loadOverview() { await Promise.all([loadSimpleList("/api/v1/sign-tasks", "#overview-sign-list"), loadSimpleList("/api/v1/signout-tasks", "#overview-signout-list")]); }
async function loadAdmin() { if (state.me?.user.role !== "ADMIN") return; try { const stats = await api("/api/v1/admin/dashboard"); $("#admin-stats").innerHTML = Object.entries(stats).map(([key, value]) => `<article class="quick-card"><strong>${value}</strong><span>${escapeHtml(key)}</span></article>`).join(""); await loadAdminCollection(); } catch (error) { toast(error.message, true); } }
function adminUserAction(row) { if (!["ACTIVE", "BANNED"].includes(row.status)) return ""; return `<button class="button ghost admin-user-status" data-id="${row.id}" data-status="${row.status === "ACTIVE" ? "BANNED" : "ACTIVE"}">${row.status === "ACTIVE" ? "封禁" : "恢复"}</button>`; }
async function loadAdminCollection() { try { const collection = $("#admin-collection").value; const rows = await api(`/api/v1/admin/${collection}`); const actions = collection === "users" ? rows.map((row) => `<article class="list-card"><div class="list-card-row"><strong>${escapeHtml(row.email)}</strong><span class="badge">${escapeHtml(row.status)}</span></div><p class="muted">${escapeHtml(row.real_name || "-")} · ${escapeHtml(row.student_id || "-")}</p>${adminUserAction(row)}</article>`).join("") : `<pre>${escapeHtml(JSON.stringify(rows, null, 2))}</pre>`; $("#admin-table").innerHTML = actions; } catch (error) { toast(error.message, true); } }

async function checkInvitationLink() { const params = new URLSearchParams(location.search); const id = params.get("teamInvitation"), token = params.get("teamToken"); if (!id || !token) return; try { const item = await api(`/api/v1/team-invitations/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`); $("#invitation-dialog-content").innerHTML = `<p class="eyebrow">TEAM INVITATION</p><h2>${escapeHtml(item.teamName)}</h2><p>${escapeHtml(item.inviterName)} 邀请你加入小队。</p><button class="button primary public-invitation-action" data-id="${id}" data-token="${escapeHtml(token)}" data-action="accept">接受邀请</button><button class="button ghost public-invitation-action" data-id="${id}" data-token="${escapeHtml(token)}" data-action="reject">拒绝邀请</button>`; $("#invitation-dialog").showModal(); } catch (error) { toast(error.message, true); } }
async function bindForm(event) { event.preventDefault(); const textarea = event.target.elements.reflushToken; await busy($("button[type=submit]", event.target), async () => { try { await api("/api/v1/credentials/bind", { method: "POST", body: JSON.stringify({ reflushToken: textarea.value }) }); textarea.value = ""; await refreshMe(); toast("官方身份绑定成功"); } catch (error) { textarea.value = ""; toast(error.message, true); } }); }
async function logout() { await api("/api/v1/auth/logout", { method: "POST" }); state.me = null; renderSession(); }

$$("[data-auth-tab]").forEach((button) => button.addEventListener("click", () => { $$("[data-auth-tab]").forEach((item) => item.classList.toggle("active", item === button)); $$(".auth-form").forEach((form) => form.classList.add("hidden")); $(`#${button.dataset.authTab}-form`).classList.remove("hidden"); }));
$("#login-form").addEventListener("submit", async (event) => { event.preventDefault(); await busy($("button[type=submit]", event.target), async () => { try { await api("/api/v1/auth/login", { method: "POST", body: JSON.stringify(formData(event.target)) }); await refreshMe(); toast("登录成功，请继续完成官方凭证配置"); } catch (error) { toast(error.message, true); } }); });
$("#register-form").addEventListener("submit", async (event) => { event.preventDefault(); await busy($("button[type=submit]", event.target), async () => { try { await api("/api/v1/auth/register", { method: "POST", body: JSON.stringify(formData(event.target)) }); toast("注册成功，请登录"); $("[data-auth-tab=login]").click(); } catch (error) { toast(error.message, true); } }); });
$("#reset-form").addEventListener("submit", async (event) => { event.preventDefault(); try { await api("/api/v1/auth/reset-password", { method: "POST", body: JSON.stringify(formData(event.target)) }); toast("密码已更新，请重新登录"); $("[data-auth-tab=login]").click(); } catch (error) { toast(error.message, true); } });
$$(".send-code").forEach((button) => button.addEventListener("click", () => busy(button, async () => { try { const form = button.closest("form"); const result = await api(button.dataset.purpose === "register" ? "/api/v1/auth/send-register-code" : "/api/v1/auth/send-reset-code", { method: "POST", body: JSON.stringify({ email: form.elements.email.value }) }); toast(result.devCode ? `验证码已排队，开发验证码：${result.devCode}` : "验证码邮件已排队"); } catch (error) { toast(error.message, true); } })));
$("#setup-bind-form").addEventListener("submit", bindForm); $("#bind-form").addEventListener("submit", bindForm); $("#logout-button").addEventListener("click", logout); $("#setup-logout").addEventListener("click", logout); $("#menu-toggle").addEventListener("click", () => $(".sidebar").classList.toggle("open")); $$("[data-page], [data-go]").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page || button.dataset.go)));
document.addEventListener("click", (event) => { const slot = event.target.closest(".time-slot"); if (slot) handleTimeSlotClick(slot); });
$("#refresh-rooms").addEventListener("click", loadRooms);
$("#room-list").addEventListener("click", (event) => { const card = event.target.closest(".room-open"); if (card) openRoom(card.dataset.roomId); });
$("#room-dialog-content").addEventListener("submit", submitManual);
$("#room-dialog-content").addEventListener("click", (event) => {
  if (event.target.closest(".task-prefill")) {
    $("input[name=roomId]", $("#task-form")).value = state.room.id;
    $("input[name=roomName]", $("#task-form")).value = state.room.name;
    state.taskAvailability = state.room.dailyAvailability;
    pickerSelections.delete("task");
    $("#room-dialog").close();
    setPage("tasks");
    toast("已带入候选房间和三天可用时段");
    return;
  }
  if (event.target.id !== "manual-contact-search") return;
  busy(event.target, async () => { try { await searchContact($("#manual-contact-query").value, "#manual-members", "manual"); } catch (error) { toast(error.message, true); } });
});
$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = formData(event.target);
  const selected = (name) => $$(`input[name='${name}']:checked`, event.target).map((node) => node.value);
  try {
    if (!values.targetDate || !values.startTime || !values.endTime) throw new Error("请选择自动预约时间");
    validateReservationTime(values.startTime, values.endTime);
    await api("/api/v1/reservation-tasks", { method: "POST", body: JSON.stringify({ targetDate: values.targetDate, startTime: values.startTime, endTime: values.endTime, candidateRooms: [{ roomId: Number(values.roomId), roomName: values.roomName }], teamMemberUserIds: selected("taskTeamMember") }) });
    event.target.reset();
    pickerSelections.delete("task");
    renderTaskTimePicker();
    toast("自动预约草稿已创建");
    loadTasks();
  } catch (error) { toast(error.message, true); }
});
$$("input[name=roomId], input[name=roomName]", $("#task-form")).forEach((input) => input.addEventListener("input", clearTaskAvailabilityIfRoomChanged));
$("#task-list").addEventListener("click", async (event) => { const button = event.target.closest(".task-action"); if (!button) return; try { await api(`/api/v1/reservation-tasks/${button.dataset.id}/${button.dataset.action}`, { method: "POST" }); toast("任务状态已更新"); loadTasks(); } catch (error) { toast(error.message, true); } });
$("#team-form").addEventListener("submit", async (event) => { event.preventDefault(); try { await api("/api/v1/teams", { method: "POST", body: JSON.stringify(formData(event.target)) }); event.target.reset(); toast("小队已创建"); loadTeams(); } catch (error) { toast(error.message, true); } });
$("#team-list").addEventListener("click", async (event) => { const inviteOpen = event.target.closest(".team-invite-open"), remove = event.target.closest(".team-remove"), leave = event.target.closest(".team-leave"), del = event.target.closest(".team-delete"); try { if (inviteOpen) { openTeamInviteDialog(inviteOpen.dataset.id); return; } if (remove) await api(`/api/v1/teams/${remove.dataset.team}/members/${remove.dataset.user}`, { method: "DELETE" }); if (leave) await api(`/api/v1/teams/${leave.dataset.id}/members/me`, { method: "DELETE" }); if (del && confirm("确定解散小队？")) await api(`/api/v1/teams/${del.dataset.id}`, { method: "DELETE" }); loadTeams(); } catch (error) { toast(error.message, true); } });
$("#team-invite-dialog").addEventListener("click", async (event) => { const button = event.target.closest(".team-invite-send"); if (!button) return; await busy(button, async () => { try { await api(`/api/v1/teams/${button.dataset.id}/invitations`, { method: "POST", body: JSON.stringify({ inviteeUserId: button.dataset.user }) }); toast("邀请邮件已排队"); button.textContent = "已邀请"; button.disabled = true; loadTeams(); } catch (error) { toast(error.message, true); } }); });
async function respondTeam(button) { try { await api(`/api/v1/team-invitations/${button.dataset.id}/respond`, { method: "POST", body: JSON.stringify({ action: button.dataset.action, token: button.dataset.token }) }); $("#invitation-dialog").close(); history.replaceState({}, "", location.pathname); toast("邀请状态已更新"); if (credentialActive()) loadTeams(); } catch (error) { toast(error.message, true); } }
$("#team-invitations").addEventListener("click", (event) => { const button = event.target.closest(".team-invitation-action"); if (button) respondTeam(button); }); $("#invitation-dialog").addEventListener("click", (event) => { const button = event.target.closest(".public-invitation-action"); if (button) respondTeam(button); });
$("#sync-reservations").addEventListener("click", (event) => busy(event.target, async () => { await loadReservations(true); toast("订单已刷新"); })); $("#reservation-list").addEventListener("click", async (event) => { const button = event.target.closest(".reservation-action"); if (!button) return; try { const result = await api(`/api/v1/reservations/${button.dataset.id}/${button.dataset.action}`, { method: "POST" }); if (result.url) window.open(result.url, "_blank", "noopener,noreferrer"); else toast("订单状态已更新"); loadReservations(); } catch (error) { toast(error.message, true); } });
$("#admin-collection").addEventListener("change", loadAdminCollection); $("#admin-test-email")?.addEventListener("click", (event) => busy(event.target, async () => { try { await api("/api/v1/admin/emails/test", { method: "POST" }); toast("测试邮件已加入队列"); } catch (error) { toast(error.message, true); } })); $("#admin-config")?.addEventListener("click", async () => { try { const config = await api("/api/v1/admin/config"); $("#admin-table").innerHTML = `<pre>${escapeHtml(JSON.stringify(config, null, 2))}</pre>`; } catch (error) { toast(error.message, true); } }); $("#admin-table").addEventListener("click", async (event) => { const button = event.target.closest(".admin-user-status"); if (!button) return; try { await api(`/api/v1/admin/users/${button.dataset.id}/status`, { method: "PATCH", body: JSON.stringify({ status: button.dataset.status }) }); toast("用户状态已更新"); loadAdminCollection(); } catch (error) { toast(error.message, true); } }); $("#delete-account").addEventListener("click", async () => { if (!confirm("确定注销账号？官方凭证会被销毁，未来任务会停止。")) return; try { await api("/api/v1/account/delete", { method: "POST" }); state.me = null; renderSession(); toast("账号已注销"); } catch (error) { toast(error.message, true); } });
checkInvitationLink(); renderTaskTimePicker(); refreshMe();
