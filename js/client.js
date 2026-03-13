// meter aqui el codigo del cliente
let socket = null; //cliente
let adress = "";

function connectToServer(url, name) {
  console.log("[LiveShare] Trying to connect to:", url);
  conectado = false;

  socket = io(url, {
    reconnectionAttempts: 3,
    timeout: 10000,
    auth: {
      username: name,
    },
  });

  socket.on("connect", () => {
    console.log("[LiveShare] ¡Socket connected with ID:", socket.id);
    fachada.INFO("Connected to session!");
    conectado = true;
  });

  socket.on("connect_error", (err) => {
    console.error("[LiveShare] Conexion error:", err);
    fachada.ERR("Conexion error: " + err.message);
    conectado = false;
  });

  app.repository.on("operationExecuted", (operation) => {
    if (socket && socket.connected) {
      // Si nosotros hicimos un cambio, lo enviamos al servidor
      // No enviamos si el cambio vino de la red (bypassConfirmation)
      socket.emit("sync-operation", operation);
    }
  });

  socket.on("remote-operation", (op) => {
    try {
      app.repository.bypassConfirmation = true;
      app.repository.doOperation(op);
    } catch (err) {
      console.error("Error aplying remote operation", err);
    }
  });

  server.address = url;
  return conectado;
}

function sendMousePosition(x, y, diagram) {}

function disconnect() {}

module.exports = {
  connectToServer: connectToServer,
  sendMousePosition: sendMousePosition,
  disconnect: disconnect,
};
