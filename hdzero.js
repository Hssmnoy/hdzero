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
const CATEGORY_IDS = [1, 2, 3];
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

// ======================
function gitCommit(message) {
  try {
    execSync("git config user.name github-actions", { stdio: "inherit" });
    execSync("git config user.email github-actions@github.com", { stdio: "inherit" });
    execSync("git add .", { stdio: "inherit" });
    execSync(`git commit -m "${message}"`, { stdio: "inherit" });
    execSync("git push", { stdio: "inherit" });
    console.log("✅ COMMIT DONE");
  } catch {
    console.log("⚠️ NO CHANGES");
  }
}

// ======================
async function getAnimeList(catId, page = 1) {
  const url = `${BASE}/cat/${catId}/page/${page}/`;

  let data;
  try {
    data = (await axios.get(url)).data;
  } catch {
    return [];
  }

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
function buildStream(id) {
  return {
    url: `https://files.akuma-player.xyz/view/${id}.m3u8`,
    backup: `https://akuma-player.xyz/play/${id}`,
  };
}

// ======================
async function getEpisodes(anime, resume) {
  let data;
  try {
    data = (await axios.get(anime.link)).data;
  } catch {
    return [];
  }

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
    resume[anime.title] = resume[anime.title] || [];

    if (resume[anime.title].includes(ep.url)) continue;

    let html;
    try {
      html = (await axios.get(ep.url)).data;
    } catch {
      continue;
    }

    const m = html.match(/[0-9a-f-]{36}/i);
    if (!m) continue;

    const stream = buildStream(m[0]);

    result.push({
      name: extractEpisodeName(ep.name),
      url: stream.url,
      backup: stream.backup,
      image: anime.image,
      referer: BASE,
    });

    resume[anime.title].push(ep.url);
  }

  return result;
}

// ======================
function loadPlaylistMap(catId) {
  const file = path.join(SAVE_DIR, `playlist_${catId}.json`);
  if (!fs.existsSync(file)) return new Map();

  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    const map = new Map();

    for (const anime of data.groups || []) {
      // FIX: รองรับทั้ง name/title กันพัง
      map.set(anime.name || anime.title, anime);
    }

    return map;
  } catch {
    return new Map();
  }
}

// ======================
function savePlaylist(catId, allData, prefix = "playlist") {
  const jsonPath = path.join(SAVE_DIR, `${prefix}_${catId}.json`);
  const m3uPath = path.join(SAVE_DIR, `${prefix}_${catId}.m3u`);

  const json = {
    name: `Anime-hdzero ${CATEGORY_NAMES[catId]}`,
    updated: new Date().toLocaleString("th-TH"),
    image: "https://raw.githubusercontent.com/nongakka/logo/main/data/ChatGPT Image 14 เม.ย. 2569 09_46_35.png",
    url: `https://raw.githubusercontent.com/nongakka/hdzero/main/data/playlist_${catId}.json`,
    groups: (allData || []).map((anime) => ({
      name: anime.title,
      image: anime.image,
      stations: (anime.episodes || []).map((ep) => ({
        name: ep.name,
        image: ep.image,
        url: ep.url,
        backup: ep.backup,
        referer: ep.referer,
      })),
    })),
  };

  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));

  let m3u = "#EXTM3U\n\n";
  for (const anime of allData) {
    for (const ep of anime.episodes || []) {
      m3u += `#EXTINF:-1 tvg-logo="${anime.image}",${anime.title} - ${ep.name}\n`;
      m3u += `${ep.url}\n\n`;
    }
  }

  fs.writeFileSync(m3uPath, m3u);
}

// ======================
// UPDATE MODE (คืนของเดิม)
async function runUpdateMode() {
  console.log("🚀 UPDATE MODE");

  for (const catId of CATEGORY_IDS) {
    const result = [];
    let noUpdate = 0;
    const seen = new Map();

    for (let page = 1; page <= MAX_PAGES; page++) {
      const list = await getAnimeList(catId, page);

      for (const anime of list) {
        const ep = await getEpisodes(anime, {});

        const old = seen.get(anime.title);

        if (!old || ep.length > old) {
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

    savePlaylist(catId, result, "update");
  }
}

// ======================
// NORMAL MODE (แก้เฉพาะ crash + ไม่แตะ logic)
async function run() {
  console.log("▶ NORMAL MODE");

  const state = loadJSON(STATE_FILE, { index: {}, count: {} });
  const resume = loadJSON(RESUME_FILE, {});

  for (const catId of CATEGORY_IDS) {
    console.log(`📂 Start category: ${catId}`);

    const map = loadPlaylistMap(catId);

    const list = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const pageList = await getAnimeList(catId, page);
      list.push(...pageList);
    }

    if (!state.index[catId]) state.index[catId] = 0;
    if (!state.count[catId]) state.count[catId] = 0;

    for (let i = state.index[catId]; i < list.length; i++) {
      const anime = list[i];

      const ep = await getEpisodes(anime, resume);

      // FIX กัน undefined หาย
      map.set(anime.title, {
        ...anime,
        episodes: ep || [],
      });

      state.index[catId] = i + 1;
      state.count[catId]++;

      saveJSON(STATE_FILE, state);

      if (state.count[catId] % BATCH_SIZE === 0) {
        savePlaylist(catId, Array.from(map.values()), "playlist");
        gitCommit(`batch ${state.count[catId]} cat ${catId}`);
      }
    }

    savePlaylist(catId, Array.from(map.values()), "playlist");
    gitCommit(`finish category ${catId}`);

    console.log(`✅ Done category: ${catId}`);
  }

  console.log("🎉 ALL CATEGORY DONE");
}

// ======================
(async () => {
  if (MODE === "update") return runUpdateMode();
  if (MODE === "normal") return run();
})();
