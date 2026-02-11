const express = require("express");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");
const FormData = require("form-data");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();

/* -------------------- MIDDLEWARE -------------------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-bot-secret"]
}));

// Explicit preflight support (IMPORTANT)
app.options("*", cors());

/* -------------------- CONFIG -------------------- */
const PORT = 8080; // Railway-friendly, locked
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

/* -------------------- SESSION STATE -------------------- */
let state = {
  recording: false,
  meetingUrl: null,
  customerName: "Unknown",
  browser: null,
  page: null,
  chunksDir: null
};

/* -------------------- HEALTH -------------------- */
app.get("/", (req, res) => {
  res.send("Backend is running");
});

/* -------------------- STATUS -------------------- */
app.get("/status", (req, res) => {
  res.json({
    recording: state.recording,
    meetingUrl: state.meetingUrl,
    customerName: state.customerName
  });
});

/* -------------------- JOIN (POST – NON BLOCKING) -------------------- */
app.post("/join", async (req, res) => {
  if (state.recording) {
    return res.status(409).json({ error: "Already recording" });
  }

  const { meetingUrl, passcode, customer_name } = req.body;
  if (!meetingUrl) {
    return res.status(400).json({ error: "meetingUrl required" });
  }

  // Respond immediately (CRITICAL)
  res.json({ status: "accepted", message: "Bot starting in background" });

  // Run bot in background
  startZoomBot(meetingUrl, passcode, customer_name)
    .catch(err => {
      console.error("Zoom bot failed:", err);
      cleanup();
    });
});

/* -------------------- STOP -------------------- */
app.post("/stop", async (req, res) => {
  if (!state.recording) {
    return res.status(400).json({ error: "No active recording" });
  }

  res.json({ status: "stopping" });

  try {
    await state.page.evaluate(() => {
      if (window.__recorder) window.__recorder.stop();
    });

    await new Promise(r => setTimeout(r, 3000));
    await convertAndSend();
  } catch (err) {
    console.error("Stop error:", err);
  } finally {
    cleanup();
  }
});

/* -------------------- CORE LOGIC -------------------- */
async function startZoomBot(meetingUrl, passcode, customerName) {
  state.recording = true;
  state.meetingUrl = meetingUrl;
  state.customerName = customerName || "Unknown";

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream"
    ]
  });

  const page = await browser.newPage();
  state.browser = browser;
  state.page = page;

  const chunksDir = path.join(__dirname, `chunks-${Date.now()}`);
  fs.mkdirSync(chunksDir);
  state.chunksDir = chunksDir;

  await page.exposeFunction("sendChunk", (b64) => {
    const buf = Buffer.from(b64, "base64");
    fs.writeFileSync(`${chunksDir}/${Date.now()}.webm`, buf);
  });

  console.log("Opening meeting:", meetingUrl);
  await page.goto(meetingUrl, { waitUntil: "networkidle", timeout: 60000 });

  try {
    await page.click("text=Join from your browser", { timeout: 8000 });
  } catch {
    console.log("Join from browser button not found");
  }

  if (passcode) {
    try {
      await page.fill("input[type=password]", passcode);
      await page.keyboard.press("Enter");
    } catch {}
  }

  await page.waitForTimeout(5000);

  await page.evaluate(() => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ctx.createMediaStreamDestination();

    document.querySelectorAll("audio,video").forEach(el => {
      try {
        const src = ctx.createMediaElementSource(el);
        src.connect(dest);
        src.connect(ctx.destination);
      } catch {}
    });

    const recorder = new MediaRecorder(dest.stream);
    recorder.ondataavailable = async e => {
      const buf = await e.data.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      window.sendChunk(b64);
    };

    recorder.start(5000);
    window.__recorder = recorder;
  });

  console.log("Recording started");
}

/* -------------------- CONVERT & SEND -------------------- */
async function convertAndSend() {
  const webm = `meeting-${Date.now()}.webm`;
  const mp3 = `meeting-${Date.now()}.mp3`;

  const files = fs.readdirSync(state.chunksDir);
  const ws = fs.createWriteStream(webm);
  files.forEach(f => ws.write(fs.readFileSync(`${state.chunksDir}/${f}`)));
  ws.end();

  await new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      "-i", webm,
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "64k",
      mp3
    ]);
    ff.on("close", c => c === 0 ? resolve() : reject());
  });

  if (N8N_WEBHOOK_URL) {
    const form = new FormData();
    form.append("audio", fs.createReadStream(mp3));
    form.append("customer_name", state.customerName);

    await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      body: form,
      headers: form.getHeaders()
    });

    console.log("Audio sent to n8n");
  }
}

/* -------------------- CLEANUP -------------------- */
async function cleanup() {
  try {
    if (state.browser) await state.browser.close();
  } catch {}

  state = {
    recording: false,
    meetingUrl: null,
    customerName: "Unknown",
    browser: null,
    page: null,
    chunksDir: null
  };

  console.log("Cleaned up session");
}

/* -------------------- START SERVER -------------------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
});
