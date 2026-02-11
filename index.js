// index.js
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const FormData = require('form-data');
const fetch = require('node-fetch');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const upload = multer();

// Config from env
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || ''; // set on Railway
const BOT_NAME = process.env.BOT_NAME || 'Recording Bot';
const BOT_EMAIL = process.env.BOT_EMAIL || '';
const BOT_ZOOM_PASS = process.env.BOT_ZOOM_PASS || '';

/**
 * Session store: keeps Playwright browser/page and recording state.
 * For simple demo, we allow only a single session; extend to multi-session with session IDs.
 */
let session = {
  browser: null,
  context: null,
  page: null,
  recording: false,
  chunksDir: null,
  outputWebm: null,
  outputMp3: null,
};

// Basic web form to submit meeting link
app.get('/', (req, res) => {
  res.send(`
    <h2>Zoom Recording Bot</h2>
    <form method="POST" action="/join">
      <label>Meeting URL: <input name="meetingUrl" required style="width: 50%"></label><br><br>
      <label>Passcode (if any): <input name="passcode"></label><br><br>
      <label>Customer name (for n8n): <input name="customer_name"></label><br><br>
      <button type="submit">Start & Join</button>
    </form>
    <p>Call <code>POST /stop</code> to stop and upload to n8n.</p>
  `);
});

// Join route - starts the browser and recording
app.post('/join', async (req, res) => {
  const { meetingUrl, passcode, customer_name } = req.body;
  if (!meetingUrl) return res.status(400).send('meetingUrl required');

  if (session.recording) return res.status(409).send('Bot already recording. Stop first.');

  try {
    // Launch Chromium
    const browser = await chromium.launch({
      // Playwright by default is headless; for reliability in some setups, set headless: false
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream']
    });
    const context = await browser.newContext({
      // using a typical desktop UA helps avoid blocks
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    session.browser = browser;
    session.context = context;
    session.page = page;

    // Expose a function to receive audio chunks from the page
    const chunksDir = path.join(__dirname, 'chunks-' + Date.now());
    fs.mkdirSync(chunksDir);
    session.chunksDir = chunksDir;

    await page.exposeFunction('sendChunkToServer', async (b64) => {
      // Called from the page when a MediaRecorder chunk is available
      const buf = Buffer.from(b64, 'base64');
      const filename = path.join(session.chunksDir, `${Date.now()}.webm`);
      fs.writeFileSync(filename, buf);
      console.log('Saved chunk', filename);
    });

    // Navigate to Zoom meeting link
    await page.goto(meetingUrl, { waitUntil: 'networkidle', timeout: 60000 });

    // On many Zoom links, there's a button "Join from your browser"
    // We'll attempt to click it
    try {
      await page.waitForSelector('a.join-from-browser', { timeout: 6000 });
      await page.click('a.join-from-browser');
    } catch (e) {
      // fallback: try common selectors or buttons
      console.log('join-from-browser link not found, attempting button alternatives');
      try {
        await page.click('a[href*="join?"]');
      } catch (err) {
        // proceed - some Zoom links may auto-redirect
      }
    }

    // Wait for web client to load audio elements. This may vary; we wait for audio or join buttons
    await page.waitForTimeout(3000);

    // If sign-in is required and BOT_EMAIL & BOT_ZOOM_PASS are provided, attempt sign-in
    if (await page.$('input[type="email"]') && BOT_EMAIL && BOT_ZOOM_PASS) {
      try {
        await page.fill('input[type="email"]', BOT_EMAIL);
        await page.fill('input[type="password"]', BOT_ZOOM_PASS);
        await page.click('button[type="submit"]');
        console.log('Attempted Zoom sign-in for bot account');
      } catch (err) {
        console.log('Sign-in attempt failed or not necessary', err.message);
      }
    }

    // If a passcode input is visible, fill it
    try {
      const passSelector = 'input[aria-label*="Passcode"], input[type="password"], input[placeholder*="passcode"]';
      if (passcode && await page.$(passSelector)) {
        await page.fill(passSelector, passcode);
        await page.keyboard.press('Enter');
        console.log('Entered passcode');
      }
    } catch (e) {
      console.log('No passcode field or handled earlier', e.message);
    }

    // Wait for join confirmation and remote audio elements to appear
    await page.waitForTimeout(5000);

    // Start capturing audio inside the page by injecting a script that finds audio elements,
    // connects to an AudioContext and records mixed output, sending chunks to host via sendChunkToServer
    await page.evaluate(() => {
      // Double-check we don't run twice
      if (window.__recorderStarted) return;
      window.__recorderStarted = true;

      (async () => {
        try {
          // Wait for audio/video elements
          const waitForAudio = (timeout = 20000) => new Promise((resolve) => {
            const start = Date.now();
            const check = () => {
              // Find audio/video elements with srcObject or src
              const audios = Array.from(document.querySelectorAll('audio, video'));
              if (audios.length) return resolve(audios[0]);
              if (Date.now() - start > timeout) return resolve(null);
              setTimeout(check, 500);
            };
            check();
          });

          const mediaEl = await waitForAudio(20000);

          // If we found element(s), mix them into an AudioContext
          const audioEls = document.querySelectorAll('audio, video');
          if (!audioEls || audioEls.length === 0) {
            console.warn('No audio/video elements found on Zoom page - recording may fail.');
            return;
          }

          const audioContext = new (window.AudioContext || window.webkitAudioContext)();
          const dest = audioContext.createMediaStreamDestination();

          // connect each audio element to the dest
          audioEls.forEach((el) => {
            try {
              const source = audioContext.createMediaElementSource(el);
              source.connect(dest);
              // also keep it connected to default output
              source.connect(audioContext.destination);
            } catch (e) {
              // CreateMediaElementSource can throw if cross-origin or not allowed, skip in that case
              console.warn('Failed to create source for element', e);
            }
          });

          // Create MediaRecorder for mixed stream
          const mixedStream = dest.stream;
          const options = { mimeType: 'audio/webm;codecs=opus' };
          const recorder = new MediaRecorder(mixedStream, options);
          recorder.ondataavailable = async (ev) => {
            if (!ev.data || ev.data.size === 0) return;
            const arrayBuffer = await ev.data.arrayBuffer();
            const b64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
            if (window.sendChunkToServer) {
              window.sendChunkToServer(b64);
            }
          };
          recorder.start(5000); // emit chunks every 5s
          window.__recorder = recorder;

          console.log('Recording started in page');
        } catch (err) {
          console.error('Error inside page recorder', err);
        }
      })();
    });

    session.recording = true;
    session.meetingUrl = meetingUrl;
    session.customer_name = customer_name;

    res.send('Bot joined meeting and started recording. Call POST /stop to finish and upload.');
  } catch (err) {
    console.error('Error joining meeting:', err);
    res.status(500).send('Failed to join and record: ' + err.message);
  }
});

// Stop route - stops recording, combines chunks, converts, then uploads to n8n
app.post('/stop', async (req, res) => {
  if (!session.recording) return res.status(400).send('No active recording');

  try {
    // Stop the MediaRecorder in page
    try {
      await session.page.evaluate(() => {
        if (window.__recorder && window.__recorder.state !== 'inactive') {
          window.__recorder.stop();
          console.log('Stopped recorder in page');
        }
      });
    } catch (e) {
      console.warn('Error stopping recorder in page', e.message);
    }

    // Give some time for last chunks to arrive
    await new Promise((r) => setTimeout(r, 3000));

    // Merge webm chunks to single file (just concatenate may work for webm/opus)
    const chunks = fs.readdirSync(session.chunksDir).sort();
    if (chunks.length === 0) throw new Error('No chunks recorded');

    const outputWebm = path.join(__dirname, `meeting-${Date.now()}.webm`);
    const writeStream = fs.createWriteStream(outputWebm);
    for (const c of chunks) {
      const buf = fs.readFileSync(path.join(session.chunksDir, c));
      writeStream.write(buf);
    }
    writeStream.end();
    session.outputWebm = outputWebm;

    // Convert to mp3 using ffmpeg-static
    const outputMp3 = path.join(__dirname, `meeting-${Date.now()}.mp3`);
    session.outputMp3 = outputMp3;

    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, [
        '-y',
        '-i', session.outputWebm,
        '-vn',
        '-acodec', 'libmp3lame',
        '-ac', '1',
        '-ar', '16000', // 16kHz good for speech models
        '-b:a', '64k',
        outputMp3,
      ]);

      ff.stderr.on('data', (d) => console.log('ffmpeg:', d.toString()));
      ff.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('ffmpeg exited with ' + code));
      });
    });

    // Upload to n8n webhook as multipart/form-data
    if (!N8N_WEBHOOK_URL) {
      console.warn('N8N_WEBHOOK_URL not configured — skipping upload');
    } else {
      const form = new FormData();
      form.append('audio', fs.createReadStream(session.outputMp3));
      form.append('customer_name', session.customer_name || 'Unknown');

      console.log('Uploading to n8n...');
      const resp = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        body: form,
        headers: form.getHeaders()
      });

      const txt = await resp.text();
      console.log('n8n response:', resp.status, txt);
    }

    // Cleanup: close browser
    try {
      await session.browser.close();
    } catch (e) { console.warn('Error closing browser:', e.message); }

    // mark not recording
    session = { browser: null, context: null, page: null, recording: false, chunksDir: null };

    res.send('Recording stopped, converted and uploaded (if N8N_WEBHOOK_URL set).');
  } catch (err) {
    console.error('Error stopping recording:', err);
    res.status(500).send('Failed to stop: ' + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Zoom recording bot listening on ${PORT}`);
});
