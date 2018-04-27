const Nimiq = require('@nimiq/core');

NQ43sampleData = {};

NQ43sampleData.address = Nimiq.Address.fromUserFriendlyAddress('NQ43 SXSE XAS0 HYXJ M1U4 DCJ3 0SXE 8KUH 5DU7');

NQ43sampleData.register = {
    message: 'register',
    address: 'NQ43 SXSE XAS0 HYXJ M1U4 DCJ3 0SXE 8KUH 5DU7',
    deviceId: 1513202621,
    mode: 'smart',
    genesisHash: Nimiq.BufferUtils.toBase64(Nimiq.GenesisConfig.GENESIS_HASH.serialize())
};
module.exports = exports = NQ43sampleData;
