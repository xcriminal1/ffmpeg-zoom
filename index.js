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

app.options("*", cors());

/* -------------------- CONFIG -------------------- */
const PORT = 8080;
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
  res.send("Jitsi bot backend is running");
});

/* -------------------- STATUS (NO CACHE) -------------------- */
app.get("/status", (req, res) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
  });

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

  const { meetingUrl, customer_name } = req.body;
  if (!meetingUrl) {
    return res.status(400).json({ error: "meetingUrl required" });
  }

  res.json({ status: "accepted", message: "Jitsi bot starting" });

  startJitsiBot(meetingUrl, customer_name)
    .catch(err => {
      console.error("Jitsi bot failed:", err);
      cleanup();
    });
});

/* -------------------- STOP (MANUAL) -------------------- */
app.post("/stop", async (req, res) => {
  if (!state.recording) {
    return res.status(400).json({ error: "No active recording" });
  }

  res.json({ status: "stopping" });
  await autoStop("manual-stop");
});

/* -------------------- AUTO STOP -------------------- */
async function autoStop(reason) {
  if (!state.recording) return;

  console.log("Auto-stop triggered:", reason);

  try {
    await state.page.evaluate(() => {
      if (window.__recorder && window.__recorder.state !== "inactive") {
        window.__recorder.stop();
      }
    });

    await new Promise(r => setTimeout(r, 3000));
    await convertAndSend();
  } catch (err) {
    console.error("Auto-stop error:", err);
  } finally {
    cleanup();
  }
}

/* -------------------- CORE JITSI LOGIC -------------------- */
async function startJitsiBot(meetingUrl, customerName) {
  state.recording = true;
  state.meetingUrl = meetingUrl;
  state.customerName = customerName || "Unknown";

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--autoplay-policy=no-user-gesture-required",
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

  await page.exposeFunction("notifyMeetingEnded", async () => {
    console.log("Browser detected meeting end");
    await autoStop("meeting-ended");
  });

  console.log("Joining Jitsi:", meetingUrl);
  await page.goto(meetingUrl, { waitUntil: "networkidle", timeout: 60000 });

  /* -------- PREJOIN FIX -------- */
  await page.waitForTimeout(3000);

  await page.evaluate(() => {
    const nameInput = document.querySelector('input[name="displayName"]');
    if (nameInput) {
      nameInput.value = "🤖 AI Recorder";
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    }

    const prejoinBtn =
      document.querySelector('[data-testid="prejoin.joinMeeting"]') ||
      document.querySelector('button[type="submit"]');

    if (prejoinBtn) prejoinBtn.click();
  });

  console.log("Join clicked, waiting for media...");
  await page.waitForTimeout(8000);

  /* -------- AUDIO + AUTO LEAVE -------- */
  await page.evaluate(() => {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();

    function connectAudio() {
      document.querySelectorAll("audio").forEach(el => {
        try {
          if (!el.__connected) {
            const src = ctx.createMediaElementSource(el);
            src.connect(dest);
            src.connect(ctx.destination);
            el.__connected = true;
          }
        } catch {}
      });
    }

    connectAudio();

    const recorder = new MediaRecorder(dest.stream);
    recorder.ondataavailable = async e => {
      const buf = await e.data.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      window.sendChunk(b64);
    };

    recorder.start(5000);
    window.__recorder = recorder;

    const observer = new MutationObserver(() => {
      connectAudio();
      const participants = document.querySelectorAll('[class*="participant"]');
      if (participants.length <= 1) {
        window.notifyMeetingEnded();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener("beforeunload", () => {
      window.notifyMeetingEnded();
    });
  });

  console.log("Jitsi recording started");
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

  console.log("Session cleaned up");
}

/* -------------------- START SERVER -------------------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Jitsi bot server listening on ${PORT}`);
});
