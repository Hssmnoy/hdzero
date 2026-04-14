const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ======================
const BASE = "https://anime-hdzero.com";
const SAVE_DIR = "./data";
const RESUME_FILE = path.join(SAVE_DIR, "resume.json");
const STATE_FILE = path.join(SAVE_DIR, "state.json");

// ======================
const CATEGORY_IDS = [1,2,3];
const CATEGORY_NAMES = {
  1: "อนิเมะซับไทย",
  2: "อนิเมะพากย์ไทย",
  3: "เดอะมูฟวี่",
};

// ======================
const MODE = "normal"; // test | normal | update
const TEST_LIMIT = 2;
const BATCH_SIZE = 30;
const MAX_PAGES = 2;
const STOP_NO_UPDATE = 5;

// ======================
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR);

// ======================
function loadJSON(file, def) {
  if (!fs.existsSync(file)) return def;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return def;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function gitCommit(message) {
  try {
    execSync("git config user.name github-actions", { stdio: "inherit" });
    execSync("git config user.email github-actions@github.com", { stdio: "inherit" });

    execSync("git add .", { stdio: "inherit" });
    execSync(`git commit -m "${message}"`, { stdio: "inherit" });
    execSync("git push", { stdio: "inherit" });

    console.log("✅ COMMIT DONE");
  } catch (e) {
    console.log("⚠️ NO CHANGES");
  }
}

// ======================
async function getAnimeList(catId, page = 1) {
  const url = `${BASE}/cat/${catId}/page/${page}/`;
  const { data } = await axios.get(url);
  const $ = cheerio.load(data);

  const list = [];

  $(".zk_col").each((i, el) => {
    const link = $(el).attr("href");
    const title = $(el).find(".zk_title").text().trim();
    const image =
      $(el).find("img").attr("src") ||
      $(el).find("img").attr("data-src") ||
      "";

    if (link && title) {
      list.push({
        title,
        link: link.startsWith("http") ? link : BASE + link,
        image,
      });
    }
  });

  if (MODE === "test") return list.slice(0, TEST_LIMIT);
  return list;
}

// ======================
function extractEpisodeName(name) {
  const m = name.match(/ตอนที่\s*\d+/);
  return m ? m[0] : name;
}

// ======================
function extractUUID(html) {
  let m = html.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  if (m) return m[0];

  m = html.match(/link=([A-Za-z0-9+/=]+)/);
  if (m) {
    try {
      const d = Buffer.from(m[1], "base64").toString("utf-8");
      const u = d.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
      );
      if (u) return u[0];
    } catch {}
  }

  m = html.match(/media-player[^>]+src="[^"]+([0-9a-f-]{36})/i);
  if (m) return m[1];

  return null;
}

// ======================
function buildStream(id) {
  return {
    url: `https://files.akuma-player.xyz/view/${id}.m3u8`,
    backup: `https://akuma-player.xyz/play/${id}`,
  };
}

// ======================
async function getEpisodes(anime, resume) {
  const { data } = await axios.get(anime.link);
  const $ = cheerio.load(data);

  const list = [];
  const seen = new Set();

  $("a[href*='/watch/']").each((i, el) => {
    let href = $(el).attr("href");
    let name = $(el).text().trim();

    if (!href) return;
    if (!href.startsWith("http")) href = BASE + href;

    if (seen.has(href)) return;
    seen.add(href);

    list.push({ name, url: href });
  });

  const result = [];

  for (const ep of list) {
    if (resume[anime.title]?.includes(ep.url)) continue;

    const { data } = await axios.get(ep.url);
    const id = extractUUID(data);
    if (!id) continue;

    const stream = buildStream(id);

    result.push({
      name: extractEpisodeName(ep.name),
      url: stream.url,
      backup: stream.backup,
      image: anime.image,
      referer: BASE,
    });

    if (!resume[anime.title]) resume[anime.title] = [];
    resume[anime.title].push(ep.url);
  }

  return result;
}

// ======================
// SAVE PLAYLIST 

function savePlaylist(catId, newData, prefix = "playlist") {
  const jsonPath = path.join(SAVE_DIR, `${prefix}_${catId}.json`);
  const m3uPath = path.join(SAVE_DIR, `${prefix}_${catId}.m3u`);

  // =========================
  // 🔥 โหลดของเก่า
  const old = loadJSON(jsonPath, { groups: [] });

  const map = new Map();

  // ใส่ของเก่า
  for (const anime of old.groups || []) {
    map.set(anime.name, anime);
  }

  // ใส่ของใหม่ (overwrite ถ้าซ้ำ)
  for (const anime of newData) {
    map.set(anime.name, anime);
  }

  const merged = Array.from(map.values());

  // =========================
  // 🔥 build JSON ใหม่
  const json = {
    name: `Anime-hdzero ${CATEGORY_NAMES[catId]}`,
    updated: new Date().toLocaleString("th-TH"),
    image: "https://raw.githubusercontent.com/nongakka/logo/main/ChatGPT Image 14 เม.ย. 2569 09_46_35.png",
    url: `https://raw.githubusercontent.com/nongakka/hdzero/main/data/${prefix}_${catId}.json`,
    groups: merged,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));

  // =========================
  // 🔥 M3U ก็ใช้ merged เช่นกัน
  let m3u = "#EXTM3U\n\n";

  for (const anime of merged) {
    for (const ep of anime.episodes || []) {
      m3u += `#EXTINF:-1 tvg-logo="${anime.image}" group-title="${CATEGORY_NAMES[catId]}",${anime.name} - ${ep.name}\n`;
      m3u += `${ep.url}\n\n`;
    }
  }

  fs.writeFileSync(m3uPath, m3u);

  console.log(`💾 SAFE SAVE: ${prefix}_${catId} (merged)`);
}

// ======================
// UPDATE MODE
async function runUpdateMode() {
  console.log("🚀 UPDATE MODE");

  for (const catId of CATEGORY_IDS) {
    console.log("📁 CAT:", catId);

    const result = [];
    const latestEpMap = new Map(); // 🔥 เก็บ ep ล่าสุดของแต่ละ anime

    let noUpdateStreak = 0;
    let stopAll = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (stopAll) break;

      const list = await getAnimeList(catId, page);

      if (!list.length) break;

      for (const anime of list) {
        const ep = await getEpisodes(anime, {});

        const prev = latestEpMap.get(anime.title);

        // =========================
        // 🔥 เปรียบเทียบแบบถูกต้อง
        const prevCount = prev || 0;
        const newCount = ep.length;

        if (newCount > prevCount) {
          result.unshift({ ...anime, episodes: ep });
          latestEpMap.set(anime.title, newCount);

          noUpdateStreak = 0; // reset streak
        } else {
          noUpdateStreak++;
        }

        // =========================
        // 🔥 stop เฉพาะตอน “ไม่เจอ update ต่อเนื่อง”
        if (noUpdateStreak >= STOP_NO_UPDATE) {
          stopAll = true;
          break;
        }
      }
    }

    savePlaylist(catId, result, "update");
    gitCommit(`update cat ${catId}`);
  }
}

// ======================
// NORMAL MODE (RESUME FIXED)
async function run() {
  console.log("▶ NORMAL MODE (APPEND SAFE)");

  const state = loadJSON(STATE_FILE, {
    cat: {},
    count: 0,
  });

  const resume = loadJSON(RESUME_FILE, {});

  for (const catId of CATEGORY_IDS) {
    console.log("📁 CATEGORY:", catId);

    if (!state.cat[catId]) {
      state.cat[catId] = { page: 1, index: 0 };
    }

    let page = state.cat[catId].page;
    let index = state.cat[catId].index;

    let batch = [];

    // =========================
    // 🔥 LOAD OLD DATA (สำคัญมาก)
    const oldPath = path.join(SAVE_DIR, `playlist_${catId}.json`);
    const oldData = loadJSON(oldPath, { groups: [] });

    const map = new Map();

    // index ของเก่าใส่ map (กันซ้ำ)
    for (const a of oldData.groups) {
      map.set(a.name, a);
    }

    // =========================
    while (true) {
      const list = await getAnimeList(catId, page);

      if (!list.length) break;

      for (let i = index; i < list.length; i++) {
        const anime = list[i];

        const ep = await getEpisodes(anime, resume);

        const newItem = { ...anime, episodes: ep };

        // =========================
        // 🔥 ADD TO MAP (กันซ้ำ)
        map.set(anime.title, newItem);

        batch.push(newItem);

        state.count++;
        saveJSON(STATE_FILE, state);

        // =========================
        // batch save
        if (state.count % BATCH_SIZE === 0) {
          const merged = Array.from(map.values());

          savePlaylist(catId, merged, "playlist");
          gitCommit(`batch ${state.count} cat ${catId}`);

          batch = [];
        }

        // update resume
        state.cat[catId].page = page;
        state.cat[catId].index = i + 1;
        saveJSON(STATE_FILE, state);
      }

      page++;
      index = 0;

      state.cat[catId].page = page;
      state.cat[catId].index = 0;
      saveJSON(STATE_FILE, state);
    }

    // =========================
    // 🔥 FINAL MERGE + SAVE
    const finalData = Array.from(map.values());

    savePlaylist(catId, finalData, "playlist");
    gitCommit(`finish cat ${catId}`);
  }
}

async function runTestMode() {
  console.log("🧪 TEST MODE + SAVE PLAYLIST");

  for (const catId of CATEGORY_IDS) {
    const list = await getAnimeList(catId);

    const result = [];

    for (const anime of list) {
      console.log("🎬", anime.title);

      const episodes = await getEpisodes(anime, {});

      result.push({
        ...anime,
        episodes,
      });
    }

    // 👇 สำคัญ: SAVE ด้วย
    savePlaylist(catId, result, "test");

    console.log("💾 TEST PLAYLIST SAVED");
  }
}

// ======================
// SWITCH
(async () => {
  if (MODE === "update") return runUpdateMode();
  if (MODE === "normal") return run();
  if (MODE === "test") return runTestMode();
    console.log("🧪 TEST MODE");
    const list = await getAnimeList(CATEGORY_IDS[0]);
    console.log(list.map(x => x.title));
  
})();
