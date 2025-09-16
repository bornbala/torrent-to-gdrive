import express from 'express';
import bodyParser from 'body-parser';
import WebTorrent from 'webtorrent';
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { authenticate } from '@google-cloud/local-auth';
import { PassThrough } from 'stream';

const app = express();
const port = 3000;

// Google Drive API setup
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

app.use(bodyParser.urlencoded({ extended: true }));

// Serve input form
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Torrent to Google Drive</title></head>
      <body>
        <h1>Enter Torrent Magnet URL</h1>
        <form action="/upload" method="POST">
          <input type="text" name="magnetURI" placeholder="Paste magnet link here" style="width: 400px;" required />
          <button type="submit">Upload to Google Drive</button>
        </form>
      </body>
    </html>
  `);
});

// Load saved credentials if exist
async function loadSavedCredentialsIfExist() {
  try {
    const content = await fs.promises.readFile(TOKEN_PATH, 'utf-8');
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch {
    return null;
  }
}

// Save credentials after first auth
async function saveCredentials(client) {
  const content = await fs.promises.readFile(CREDENTIALS_PATH, 'utf-8');
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: 'authorized_user',
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  await fs.promises.writeFile(TOKEN_PATH, payload);
}

// Google Drive authorization
async function authorize() {
  let client = await loadSavedCredentialsIfExist();
  if (client) return client;
  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });
  if (client.credentials) await saveCredentials(client);
  return client;
}

// Upload stream to Google Drive with percentage progress callback
async function uploadStreamToDrive(auth, fileName, inputStream, fileSize, onProgress) {
  const drive = google.drive({ version: 'v3', auth });
  const passThrough = new PassThrough();
  let uploadedBytes = 0;

  passThrough.on('data', chunk => {
    uploadedBytes += chunk.length;
    if (onProgress) {
      const percentage = ((uploadedBytes / fileSize) * 100).toFixed(2);
      onProgress(percentage);
    }
  });

  inputStream.pipe(passThrough);

  const res = await drive.files.create({
    requestBody: { name: fileName },
    media: { body: passThrough },
    fields: 'id',
  });

  return res.data.id;
}

// Stream torrent video to Google Drive with progress
async function streamTorrentToDrive(magnetURI, onProgress) {
  const client = new WebTorrent();

  return new Promise((resolve, reject) => {
    client.add(magnetURI, async torrent => {
      console.log('Metadata fetched:', torrent.name);
      const file = torrent.files.find(f =>
        f.name.endsWith('.mp4') || f.name.endsWith('.mkv') || f.name.endsWith('.webm')
      );

      if (!file) {
        client.destroy();
        return reject('No supported video file found in torrent');
      }

      let auth;
      try {
        auth = await authorize();
      } catch (err) {
        client.destroy();
        return reject('Google Drive authorization failed: ' + err);
      }

      console.log('Uploading stream of:', file.name);

      const fileStream = file.createReadStream();
      try {
        const fileId = await uploadStreamToDrive(auth, file.name, fileStream, file.length, onProgress);
        client.destroy();
        resolve(fileId);
      } catch (err) {
        client.destroy();
        reject('Upload failed: ' + err);
      }
    });

    client.on('error', err => {
      reject('Torrent client error: ' + err);
    });
  });
}

// Handle form POST submission and stream percentage updates to UI
app.post('/upload', async (req, res) => {
  const magnetURI = req.body.magnetURI;
  if (!magnetURI) {
    return res.status(400).send('Magnet URL is required');
  }

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Transfer-Encoding': 'chunked',
  });

  res.write(`
    <html><body>
    <h2>Uploading to Google Drive...</h2>
    <div id="progress">Progress: 0%</div>
    <script>
      function updateProgress(percentage) {
        document.getElementById('progress').textContent = "Progress: " + percentage + "%";
      }
    </script>
  `);

  try {
    await streamTorrentToDrive(magnetURI, (percentage) => {
      res.write(`<script>updateProgress(${percentage});</script>\n`);
    });

    res.write('<h3>Upload complete!</h3></body></html>');
    res.end();
  } catch (err) {
    res.write(`<h3 style="color:red;">Error: ${err}</h3></body></html>`);
    res.end();
  }
});

app.listen(port, () => {
  console.log(`App running at http://localhost:${port}`);
});
