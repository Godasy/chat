const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// 创建Express应用
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 创建HTTP服务器
const server = http.createServer(app);

// 配置Socket.io（允许跨域）
const io = new Server(server, {
  cors: {
    origin: "https://lmx.is-best.net", // 你的前端域名
    methods: ["GET", "POST"],
    credentials: true
  }
});

// 初始化SQLite数据库
const dbPath = path.join(__dirname, 'db', 'wechat.db');
fs.mkdirSync(path.join(__dirname, 'db'), { recursive: true });
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('数据库连接失败:', err);
  else console.log('数据库连接成功');
});

// 创建数据库表（用户、好友、消息、群聊）
db.serialize(() => {
  // 用户表
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    nickname TEXT NOT NULL,
    avatar TEXT DEFAULT '/assets/avatar/default.png',
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 好友关系表
  db.run(`CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    remark TEXT,
    group_name TEXT DEFAULT '默认分组',
    status INTEGER DEFAULT 1, -- 1=已添加 0=待验证
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (friend_id) REFERENCES users(id)
  )`);

  // 消息表
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    type TEXT NOT NULL, -- text/image/emoji
    content TEXT NOT NULL,
    is_group BOOLEAN DEFAULT 0, -- 0=私聊 1=群聊
    status INTEGER DEFAULT 0, -- 0=未读 1=已读
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_id) REFERENCES users(id)
  )`);

  // 群聊表
  db.run(`CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name TEXT NOT NULL,
    avatar TEXT DEFAULT '/assets/avatar/group.png',
    creator_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (creator_id) REFERENCES users(id)
  )`);

  // 群成员表
  db.run(`CREATE TABLE IF NOT EXISTS group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role INTEGER DEFAULT 0, -- 0=普通成员 1=管理员 2=群主
    FOREIGN KEY (group_id) REFERENCES groups(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
});

// 存储在线用户
const onlineUsers = {};

// Socket.io实时通信逻辑
io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  // 用户登录
  socket.on('login', (userId) => {
    onlineUsers[userId] = socket.id;
    socket.userId = userId;
    io.emit('userStatus', { userId, status: 'online' });
    console.log(`用户${userId}上线`);
  });

  // 发送一对一消息
  socket.on('sendPrivateMsg', (data) => {
    const { fromId, toId, type, content } = data;
    // 保存消息到数据库
    db.run(
      `INSERT INTO messages (from_id, to_id, type, content, is_group) VALUES (?, ?, ?, ?, 0)`,
      [fromId, toId, type, content],
      function(err) {
        if (err) console.error('保存消息失败:', err);
        else {
          const msg = {
            id: this.lastID,
            fromId,
            toId,
            type,
            content,
            status: 0,
            createdAt: new Date().toISOString()
          };
          // 发送给接收方
          const receiverSocketId = onlineUsers[toId];
          if (receiverSocketId) {
            io.to(receiverSocketId).emit('receiveMsg', msg);
          }
          // 发送给发送方
          socket.emit('sendMsgSuccess', msg);
        }
      }
    );
  });

  // 发送群聊消息
  socket.on('sendGroupMsg', (data) => {
    const { fromId, groupId, type, content } = data;
    // 保存群消息到数据库
    db.run(
      `INSERT INTO messages (from_id, to_id, type, content, is_group) VALUES (?, ?, ?, ?, 1)`,
      [fromId, groupId, type, content],
      function(err) {
        if (err) console.error('保存群消息失败:', err);
        else {
          const msg = {
            id: this.lastID,
            fromId,
            toId: groupId,
            type,
            content,
            status: 0,
            createdAt: new Date().toISOString()
          };
          // 查询群成员并发送消息
          db.all(`SELECT user_id FROM group_members WHERE group_id = ?`, [groupId], (err, members) => {
            if (err) return console.error('查询群成员失败:', err);
            members.forEach(member => {
              const memberSocketId = onlineUsers[member.user_id];
              if (memberSocketId && member.user_id !== fromId) {
                io.to(memberSocketId).emit('receiveGroupMsg', msg);
              }
            });
            socket.emit('sendMsgSuccess', msg);
          });
        }
      }
    );
  });

  // 标记消息已读
  socket.on('markAsRead', (msgIds) => {
    db.run(`UPDATE messages SET status = 1 WHERE id IN (${msgIds.join(',')})`, (err) => {
      if (err) console.error('标记已读失败:', err);
      else socket.emit('markSuccess', msgIds);
    });
  });

  // 用户断开连接
  socket.on('disconnect', () => {
    if (socket.userId) {
      delete onlineUsers[socket.userId];
      io.emit('userStatus', { userId: socket.userId, status: 'offline' });
      console.log(`用户${socket.userId}下线`);
    }
    console.log('用户断开连接:', socket.id);
  });
});

// 后端API接口（用户、好友、群聊）
// 注册用户
app.post('/api/register', (req, res) => {
  const { username, nickname, password } = req.body;
  db.run(
    `INSERT INTO users (username, nickname, password) VALUES (?, ?, ?)`,
    [username, nickname, password],
    function(err) {
      if (err) return res.status(400).json({ success: false, msg: '注册失败，用户名已存在' });
      res.json({ success: true, userId: this.lastID });
    }
  );
});

// 登录接口
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, user) => {
    if (err || !user) return res.status(400).json({ success: false, msg: '用户名或密码错误' });
    res.json({ success: true, user });
  });
});

// 获取好友列表
app.get('/api/friends/:userId', (req, res) => {
  const userId = req.params.userId;
  db.all(`
    SELECT u.*, f.remark, f.group_name 
    FROM friends f 
    JOIN users u ON f.friend_id = u.id 
    WHERE f.user_id = ? AND f.status = 1
  `, [userId], (err, friends) => {
    if (err) return res.status(500).json({ success: false, msg: '获取好友失败' });
    res.json({ success: true, friends });
  });
});

// 创建群聊
app.post('/api/groups', (req, res) => {
  const { groupName, creatorId, memberIds } = req.body;
  db.run(
    `INSERT INTO groups (group_name, creator_id) VALUES (?, ?)`,
    [groupName, creatorId],
    function(err) {
      if (err) return res.status(400).json({ success: false, msg: '创建群聊失败' });
      const groupId = this.lastID;
      // 添加群成员（包括创建者）
      const members = [...memberIds, creatorId];
      members.forEach((userId, index) => {
        const role = userId === creatorId ? 2 : 0; // 群主
        db.run(
          `INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)`,
          [groupId, userId, role]
        );
      });
      res.json({ success: true, groupId });
    }
  );
});

// 获取聊天记录
app.get('/api/messages/:fromId/:toId/:isGroup', (req, res) => {
  const { fromId, toId, isGroup } = req.params;
  const query = isGroup === '1' 
    ? `SELECT * FROM messages WHERE to_id = ? AND is_group = 1 ORDER BY created_at ASC`
    : `SELECT * FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) ORDER BY created_at ASC`;
  
  const params = isGroup === '1' ? [toId] : [fromId, toId, toId, fromId];
  db.all(query, params, (err, messages) => {
    if (err) return res.status(500).json({ success: false, msg: '获取聊天记录失败' });
    res.json({ success: true, messages });
  });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});