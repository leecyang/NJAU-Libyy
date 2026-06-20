import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const videoRoot = resolve(here, "..");
const repoRoot = resolve(videoRoot, "..");
const assetsDir = resolve(videoRoot, "assets", "screens");
const port = 5174;
const baseUrl = `http://127.0.0.1:${port}`;

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next.toISOString().slice(0, 10);
}

const today = new Date();
const dates = [addDays(today, 1), addDays(today, 2), addDays(today, 3)];
const taskDate = addDays(today, 3);
const now = Date.now();

const session = {
  user: {
    id: "u-current",
    email: "libyy.demo@njau.edu.cn",
    role: "USER",
    studentId: "2026300001",
    realName: "李同学",
    totalScore: 86,
  },
  credential: {
    credential_status: "ACTIVE",
    setup_required: false,
    login_student_id: "2026300001",
    login_attempt: null,
  },
};

const credentialSession = {
  ...session,
  credential: {
    credential_status: "UNBOUND",
    setup_required: true,
    login_student_id: null,
    login_attempt: null,
  },
};

const rooms = [
  {
    id: 101,
    name: "逸夫楼 A101",
    roomLocation: "图书馆三层东侧",
    status: 1,
    reservable: true,
    maxNum: 6,
    minReservationNum: 2,
    dailyAvailability: dates.map((date, index) => ({
      date,
      availableRanges: index === 0
        ? [{ startTime: "09:00", endTime: "11:30" }, { startTime: "14:00", endTime: "18:00" }]
        : [{ startTime: "08:30", endTime: "12:00" }, { startTime: "15:00", endTime: "20:30" }],
    })),
  },
  {
    id: 203,
    name: "信息共享空间 B203",
    roomLocation: "图书馆四层西侧",
    status: 1,
    reservable: true,
    maxNum: 8,
    minReservationNum: 3,
    dailyAvailability: dates.map((date) => ({
      date,
      availableRanges: [{ startTime: "10:00", endTime: "12:30" }, { startTime: "18:00", endTime: "21:30" }],
    })),
  },
  {
    id: 305,
    name: "南农研讨间 C305",
    roomLocation: "图书馆五层南区",
    status: 1,
    reservable: true,
    maxNum: 10,
    minReservationNum: 4,
    dailyAvailability: dates.map((date, index) => ({
      date,
      availableRanges: index === 1
        ? [{ startTime: "08:00", endTime: "10:00" }, { startTime: "13:30", endTime: "16:30" }]
        : [{ startTime: "12:00", endTime: "15:30" }, { startTime: "19:00", endTime: "22:00" }],
    })),
  },
];

const participants = [
  {
    id: "u-current",
    studentId: "2026300001",
    realName: "李同学",
    email: "libyy.demo@njau.edu.cn",
    isCurrentUser: true,
    teamName: "植保 2301 学习小组",
    totalScore: 86,
    scoreRefreshedAt: now - 18 * 60 * 1000,
    reservationQuota: dates.concat(taskDate).map((date) => ({ date, used: 0, remaining: 2, limit: 2 })),
  },
  {
    id: "u-ming",
    studentId: "2026300002",
    realName: "王明",
    email: "ming@example.test",
    isCurrentUser: false,
    teamName: "植保 2301 学习小组",
    totalScore: 72,
    scoreRefreshedAt: now - 22 * 60 * 1000,
    reservationQuota: dates.concat(taskDate).map((date) => ({ date, used: 1, remaining: 1, limit: 2 })),
  },
  {
    id: "u-yu",
    studentId: "2026300003",
    realName: "陈雨",
    email: "yu@example.test",
    isCurrentUser: false,
    teamName: "植保 2301 学习小组",
    totalScore: 64,
    scoreRefreshedAt: now - 26 * 60 * 1000,
    reservationQuota: dates.concat(taskDate).map((date) => ({ date, used: 0, remaining: 2, limit: 2 })),
  },
  {
    id: "u-lan",
    studentId: "2026300004",
    realName: "赵岚",
    email: "lan@example.test",
    isCurrentUser: false,
    teamName: "土壤数据小队",
    totalScore: 39,
    scoreRefreshedAt: now - 28 * 60 * 1000,
    reservationQuota: dates.concat(taskDate).map((date) => ({ date, used: 1, remaining: 1, limit: 2 })),
  },
];

const tasks = [
  {
    id: "task-1",
    target_date: taskDate,
    start_time: "09:00",
    end_time: "11:00",
    status: "READY",
    candidate_rooms: JSON.stringify([{ roomName: "逸夫楼 A101" }, { roomName: "信息共享空间 B203" }]),
    created_at: now - 2 * 60 * 60 * 1000,
  },
  {
    id: "task-2",
    target_date: taskDate,
    start_time: "15:00",
    end_time: "17:00",
    status: "WAITING_MEMBERS",
    candidate_rooms: JSON.stringify([{ roomName: "南农研讨间 C305" }]),
    created_at: now - 5 * 60 * 60 * 1000,
  },
];

const workflows = [
  {
    id: "workflow-1",
    room_name_snapshot: "逸夫楼 A101",
    date: dates[0],
    start_time: "14:00",
    end_time: "16:00",
    sign_scheduled_at: now + 8 * 60 * 60 * 1000,
    signout_scheduled_at: now + 10 * 60 * 60 * 1000,
    status: "ACTIVE",
    signout_status: "WAITING_WINDOW",
    participants: [
      { userId: "u-current", realName: "李同学", participantOrder: 0, signStatus: "READY", signAttemptCount: 0, signedAt: null },
      { userId: "u-ming", realName: "王明", participantOrder: 1, signStatus: "READY", signAttemptCount: 0, signedAt: null },
    ],
  },
];

const teams = [
  {
    id: "team-alpha",
    name: "植保 2301 学习小组",
    description: "固定预约研讨间，准备课程展示和论文讨论",
    leader_user_id: "u-current",
    leader_name: "李同学",
    is_leader: true,
    members: [
      { id: "u-ming", realName: "王明", studentId: "2026300002" },
      { id: "u-yu", realName: "陈雨", studentId: "2026300003" },
    ],
  },
  {
    id: "team-beta",
    name: "土壤数据小队",
    description: "共享数据清洗和模型验证时段",
    leader_user_id: "u-lan",
    leader_name: "赵岚",
    is_leader: false,
    members: [
      { id: "u-current", realName: "李同学", studentId: "2026300001" },
    ],
  },
];

const reservations = [
  {
    id: "res-active",
    official_reservation_id: "NJAU-20260618091",
    owner_user_id: "u-current",
    room_name_snapshot: "逸夫楼 A101",
    room_id: 101,
    date: dates[0],
    start_time: "14:00",
    end_time: "16:00",
    status: "SIGNED_IN",
    statusLabel: "已签到",
    canCancel: false,
    canOpenDoor: true,
    created_at: now - 30 * 60 * 1000,
  },
  {
    id: "res-upcoming",
    official_reservation_id: "NJAU-20260619042",
    owner_user_id: "u-current",
    room_name_snapshot: "信息共享空间 B203",
    room_id: 203,
    date: dates[1],
    start_time: "10:00",
    end_time: "12:00",
    status: "RESERVED",
    statusLabel: "已预约",
    canCancel: true,
    canOpenDoor: false,
    created_at: now - 90 * 60 * 1000,
  },
];

function ok(data) {
  return { ok: true, data };
}

function job(kind, result = {}) {
  return {
    jobId: `demo-${kind}`,
    kind,
    status: "SUCCEEDED",
    result,
    error: null,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    updatedAt: now,
  };
}

async function fulfill(route, data, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
}

async function installApiMocks(page, { initialAuth = true, needsCredential = false } = {}) {
  let loggedIn = initialAuth;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/v1/me") {
      if (!loggedIn) {
        await fulfill(route, { ok: false, error: { code: "UNAUTHENTICATED", message: "请先登录" } }, 401);
      } else {
        await fulfill(route, ok(needsCredential ? credentialSession : session));
      }
      return;
    }

    if (path === "/api/v1/auth/login" && method === "POST") {
      loggedIn = true;
      await fulfill(route, ok({}));
      return;
    }

    if (path.startsWith("/api/v1/auth/") || path.startsWith("/api/v1/credentials/")) {
      await fulfill(route, ok(path.includes("send") ? { queued: true, devCode: "260617" } : job("credential-bind")));
      return;
    }

    if (path === "/api/v1/rooms") {
      await fulfill(route, ok({
        dates: dates.map((date) => ({ date })),
        rooms,
        cache: { status: "FRESH", version: 4, refreshedAt: now - 10 * 60 * 1000, refreshJobId: null, error: null },
      }));
      return;
    }

    if (path === "/api/v1/reservation-participants") {
      await fulfill(route, ok({ participants }));
      return;
    }

    if (path === "/api/v1/reservation-tasks") {
      await fulfill(route, ok(method === "POST" ? { id: "task-new" } : tasks));
      return;
    }

    if (path === "/api/v1/sign-workflows") {
      await fulfill(route, ok(method === "POST" ? { id: "workflow-new" } : workflows));
      return;
    }

    if (path === "/api/v1/reservation-options" || path === "/api/v1/reservation-options/refresh") {
      await fulfill(route, ok({
        options: [{
          id: "option-active",
          ownerUserId: "u-current",
          ownerName: "李同学",
          officialReservationId: "NJAU-20260618091",
          roomId: 101,
          roomName: "逸夫楼 A101",
          date: dates[0],
          startTime: "14:00",
          endTime: "16:00",
          participants: [
            { userId: "u-current", studentId: "2026300001", realName: "李同学", participantOrder: 0, isPrimary: true },
            { userId: "u-ming", studentId: "2026300002", realName: "王明", participantOrder: 1, isPrimary: false },
          ],
        }],
        warnings: [],
      }));
      return;
    }

    if (path === "/api/v1/teams/mine") {
      await fulfill(route, ok({
        teams,
        invitations: [{ id: "invite-1", team_id: "team-gamma", status: "PENDING", expires_at: now + 2 * 86400000, created_at: now - 3600000, team_name: "农业经济读书会", inviter_name: "周老师" }],
      }));
      return;
    }

    if (path === "/api/v1/users/invitable") {
      await fulfill(route, ok([
        { id: "u-new-1", email: "lin@example.test", real_name: "林晨", student_id: "2026300010" },
        { id: "u-new-2", email: "gao@example.test", real_name: "高宁", student_id: "2026300011" },
      ]));
      return;
    }

    const teamMetric = path.match(/^\/api\/v1\/teams\/([^/]+)\/member-metrics$/);
    if (teamMetric) {
      const team = teams.find((item) => item.id === decodeURIComponent(teamMetric[1]));
      const metricMembers = team ? [
        { id: team.leader_user_id, realName: team.leader_name, studentId: "" },
        ...team.members,
      ] : [];
      await fulfill(route, ok({
        members: metricMembers.map((member, index) => ({
          localUserId: member.id,
          realName: member.realName,
          totalScore: [86, 72, 64, 39][index] ?? 52,
          reservationQuota: [{ date: dates[0], remaining: index === 1 ? 1 : 2, limit: 2 }],
        })),
      }));
      return;
    }

    const teamDetail = path.match(/^\/api\/v1\/teams\/([^/]+)$/);
    if (teamDetail) {
      const team = teams.find((item) => item.id === decodeURIComponent(teamDetail[1])) ?? teams[0];
      const detailMembers = [
        { id: team.leader_user_id, realName: team.leader_name, studentId: "" },
        ...team.members,
      ];
      await fulfill(route, ok({
        id: team.id,
        name: team.name,
        description: team.description,
        leader_user_id: team.leader_user_id,
        members: detailMembers.map((member, index) => ({
          id: member.id,
          email: `${member.id}@example.test`,
          studentId: member.studentId,
          realName: member.realName,
          isLeader: member.id === team.leader_user_id,
          mobileBound: true,
          credentialStatus: "ACTIVE",
          totalScore: [86, 72, 64][index] ?? 40,
          scoreRefreshedAt: now - 1200000,
          scoreStatus: "FRESH",
          reservationQuota: [{ date: dates[0], used: 0, remaining: 2, limit: 2 }],
        })),
      }));
      return;
    }

    if (path === "/api/v1/reservations/history") {
      await fulfill(route, ok(reservations));
      return;
    }

    if (path.startsWith("/api/v1/reservations/") || path.endsWith("/refresh") || path.includes("/enable") || path.includes("/cancel")) {
      await fulfill(route, ok(job("action", { roomName: "逸夫楼 A101" })));
      return;
    }

    if (path.startsWith("/api/v1/official-jobs/")) {
      await fulfill(route, ok(job("poll", { warning: "" })));
      return;
    }

    await fulfill(route, ok({}));
  });
}

async function waitForServer() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Vite dev server did not become ready");
}

async function screenshot(page, name) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(assetsDir, `${name}.png`), fullPage: false });
  console.log(`captured ${name}.png`);
}

async function run() {
  await rm(assetsDir, { recursive: true, force: true });
  await mkdir(assetsDir, { recursive: true });

  const server = spawn(
    "npm",
    ["run", "dev:web", "--", "--host", "127.0.0.1", "--port", String(port)],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" },
  );

  server.stdout.on("data", (chunk) => process.stdout.write(chunk));
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer();
    const browser = await chromium.launch({ headless: true });

    const authPage = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    await installApiMocks(authPage, { initialAuth: false });
    await authPage.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await screenshot(authPage, "01-login");
    await authPage.getByRole("button", { name: "注册账号" }).click();
    await screenshot(authPage, "02-register");
    await authPage.getByRole("button", { name: "返回登录" }).click();
    await authPage.getByLabel("邮箱").fill("libyy.demo@njau.edu.cn");
    await authPage.getByLabel("密码").fill("correct-horse-260617");
    await screenshot(authPage, "03-login-filled");
    await authPage.getByRole("button", { name: "进入预约" }).click();
    await authPage.waitForURL("**/rooms");
    await screenshot(authPage, "04-after-login-rooms");
    await authPage.close();

    const credentialPage = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    await installApiMocks(credentialPage, { initialAuth: true, needsCredential: true });
    await credentialPage.goto(`${baseUrl}/credentials`, { waitUntil: "networkidle" });
    await credentialPage.getByLabel("学号").fill("2026300001");
    await credentialPage.getByLabel("统一认证密码").fill("campus-password");
    await screenshot(credentialPage, "05-campus-bind");
    await credentialPage.close();

    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    await installApiMocks(page, { initialAuth: true });

    await page.goto(`${baseUrl}/rooms`, { waitUntil: "networkidle" });
    await screenshot(page, "06-rooms");

    await page.goto(`${baseUrl}/rooms/101`, { waitUntil: "networkidle" });
    await page.locator(".uptime-kuma-heartbeat.available").nth(2).click();
    await page.locator(".uptime-kuma-heartbeat.available").nth(3).click();
    await page.getByText("王明").click();
    await page.getByText("陈雨").click();
    await screenshot(page, "07-room-detail-selection");

    await page.goto(`${baseUrl}/tasks`, { waitUntil: "networkidle" });
    await screenshot(page, "08-tasks");

    await page.goto(`${baseUrl}/tasks/new`, { waitUntil: "networkidle" });
    await page.getByLabel("房间").selectOption("101");
    await page.locator(".uptime-kuma-heartbeat.available").nth(4).click();
    await page.getByText("王明").click();
    await screenshot(page, "09-task-new");

    await page.goto(`${baseUrl}/teams`, { waitUntil: "networkidle" });
    await screenshot(page, "10-teams");

    await page.goto(`${baseUrl}/teams/team-alpha/invite`, { waitUntil: "networkidle" });
    await screenshot(page, "11-team-invite");

    await page.goto(`${baseUrl}/history`, { waitUntil: "networkidle" });
    await screenshot(page, "12-history");

    await browser.close();
  } finally {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      server.kill("SIGTERM");
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
