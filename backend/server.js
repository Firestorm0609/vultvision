const express = require('express');
const multer  = require('multer');
const ffmpeg  = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');
const fs      = require('fs');
const cors    = require('cors');

const app  = express();
const PORT = 3001;

const UPLOADS_DIR    = path.join(__dirname, '../uploads');
const RECORDINGS_DIR = path.join(__dirname, '../recordings');

[UPLOADS_DIR, RECORDINGS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({
  origin: ['https://vultvision.me', 'https://www.vultvision.me', 'http://localhost:8080'],
}));

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 150 * 1024 * 1024 }, // 150 MB max
  fileFilter: (req, file, cb) => {
    const ok = ['video/webm', 'video/mp4', 'application/octet-stream'].includes(file.mimetype);
    cb(ok ? null : new Error('Invalid file type'), ok);
  },
});

// ── POST /api/encode ────────────────────────────────────────────────────────
// Accepts: multipart/form-data with field "video" (WebM blob)
// Returns: { id, url, size } on success, { error } on failure
app.post('/api/encode', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file received.' });

  const id         = uuidv4();
  const inputPath  = req.file.path;
  const outputFile = `${id}.mp4`;
  const outputPath = path.join(RECORDINGS_DIR, outputFile);

  console.log(`[encode] start  id=${id}  input=${req.file.size} bytes`);

  ffmpeg(inputPath)
    .outputOptions([
      '-c:v libx264',
      '-preset fast',
      '-crf 23',
      '-c:a aac',
      '-b:a 128k',
      '-movflags +faststart', // stream-friendly MP4
      '-pix_fmt yuv420p',     // broad device compatibility
    ])
    .output(outputPath)
    .on('end', () => {
      fs.unlink(inputPath, () => {});
      const size = fs.statSync(outputPath).size;
      console.log(`[encode] done   id=${id}  output=${size} bytes`);

      res.json({
        id,
        url:  `/recordings/${outputFile}`,
        size,
      });

      // Auto-delete after 48 hours
      setTimeout(() => {
        fs.unlink(outputPath, () => {});
        console.log(`[cleanup] deleted ${outputFile}`);
      }, 48 * 60 * 60 * 1000);
    })
    .on('error', (err) => {
      fs.unlink(inputPath, () => {});
      console.error(`[encode] error  id=${id}`, err.message);
      res.status(500).json({ error: 'Encoding failed.', details: err.message });
    })
    .run();
});

// ── GET /api/health ─────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () =>
  console.log(`VultVision backend listening on 127.0.0.1:${PORT}`),
);
