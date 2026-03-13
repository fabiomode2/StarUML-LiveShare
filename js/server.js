const { Server } = require("socket.io");
const http = require("http");
const util = require("./get_ip.js");

// socket.emit() solo al emisor
// socket.broadcast.emit(), a todos menos a mi mismo
// this.io.emit() a todos

let server = null; //server
const defaultPort = 6789;
const fachada = require("./fachada.js");

class LiveShareServer {
  constructor() {
    this.io = null;
    this.server = null;
    this.address = "";
    this.users = {};
  }

  start(port = 3000) {
    this.server = http.createServer();
    this.io = new Server(this.server, {
      cors: { origin: "*" },
    });

    //user connected
    this.io.on("connection", (socket) => {
      console.log("User connected:", socket.id);

      const username = socket.handshake.auth.username || "Anonymous";
      this.users[socket.id] = { id: socket.id, name: username, color: "blue" };

      // diagram changes
      socket.on("sync-operation", (op) => {
        // broadcast.emit lo envía a todos MENOS al que lo mandó
        socket.broadcast.emit("remote-operation", op);
      });

      // mouse movement
      socket.on("client-mouse-moved", (data) => {
        socket.broadcast.emit("update-mouse-pos", {
          id: socket.id,
          x: data.x,
          y: data.y,
          diagram: data.diagram,
        });
      });

      // user disconnected
      socket.on("disconnect", () => {
        console.log("user disconnected: " + socket.id);
        this.io.emit("user-left", socket.id);
        delete this.users[socket.id];
      });
    });

    this.server.listen(port, () => {
      console.log(`Servidor LiveShare running on port ${port}`);
    });
  }

  // stop the server
  stop() {
    if (this.server) this.server.close();
  }
}

function startServer(port) {
  server = new LiveShareServer();
  const targetPort = port || 3000;
  console.log(`[LiveShare] Trying to start server on port ${targetPort}`);

  try {
    server.start(targetPort);
  } catch (e) {
    console.error("[LiveShare] Error starting server:", e);
    return false;
  }

  server.address = `http://${util.get_ip()}:${targetPort}`;
  console.log("Started server on " + server.address);
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
  LiveShareServer: LiveShareServer,
  startServer: startServer,
  stopServer: stopServer,
  getServerAddress: getServerAddress,
  getServer: getServer,
  defaultPort: defaultPort,
};
