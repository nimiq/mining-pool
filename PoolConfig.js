const Nimiq = require('../core/dist/node.js');

module.exports = {
    TARGET: Nimiq.Policy.BLOCK_TARGET_MAX,
    CONFIRMATIONS: 10,
    AUTO_PAY_OUT_LIMIT: Nimiq.Policy.coinsToSatoshis(50),
    POOL_FEE: 0.01,
    NETWORK_FEE: 0, // satoshi per byte
    START_DIFFICULTY: 1,
    SPS_TIME_UNIT: 60000,
    DESIRED_SPS: 1/5
};
