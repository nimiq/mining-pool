const Nimiq = require('@nimiq/core');

NQ25sampleData = {};

NQ25sampleData.address = Nimiq.Address.fromUserFriendlyAddress('NQ25 FGPF A68A TBQ4 7KUU 3TFG 418D 1J49 HRLN');

NQ25sampleData.register = {
    message: 'register',
    address: 'NQ25 FGPF A68A TBQ4 7KUU 3TFG 418D 1J49 HRLN',
    deviceId: 6614501121,
    mode: 'smart',
    genesisHash: Nimiq.BufferUtils.toBase64(Nimiq.GenesisConfig.GENESIS_HASH.serialize())
};
module.exports = exports = NQ25sampleData;
