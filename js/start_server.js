const server = require("./server.js");

server.startServer(process.env.PORT || server.defaultPort);
