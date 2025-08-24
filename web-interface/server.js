const express = require('express');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const { spawn, exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = '/app/VideosDirPath'; // Your existing videos directory
const COOKIES_DIR = '/app/CookiesDir';   // Your existing cookies directory
const LOGS_DIR = '/app/logs';
const AUTOMATION_DIR = '/app'; // Root directory where cli.py is located

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Ensure directories exist
fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(COOKIES_DIR);
fs.ensureDirSync(LOGS_DIR);

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR); // Upload directly to VideosDirPath
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  },
  fileFilter: function (req, file, cb) {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed!'), false);
    }
  }
});

// Global variables
let automationProcess = null;
let isAutomationRunning = false;
let currentUser = null;
let automationLogs = [];

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.emit('status', {
    isRunning: isAutomationRunning,
    hasUser: !!currentUser,
    logs: automationLogs.slice(-50)
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

function broadcast(event, data) {
  io.emit(event, data);
}

function addLog(level, message) {
  const logEntry = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    level: level,
    message: message
  };
  
  automationLogs.push(logEntry);
  if (automationLogs.length > 200) {
    automationLogs = automationLogs.slice(-200);
  }
  
  broadcast('log', logEntry);
  
  const logFile = path.join(LOGS_DIR, `automation-${new Date().toISOString().split('T')[0]}.log`);
  const logLine = `[${logEntry.timestamp}] ${level.toUpperCase()}: ${message}\n`;
  fs.appendFileSync(logFile, logLine);
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get current status
app.get('/api/status', (req, res) => {
  // Check available users (cookie files)
  let users = [];
  try {
    const cookieFiles = fs.readdirSync(COOKIES_DIR);
    users = cookieFiles
      .filter(file => file.startsWith('tiktok_session-'))
      .map(file => file.replace('tiktok_session-', '').replace('.json', ''));
  } catch (error) {
    console.error('Error reading cookie files:', error);
  }

  res.json({
    isRunning: isAutomationRunning,
    currentUser: currentUser,
    availableUsers: users,
    uploadsCount: fs.readdirSync(UPLOADS_DIR).filter(f => f.endsWith('.mp4')).length,
    logs: automationLogs.slice(-10)
  });
});

// Upload video files
app.post('/api/upload', upload.array('videos', 10), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const uploadedFiles = req.files.map(file => ({
      filename: file.filename,
      originalname: file.originalname,
      size: file.size,
      path: file.path
    }));

    addLog('info', `Uploaded ${uploadedFiles.length} video(s): ${uploadedFiles.map(f => f.originalname).join(', ')}`);

    res.json({
      success: true,
      files: uploadedFiles,
      message: `Successfully uploaded ${uploadedFiles.length} video(s) to VideosDirPath`
    });

  } catch (error) {
    console.error('Upload error:', error);
    addLog('error', `Upload failed: ${error.message}`);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Login user (create TikTok session)
app.post('/api/login', (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    // Run your login command: python3 cli.py login -n username
    const loginProcess = spawn('python3', ['cli.py', 'login', '-n', username], {
      cwd: AUTOMATION_DIR,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    let errorOutput = '';

    loginProcess.stdout.on('data', (data) => {
      output += data.toString();
      addLog('info', `Login: ${data.toString().trim()}`);
    });

    loginProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
      addLog('error', `Login Error: ${data.toString().trim()}`);
    });

    loginProcess.on('close', (code) => {
      if (code === 0) {
        currentUser = username;
        addLog('info', `Successfully logged in user: ${username}`);
        broadcast('userLoggedIn', { username });
        res.json({ success: true, message: `User ${username} logged in successfully` });
      } else {
        addLog('error', `Login failed for user: ${username}`);
        res.status(500).json({ error: 'Login failed', details: errorOutput });
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to initiate login' });
  }
});

// Upload video to TikTok
app.post('/api/tiktok-upload', (req, res) => {
  try {
    const { videoPath, title, username } = req.body;
    
    if (!videoPath || !title || !username) {
      return res.status(400).json({ error: 'Video path, title, and username are required' });
    }

    // Run your upload command: python3 cli.py upload -u username -v "video.mp4" -t "title"
    const uploadProcess = spawn('python3', ['cli.py', 'upload', '-u', username, '-v', videoPath, '-t', title], {
      cwd: AUTOMATION_DIR,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    uploadProcess.stdout.on('data', (data) => {
      addLog('info', `Upload: ${data.toString().trim()}`);
    });

    uploadProcess.stderr.on('data', (data) => {
      addLog('error', `Upload Error: ${data.toString().trim()}`);
    });

    uploadProcess.on('close', (code) => {
      if (code === 0) {
        addLog('info', `Successfully uploaded video: ${videoPath}`);
        broadcast('videoUploaded', { videoPath, title });
      } else {
        addLog('error', `Failed to upload video: ${videoPath}`);
      }
    });

    res.json({ success: true, message: 'Upload started' });

  } catch (error) {
    console.error('TikTok upload error:', error);
    res.status(500).json({ error: 'Failed to start upload' });
  }
});

// Get list of uploaded files
app.get('/api/uploads', (req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR)
      .filter(filename => filename.endsWith('.mp4'))
      .map(filename => {
        const filePath = path.join(UPLOADS_DIR, filename);
        const stats = fs.statSync(filePath);
        return {
          filename: filename,
          size: stats.size,
          uploadDate: stats.birthtime,
          path: filePath
        };
      });

    res.json({ files });
  } catch (error) {
    console.error('Error listing uploads:', error);
    res.status(500).json({ error: 'Failed to list uploads' });
  }
});

// Show available videos (existing cli.py show -v functionality)
app.get('/api/show-videos', (req, res) => {
  exec('python3 cli.py show -v', { cwd: AUTOMATION_DIR }, (error, stdout, stderr) => {
    if (error) {
      console.error('Show videos error:', error);
      return res.status(500).json({ error: 'Failed to show videos' });
    }
    
    res.json({ 
      success: true, 
      output: stdout,
      videos: stdout.split('\n').filter(line => line.trim())
    });
  });
});

// Show available cookies (existing cli.py show -u functionality)
app.get('/api/show-cookies', (req, res) => {
  exec('python3 cli.py show -u', { cwd: AUTOMATION_DIR }, (error, stdout, stderr) => {
    if (error) {
      console.error('Show cookies error:', error);
      return res.status(500).json({ error: 'Failed to show cookies' });
    }
    
    res.json({ 
      success: true, 
      output: stdout,
      cookies: stdout.split('\n').filter(line => line.trim())
    });
  });
});

// Delete uploaded file
app.delete('/api/uploads/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(UPLOADS_DIR, filename);
    
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      addLog('info', `Deleted file: ${filename}`);
      res.json({ success: true, message: 'File deleted' });
    } else {
      res.status(404).json({ error: 'File not found' });
    }
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Get logs
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    logs: automationLogs.slice(-limit)
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large (max 100MB)' });
    }
  }
  res.status(500).json({ error: error.message });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  addLog('info', `Web interface started on port ${PORT}`);
});