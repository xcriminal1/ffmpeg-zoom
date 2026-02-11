const express = require("express");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");
const FormData = require("form-data");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

/**
 * SINGLE SESSION STATE
 */
let session = {
  browser: null,
  page: null,
  recording: false,
  meetingUrl: null,
  customerName: "Unknown",
  chunksDir: null,
};

/**
 * STATUS ENDPOINT
 */
app.get("/status", (req, res) => {
  res.json({
    recording: session.recording,
    meetingUrl: session.meetingUrl,
    customerName: session.customerName,
  });
});

/**
 * JOIN MEETING
 * Called from Vercel frontend
 */
app.get("/join", async (req, res) => {
  if (session.recording) {
    return res.status(409).send("Bot already recording");
  }

  const { meetingUrl, passcode, customer_name } = req.query;
  if (!meetingUrl) return res.status(400).send("meetingUrl is required");

  session.customerName = customer_name || "Unknown";
  session.meetingUrl = meetingUrl;

  try {
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    session.browser = browser;
    session.page = page;

    // Create temp folder for chunks
    const chunksDir = path.join(__dirname, `chunks-${Date.now()}`);
    fs.mkdirSync(chunksDir);
    session.chunksDir = chunksDir;

    await page.exposeFunction("sendChunk", (b64) => {
      const buf = Buffer.from(b64, "base64");
      fs.writeFileSync(`${chunksDir}/${Date.now()}.webm`, buf);
    });

    await page.goto(meetingUrl, { waitUntil: "networkidle", timeout: 60000 });

    // Try joining via browser
    try {
      await page.click("text=Join from your browser", { timeout: 6000 });
    } catch {}

    // Handle passcode if present
    if (passcode) {
      try {
        await page.fill("input[type=password]", passcode);
        await page.keyboard.press("Enter");
      } catch {}
    }

    await page.waitForTimeout(5000);

    // Inject audio recorder
    await page.evaluate(() => {
      if (window.__started) return;
      window.__started = true;

      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = ctx.createMediaStreamDestination();

      document.querySelectorAll("audio, video").forEach((el) => {
        try {
          const src = ctx.createMediaElementSource(el);
          src.connect(dest);
          src.connect(ctx.destination);
        } catch {}
      });

      const recorder = new MediaRecorder(dest.stream);
      recorder.ondataavailable = async (e) => {
        const buf = await e.data.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        window.sendChunk(b64);
      };

      recorder.start(5000);
      window.__recorder = recorder;
    });

    session.recording = true;
    res.send("Bot joined meeting and started recording");
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to join meeting");
  }
});

/**
 * STOP + SEND TO N8N
 */
app.post("/stop", async (req, res) => {
  if (!session.recording) {
    return res.status(400).send("No active recording");
  }

  try {
    await session.page.evaluate(() => {
      if (window.__recorder) window.__recorder.stop();
    });

    await new Promise((r) => setTimeout(r, 3000));

    const webmFile = `meeting-${Date.now()}.webm`;
    const mp3File = `meeting-${Date.now()}.mp3`;

    const chunks = fs.readdirSync(session.chunksDir);
    const ws = fs.createWriteStream(webmFile);
    chunks.forEach((c) =>
      ws.write(fs.readFileSync(`${session.chunksDir}/${c}`))
    );
    ws.end();

    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, [
        "-i",
        webmFile,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "64k",
        mp3File,
      ]);
      ff.on("close", (code) => (code === 0 ? resolve() : reject()));
    });

    if (N8N_WEBHOOK_URL) {
      const form = new FormData();
      form.append("audio", fs.createReadStream(mp3File));
      form.append("customer_name", session.customerName);

      await fetch(N8N_WEBHOOK_URL, {
        method: "POST",
        body: form,
        headers: form.getHeaders(),
      });
    }

    await session.browser.close();

    session = {
      browser: null,
      page: null,
      recording: false,
      meetingUrl: null,
      customerName: "Unknown",
      chunksDir: null,
    };

    res.send("Recording stopped and sent to n8n");
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to stop recording");
  }
});

app.listen(PORT, () => {
  console.log(`Zoom bot backend running on port ${PORT}`);
});
