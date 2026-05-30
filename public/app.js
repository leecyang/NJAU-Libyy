const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { me: null, page: "overview" };

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({ ok: false, error: { message: "响应格式异常" } }));
  if (!response.ok || !body.ok) throw new Error(body.error?.message || "请求失败");
  return body.data;
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 3800);
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setPage(page) {
  state.page = page;
  $$(".page").forEach((view) => view.classList.toggle("hidden", view.dataset.pageView !== page));
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === page));
  const title = { overview: "今天，从一间合适的研讨室开始", rooms: "查找研讨室", tasks: "自动预约", square: "用户广场", invitations: "我的邀请", account: "账号与凭证", admin: "管理后台" };
  $("#page-title").textContent = title[page] || "Libyy";
  $(".sidebar").classList.remove("open");
  if (page === "rooms") loadRooms();
  if (page === "tasks") loadTasks();
  if (page === "square") loadSquare();
  if (page === "invitations") loadInvitations();
  if (page === "admin") loadAdmin();
}

function renderSession() {
  const loggedIn = Boolean(state.me);
  $("#auth-view").classList.toggle("hidden", loggedIn);
  $("#app-view").classList.toggle("hidden", !loggedIn);
  $("#logout-button").classList.toggle("hidden", !loggedIn);
  $("#user-label").textContent = loggedIn ? (state.me.user.realName || state.me.user.email) : "尚未登录";
  if (!loggedIn) return;
  const bound = state.me.credential.credential_status !== "UNBOUND";
  $("#credential-hint").textContent = bound ? `官方凭证状态：${state.me.credential.credential_status}` : "尚未绑定官方凭证，请先在账号页面完成绑定。";
  $("#welcome-title").textContent = `${state.me.user.realName || "你好"}，欢迎回来`;
  $("#auto-join").checked = state.me.user.allowAutoJoinReservation;
  $$(".admin-only").forEach((node) => node.classList.toggle("hidden", state.me.user.role !== "ADMIN"));
}

async function refreshMe() {
  try {
    state.me = await api("/api/v1/me");
  } catch {
    state.me = null;
  }
  renderSession();
}

function today(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function loadRooms() {
  const date = $("#room-date").value || today();
  $("#room-date").value = date;
  try {
    const data = await api(`/api/v1/rooms?date=${encodeURIComponent(date)}`);
    $("#room-list").classList.remove("empty");
    $("#room-list").innerHTML = data.rooms.map((room) => `
      <article class="room-card ${room.reservable ? "" : "disabled"}">
        <div class="list-card-row"><h3>${room.name}</h3><span class="badge ${room.reservable ? "" : "warn"}">${room.reservable ? "可预约" : "暂不开放"}</span></div>
        <p class="muted">位置 ${room.roomLocation || "-"} · 容量 ${room.maxNum} 人 · 最少 ${room.minReservationNum} 人</p>
        <small>${room.startTime || "--:--"} 至 ${room.endTime || "--:--"}</small>
      </article>`).join("") || "<p>当天没有可展示的研讨室。</p>";
  } catch (error) { toast(error.message, true); }
}

async function loadTasks() {
  try {
    const tasks = await api("/api/v1/reservation-tasks");
    $("#task-list").innerHTML = tasks.map((task) => `
      <article class="list-card">
        <div class="list-card-row"><strong>${task.target_date} ${task.start_time}-${task.end_time}</strong><span class="badge">${task.status}</span></div>
        <p class="muted">候选房间：${JSON.parse(task.candidate_rooms || "[]").map((room) => room.roomName).join("、") || "未设置"}</p>
        ${task.status === "DRAFT" ? `<button class="button soft task-action" data-id="${task.id}" data-action="enable">启用</button>` : ""}
        ${["DRAFT", "WAITING_WINDOW", "WAITING_MEMBERS", "READY"].includes(task.status) ? `<button class="button ghost task-action" data-id="${task.id}" data-action="cancel">取消</button>` : ""}
      </article>`).join("") || "<p>暂无自动预约任务。</p>";
  } catch (error) { toast(error.message, true); }
}

async function loadSquare() {
  try {
    const users = await api("/api/v1/square/users");
    $("#square-list").innerHTML = users.map((user) => `
      <article class="room-card">
        <h3>${user.real_name}</h3>
        <p class="muted">${user.student_id_masked}</p>
        <span class="badge">${user.allow_auto_join_reservation ? "允许自动联约" : "需要邀请确认"}</span>
      </article>`).join("") || "<p>广场还没有可展示用户。</p>";
  } catch (error) { toast(error.message, true); }
}

async function loadInvitations() {
  try {
    const items = await api("/api/v1/invitations/received");
    $("#invitation-list").innerHTML = items.map((item) => `
      <article class="list-card">
        <div class="list-card-row"><strong>${item.inviter_name || "用户邀请"}</strong><span class="badge">${item.status}</span></div>
        <p class="muted">${item.target_date || ""} ${item.start_time || ""}-${item.end_time || ""}</p>
        ${item.status === "PENDING" ? `<button class="button soft invitation-action" data-id="${item.id}" data-action="accept">接受</button> <button class="button ghost invitation-action" data-id="${item.id}" data-action="reject">拒绝</button>` : ""}
      </article>`).join("") || "<p>暂无邀请。</p>";
  } catch (error) { toast(error.message, true); }
}

async function loadAdmin() {
  try {
    const stats = await api("/api/v1/admin/dashboard");
    $("#admin-stats").innerHTML = Object.entries(stats).map(([key, value]) => `<article class="quick-card"><strong>${value}</strong><span>${key}</span></article>`).join("");
  } catch (error) { toast(error.message, true); }
}

$$("[data-auth-tab]").forEach((button) => button.addEventListener("click", () => {
  $$("[data-auth-tab]").forEach((item) => item.classList.toggle("active", item === button));
  $$(".auth-form").forEach((form) => form.classList.add("hidden"));
  $(`#${button.dataset.authTab}-form`).classList.remove("hidden");
}));
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await api("/api/v1/auth/login", { method: "POST", body: JSON.stringify(formData(event.target)) }); await refreshMe(); toast("登录成功"); } catch (error) { toast(error.message, true); }
});
$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await api("/api/v1/auth/register", { method: "POST", body: JSON.stringify(formData(event.target)) }); toast("注册成功，请登录"); $("[data-auth-tab=login]").click(); } catch (error) { toast(error.message, true); }
});
$("#reset-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await api("/api/v1/auth/reset-password", { method: "POST", body: JSON.stringify(formData(event.target)) }); toast("密码已更新，请重新登录"); $("[data-auth-tab=login]").click(); } catch (error) { toast(error.message, true); }
});
$$(".send-code").forEach((button) => button.addEventListener("click", async () => {
  const form = button.closest("form");
  try {
    const result = await api(button.dataset.purpose === "register" ? "/api/v1/auth/send-register-code" : "/api/v1/auth/send-reset-code", { method: "POST", body: JSON.stringify({ email: form.elements.email.value }) });
    toast(result.devCode ? `验证码已排队，开发验证码：${result.devCode}` : "验证码邮件已排队");
  } catch (error) { toast(error.message, true); }
}));
$("#logout-button").addEventListener("click", async () => { await api("/api/v1/auth/logout", { method: "POST" }); state.me = null; renderSession(); });
$("#menu-toggle").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$$("[data-page], [data-go]").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page || button.dataset.go)));
$("#room-date").addEventListener("change", loadRooms);
$("#manual-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = formData(event.target);
  const memberUserIds = String(values.memberUserIds || "").split(/\s+/).map((item) => item.trim()).filter(Boolean);
  try {
    const result = await api("/api/v1/reservations/manual", { method: "POST", body: JSON.stringify({ date: $("#room-date").value, roomId: Number(values.roomId), startTime: values.startTime, endTime: values.endTime, memberUserIds }) });
    event.target.reset(); toast(`预约已提交：${result.status}`);
  } catch (error) { toast(error.message, true); }
});
$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = formData(event.target);
  try {
    await api("/api/v1/reservation-tasks", { method: "POST", body: JSON.stringify({ targetDate: values.targetDate, startTime: values.startTime, endTime: values.endTime, candidateRooms: [{ roomId: Number(values.roomId), roomName: values.roomName }] }) });
    event.target.reset(); toast("自动预约草稿已创建"); loadTasks();
  } catch (error) { toast(error.message, true); }
});
$("#task-list").addEventListener("click", async (event) => {
  const button = event.target.closest(".task-action"); if (!button) return;
  try { await api(`/api/v1/reservation-tasks/${button.dataset.id}/${button.dataset.action}`, { method: "POST" }); toast("任务状态已更新"); loadTasks(); } catch (error) { toast(error.message, true); }
});
$("#invitation-list").addEventListener("click", async (event) => {
  const button = event.target.closest(".invitation-action"); if (!button) return;
  try { await api(`/api/v1/invitations/${button.dataset.id}/${button.dataset.action}`, { method: "POST", body: "{}" }); toast("邀请状态已更新"); loadInvitations(); } catch (error) { toast(error.message, true); }
});
$("#bind-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const textarea = event.target.elements.reflushToken;
  try { await api("/api/v1/credentials/bind", { method: "POST", body: JSON.stringify({ reflushToken: textarea.value }) }); textarea.value = ""; await refreshMe(); toast("官方身份绑定成功"); } catch (error) { textarea.value = ""; toast(error.message, true); }
});
$("#auto-join").addEventListener("change", async (event) => {
  try { await api("/api/v1/profile/auto-join", { method: "PATCH", body: JSON.stringify({ enabled: event.target.checked }) }); await refreshMe(); toast("自动联约设置已更新"); } catch (error) { event.target.checked = !event.target.checked; toast(error.message, true); }
});
$("#delete-account").addEventListener("click", async () => {
  if (!confirm("确定注销账号？官方凭证会被销毁，未来任务会停止。")) return;
  try { await api("/api/v1/account/delete", { method: "POST" }); state.me = null; renderSession(); toast("账号已注销"); } catch (error) { toast(error.message, true); }
});

$("#room-date").min = today(); $("#room-date").max = today(2);
refreshMe();
