
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
const MODE = "update"; // test | normal | update
const TEST_LIMIT = 2;
const BATCH_SIZE = 30;
const MAX_PAGES = 260;
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

    // 🔥 แก้ตรงนี้
    execSync("git pull --rebase --autostash", { stdio: "inherit" });
    execSync("git push", { stdio: "inherit" });

    console.log("✅ COMMIT DONE");
  } catch (e) {
    console.log("⚠️ NO CHANGES");
  }
}
// ======================
async function getAnimeList(catId, page = 1) {
  const url = `${BASE}/cat/${catId}/&page=${page}`;

  console.log(`📥 Fetch list | cat=${catId} page=${page}`);
  console.log(`🌐 URL: ${url}`);

  let data;

try {
  const res = await axios.get(url, {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  data = res.data;
} catch (err) {
  console.log(`❌ FAIL PAGE=${page}`);
  return [];
}
  const $ = cheerio.load(data);

  // ======================
  // 🔥 FIX: check real DOM items ก่อน loop
  const items = $(".zk_col");
  console.log(`🔎 DOM items: ${items.length}`);

  if (items.length === 0) {
    console.log(`🛑 EMPTY PAGE → STOP`);
    return [];
  }

  const list = [];

  items.each((i, el) => {
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

  console.log(`📊 parsed: ${list.length}`);

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
    const key = anime.link;

if (!resume[key]) resume[key] = [];
if (resume[key].includes(ep.url)) continue;

resume[key].push(ep.url);

  let data;

try {
  const res = await axios.get(ep.url, {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  data = res.data;
} catch (err) {
  console.log(`❌ FAIL EP=${ep.url}`);
  continue;
}

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

function savePlaylist(catId, allData, prefix = "playlist") {
  const jsonPath = path.join(SAVE_DIR, `${prefix}_${catId}.json`);
  const m3uPath = path.join(SAVE_DIR, `${prefix}_${catId}.m3u`);

  // ======================
  // 🔥 LOAD OLD
  const old = loadJSON(jsonPath, null);

  // ======================
  // 🔥 BUILD NEW BASE
  const newGroups = allData.map((anime) => ({
    name: anime.title,
    image: anime.image,
    stations: anime.episodes.map((ep) => ({
      name: ep.name,
      image: ep.image,
      url: ep.url,
      backup: ep.backup,
      referer: ep.referer,
    })),
  }));

  // ======================
  // 🔥 MERGE OLD + NEW
  let mergedGroups = [];

  if (old && old.groups) {
    const map = new Map();

    for (const g of old.groups) {
      map.set(g.name, g);
    }

    for (const g of newGroups) {
      if (map.has(g.name)) {
        const oldGroup = map.get(g.name);

        const epMap = new Map();

        for (const e of oldGroup.stations) {
          epMap.set(e.url, e);
        }

        for (const e of g.stations) {
          epMap.set(e.url, e);
        }

        oldGroup.stations = Array.from(epMap.values());
        map.set(g.name, oldGroup);
      } else {
        map.set(g.name, g);
      }
    }

    mergedGroups = Array.from(map.values());
  } else {
    mergedGroups = newGroups;
  }

  // ======================
  // 🔥 FINAL JSON
  const json = {
    name: `Anime-hdzero ${CATEGORY_NAMES[catId]}`,
    author: (() => {
  const now = new Date();
  const d = String(now.getDate()).padStart(2, "0");
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const y = now.getFullYear() + 543;

  return `อัพเดตล่าสุด ${d}/${m}/${y}`;
})(),
    image: "https://raw.githubusercontent.com/nongakka/logo/main/ChatGPT Image 14 เม.ย. 2569 09_46_35.png",
    url: `https://raw.githubusercontent.com/nongakka/hdzero/main/data/playlist_${catId}.json`,
    groups: mergedGroups,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));

  // ======================
  // 🔥 FIX M3U (ต้องใช้ mergedGroups ไม่ใช่ allData)
  let m3u = "#EXTM3U\n\n";

  for (const anime of mergedGroups) {
    for (const ep of anime.stations) {
      m3u += `#EXTINF:-1 tvg-logo="${anime.image}" group-title="${CATEGORY_NAMES[catId]}",${anime.name} - ${ep.name}\n`;
      m3u += `${ep.url}\n\n`;
    }
  }

  fs.writeFileSync(m3uPath, m3u);

  console.log(`💾 SAVE: ${prefix}_${catId}`);
}

// =========================
// สร้าง index.json
// =========================
function generateIndex() {
  const baseRaw = "https://raw.githubusercontent.com/nongakka/hdzero/main/data/";

  const index = {
    name: "Anime-hdzero Playlist",
    author: (() => {
      const now = new Date();
      const d = String(now.getDate()).padStart(2, "0");
      const m = String(now.getMonth() + 1).padStart(2, "0");
      const y = now.getFullYear() + 543;
      return `อัพเดตล่าสุด ${d}/${m}/${y}`;
    })(),
    image: "https://raw.githubusercontent.com/nongakka/logo/main/ChatGPT Image 14 เม.ย. 2569 09_46_35.png",
    url: "",
    groups: []
  };

  for (const catId of CATEGORY_IDS) {
    index.groups.push({
      name: CATEGORY_NAMES[catId],
      url: `${baseRaw}playlist_${catId}.json`
    });
  }

  fs.writeFileSync(
    path.join(SAVE_DIR, `index.json`),
    JSON.stringify(index, null, 2)
  );

  console.log("📦 index.json created");
}

// ======================
// UPDATE MODE
async function runUpdateMode() {
  console.log("🚀 UPDATE MODE");

  const resume = loadJSON(RESUME_FILE, {});

  for (const catId of CATEGORY_IDS) {
    console.log("📁 CAT:", CATEGORY_NAMES[catId]);

    const result = [];
    let noUpdate = 0;
    const seen = new Map();

    for (let page = 1; page <= 3; page++) {
      const list = await getAnimeList(catId, page);

      for (const anime of list) {
        const ep = await getEpisodes(anime, resume);

        const old = seen.get(anime.title);

        if (!old) {
          result.unshift({ ...anime, episodes: ep });
          seen.set(anime.title, ep.length);
          noUpdate = 0;
          continue;
        }

        if (ep.length > 0 && ep.length !== old) {
          result.unshift({ ...anime, episodes: ep });
          seen.set(anime.title, ep.length);
          noUpdate = 0;
        } else {
          noUpdate++;
        }

        if (noUpdate >= STOP_NO_UPDATE) break;
      }

      if (noUpdate >= STOP_NO_UPDATE) break;
    }

    saveJSON(RESUME_FILE, resume);
    savePlaylist(catId, result, "update");
    generateIndex();
  }
}
// ======================
// NORMAL MODE (RESUME)
async function run() {
  console.log("▶ NORMAL MODE");

  const state = loadJSON(STATE_FILE, { index: {}, count: 0, done: {} });
  const resume = loadJSON(RESUME_FILE, {});

  for (const catId of CATEGORY_IDS) {
    console.log(`\n🚀 START CATEGORY ${catId}`);

    console.log(`📂 Start category: ${catId}`);
    console.log(`📥 GET ANIME LIST`);

    const list = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      console.log(`📄 page=${page}`);

      const pageList = await getAnimeList(catId, page);
      list.push(...pageList);
    }

    console.log(`📊 LIST SIZE: ${list.length}`);

    if (!state.index[catId]) {
      state.index[catId] = 0;
    }

    const all = [];

    console.log(`📌 START LOOP ANIME`);

    for (let i = state.index[catId]; i < list.length; i++) {
      const anime = list[i];

      console.log(`\n🎬 ${anime.title}`);
      console.log(`🔗 ${anime.link}`);

      const ep = await getEpisodes(anime, resume);

      console.log(`✔ EPISODES: ${ep.length}`);

      all.push({ ...anime, episodes: ep });

      // UPDATE STATE
      state.index[catId] = i + 1;
      state.count = (state.count || 0) + 1;
      saveJSON(STATE_FILE, state);

      // SAVE + COMMIT
      if (state.count % BATCH_SIZE === 0) {
        console.log(`💾 BATCH SAVE`);
        savePlaylist(catId, all, "playlist");
        gitCommit(`batch ${state.count} cat ${catId}`);
      }
    }

    console.log(`💾 FINAL SAVE CATEGORY ${catId}`);
    savePlaylist(catId, all, "playlist");
    generateIndex();
    gitCommit(`finish category ${catId}`);

    console.log(`✅ Done category: ${catId}`);
  }

  console.log("🎉 ALL CATEGORY DONE");
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
