const io = require("socket.io-client");
const mm_view = require("./mouses_view.js");
const mm_net = require("./mouses_net.js");
let socket = null; //cliente
let address = "";
const CONNECT_TIMEOUT = 500;

function connectToServer(url, name) {
  conectado = false;
  try {
    setTimeout(() => {
      console.log("[LiveShare] Trying to connect to:", url);

      socket = io(url, {
        reconnectionAttempts: 3,
        timeout: 10000,
        auth: {
          username: name,
        },
      });

      // connection
      socket.on("connect", () => {
        console.log("[LiveShare] ¡Socket connected with ID:", socket.id);
        //fachad`a.INFO("Connected to session!");
        conectado = true;
      });

      //connection error
      socket.on("connect_error", (err) => {
        console.error("[LiveShare] Conexion error:", err);
        fachada.ERR("Conexion error: " + err.message);
        conectado = false;
      });

      // render other clients mouses
      socket.on("update-mouse-pos", (data) => {
        if (data.id == socket.id) return;
        mm_view.updateMousePosition(data);
      });
      mm_net.addMouseMovementSharing(sendMousePosition);

      // diagram changes
      // app.repository.on("operationExecuted", (operation) => {
      //   if (socket && socket.connected) {
      //     socket.emit("sync-operation", operation);
      //   }
      // });

      // socket.on("remote-operation", (op) => {
      //   try {
      //     app.repository.bypassConfirmation = true;
      //     app.repository.doOperation(op);
      //   } catch (err) {
      //     console.error("Error aplying remote operation", err);
      //   }
      // });

      address = url;
    }, CONNECT_TIMEOUT);
  } catch (e) {
    console.log(e);
    return false;
  }
  return conectado;
}

//data: {x:_, y:_, diagram:_}
function sendMousePosition({ x, y, diagram }) {
  if (!(socket && socket.connected)) return;
  data = {
    id: socket.id,
    x: x,
    y: y,
    diagram: diagram,
  };
  socket.emit("client-mouse-moved", data);
  console.log("Mouse pos sent:", data);
}

function getConnectedAddress() {
  return address;
}

function disconnect() {}

module.exports = {
  connectToServer: connectToServer,
  sendMousePosition: sendMousePosition,
  disconnect: disconnect,
  getConnectedAddress: getConnectedAddress,
  sendMousePosition: sendMousePosition,
};
