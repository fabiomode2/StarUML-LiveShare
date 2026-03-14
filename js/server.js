const { Server } = require("socket.io");
const http = require("http");
const util = require("./get_ip.js");

let server = null;
const defaultPort = 6789;

class LiveShareServer {
  constructor() {
    this.io = null;
    this.server = null;
    this.address = "";
    this.users = {};
    this.host_id = null;
    this.locks = {}; // { viewId: socketId }
  }

  start(port = 3000) {
    this.server = http.createServer();
    this.io = new Server(this.server, {
      cors: { origin: "*" },
      pingTimeout: 30000,
      pingInterval: 10000,
      maxHttpBufferSize: 1e8,
    });

    this.io.on("connection", (socket) => {
      console.log("User connected:", socket.id);

      const isHost = Object.keys(this.users).length === 0;
      const username = socket.handshake.auth.username || "Anonymous";

      // Asignamos un color aleatorio o predefinido al usuario para el outline
      const userColor = "#" + Math.floor(Math.random() * 16777215).toString(16);

      this.users[socket.id] = {
        id: socket.id,
        name: username,
        isHost: isHost,
        color: userColor,
      };
      if (isHost) this.host_id = socket.id;

      socket.emit("is-host", isHost);
      socket.broadcast.emit("user-joined", { id: socket.id, name: username });

      if (!isHost && this.host_id) {
        this.io
          .to(this.host_id)
          .emit("get-whole-document", { requesterId: socket.id });
      }

      socket.on("host-delivers-document", (data) => {
        this.io.to(data.to).emit("load-whole-document", { json: data.json });
      });

      socket.on("client-mouse-moved", (data) => {
        socket.broadcast.emit("update-mouse-pos", {
          id: socket.id,
          x: data.x,
          y: data.y,
          diagram: data.diagram,
          name: this.users[socket.id].name,
        });
      });

      socket.on("sync-operation", (op) => {
        socket.broadcast.emit("remote-operation", op);
      });

      socket.on("sync-undo", () => {
        socket.broadcast.emit("remote-undo");
      });

      socket.on("sync-redo", () => {
        socket.broadcast.emit("remote-redo");
      });

      // --- SISTEMA DE BLOQUEO ---
      socket.on("lock-element", (viewIds) => {
        viewIds.forEach((id) => {
          if (!this.locks[id]) {
            this.locks[id] = socket.id;
            this.io.emit("element-locked", {
              viewId: id,
              ownerId: socket.id,
              color: this.users[socket.id].color,
            });
          }
        });
      });

      socket.on("unlock-elements", () => {
        for (let id in this.locks) {
          if (this.locks[id] === socket.id) {
            delete this.locks[id];
            this.io.emit("element-unlocked", { viewId: id });
          }
        }
      });

      socket.on("disconnect", () => {
        console.log("user disconnected: " + socket.id);

        // Liberar candados del usuario desconectado
        for (let id in this.locks) {
          if (this.locks[id] === socket.id) {
            delete this.locks[id];
            this.io.emit("element-unlocked", { viewId: id });
          }
        }

        this.io.emit("user-left", socket.id);
        delete this.users[socket.id];
      });
    });

    this.server.listen(port, () => {
      console.log(`Servidor LiveShare running on port ${port}`);
    });
  }

  stop() {
    if (this.server) this.server.close();
  }
}

function startServer(port) {
  if (server) server.stop();
  server = new LiveShareServer();
  const targetPort = port || 3000;

  try {
    server.start(targetPort);
    server.server.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        app.toast.error(`Port ${targetPort} occupied. Close other instances.`);
      }
    });
  } catch (e) {
    return false;
  }
  server.address = `http://${util.get_ip()}:${targetPort}`;
  return true;
}

function stopServer() {
  if (server) server.stop();
}
function getServerAddress() {
  if (server) return server.address;
}
function getServer() {
  return server;
}

module.exports = {
  LiveShareServer,
  startServer,
  stopServer,
  getServerAddress,
  getServer,
  defaultPort,
};
