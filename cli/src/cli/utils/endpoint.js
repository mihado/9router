const api = require("../api/client");

/**
 * Get endpoint URL for the server.
 * @param {number} port - Local server port
 * @returns {Promise<{endpoint: string, tunnelEnabled: boolean}>}
 */
async function getEndpoint(port) {
  const endpoint = `http://localhost:${port}/v1`;
  return { endpoint, tunnelEnabled: false };
}

async function getEndpointColored(port) {
  const { endpoint } = await getEndpoint(port);
  return endpoint;
}

module.exports = { getEndpoint, getEndpointColored };
