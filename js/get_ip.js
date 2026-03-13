"use strict";

const { networkInterfaces } = require("os");

function get_ipv4() {
  const nets = networkInterfaces();

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.internal) continue;

      const isIPv4 = net.family === "IPv4" || net.family === 4;

      if (isIPv4) {
        return net.address;
      }
    }
  }
  return "127.0.0.1"; // fallback
}

module.exports = {
  get_ip: get_ipv4,
};
