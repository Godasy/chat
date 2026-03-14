require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');

// 初始化 Express
const app = express();
app.use(cors());
app.use(express.json());

// 连接 Render PostgreSQL（免费）
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render 必需
});

// 创建 HTTP 服务器 & Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*", // 前端地址
    methods: ["GET", "POST"]
  }
});

// 存储在线用户（免费版无持久化，重启后丢失，生产可存数据库）
const onlineUsers = {};

// Socket.IO 核心逻辑
io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  // 1. 用户登录（绑定 userId + socketId）
  socket.on('login', (userId) => {
    onlineUsers[userId] = socket.id;
    socket.userId = userId;
    // 通知好友上线
    socket.broadcast.emit('user-online', userId);
  });

  // 2. 一对一聊天
  socket.on('private-message', (data) => {
    const { toUserId, message, type = 'text', time } = data;
    const fromUserId = socket.userId;
    
    // 保存消息到数据库
    pool.query(
      `INSERT INTO messages (from_user, to_user, content, type, is_read, create_time) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [fromUserId, toUserId, message, type, false, time || new Date()]
    );

    // 实时发送给对方
    const receiverSocketId = onlineUsers[toUserId];
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('new-message', {
        from: fromUserId,
        content: message,
        type,
        time,
        isRead: false
      });
    }
  });

  // 3. 群聊
  socket.on('group-message', (data) => {
    const { groupId, message, type = 'text', time } = data;
    const fromUserId = socket.userId;
    
    // 保存群消息
    pool.query(
      `INSERT INTO group_messages (group_id, from_user, content, type, create_time) 
       VALUES ($1, $2, $3, $4, $5)`,
      [groupId, fromUserId, message, type, time || new Date()]
    );

    // 广播给群内所有在线用户
    socket.to(groupId).emit('new-group-message', {
      groupId,
      from: fromUserId,
      content: message,
      type,
      time
    });
  });

  // 4. 加入群聊房间
  socket.on('join-group', (groupId) => {
    socket.join(groupId);
  });

  // 5. 标记消息已读
  socket.on('mark-read', (data) => {
    const { fromUserId, messageIds } = data;
    pool.query(
      `UPDATE messages SET is_read = true WHERE id = ANY($1) AND to_user = $2`,
      [messageIds, socket.userId]
    );
    // 通知发送方已读
    const senderSocketId = onlineUsers[fromUserId];
    if (senderSocketId) {
      io.to(senderSocketId).emit('message-read', { messageIds });
    }
  });

  // 6. 断开连接
  socket.on('disconnect', () => {
    if (socket.userId) {
      delete onlineUsers[socket.userId];
      socket.broadcast.emit('user-offline', socket.userId);
    }
    console.log('用户断开:', socket.id);
  });
});

// 基础 API：获取好友列表
app.get('/api/friends/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT u.id, u.nickname, u.avatar, f.remark 
       FROM friends f 
       JOIN users u ON f.friend_id = u.id 
       WHERE f.user_id = $1`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 启动服务器
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`后端服务运行在端口 ${PORT}`);
});