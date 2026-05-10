"use strict";

const { createHttpServer } = require("./app");

async function startServer(options = {}) {
  const host = options.host || process.env.THOMAS_HOST || "127.0.0.1";
  const port = Number.parseInt(String(options.port || process.env.THOMAS_PORT || "4567"), 10);
  const server = createHttpServer(options);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    url: `http://${host}:${actualPort}`,
  };
}

module.exports = {
  startServer,
};
